import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import {
  AgentRequestError,
  type AgentStorage,
  type AgentsRuntime,
  createAgentRunId,
  createAgentRunLeaseId,
  defineAgent,
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Queues,
  Sixb,
  type SixbMessagePart,
  type Storage,
} from "@sixb/core"
import { jsonSchema, type ToolSet, tool } from "ai"
import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import { AgentLeaseLostError } from "../src/errors"
import { runAgentTurn } from "../src/run-agent-turn"
import { AgentWorker } from "../src/worker"
import { waitFor } from "./helpers"

const PROJECT_ID = "agent-worker-tests"

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}

function stream(chunks: LanguageModelV3StreamPart[]) {
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
}

function finish(unified: "stop" | "tool-calls"): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE }
}

/**
 * A model that, on its first call, calls the `echo` tool, then on its second call answers with
 * reasoning + text. A stateful `doStream` (not the array form) guarantees per-call ordering.
 */
function toolThenAnswerModel(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => {
      call += 1
      if (call === 1) {
        return stream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "echo",
            input: JSON.stringify({ value: "hi" }),
          },
          finish("tool-calls"),
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "echo it back" },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Echoed hi" },
        { type: "text-end", id: "t" },
        finish("stop"),
      ])
    },
  })
}

const echoTool: ToolSet = {
  echo: tool({
    description: "Echo a value back.",
    inputSchema: jsonSchema<{ value: string }>({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    }),
    async execute(input) {
      return { echoed: input.value }
    },
  }),
}

// Sixb's generics overflow TS2589 when instantiated with an empty ontology in a test; we only need a
// structural `AgentWorkerSixb`, so we construct through a narrowed constructor cast (as the
// action-worker tests do).
interface TestSixb {
  readonly id: string
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  readonly agents: AgentsRuntime
}

const SixbCtor = Sixb as unknown as new (options: Record<string, unknown>) => TestSixb

function buildSixb(model: LanguageModelV3): TestSixb {
  const agent = defineAgent("assistant", {
    name: "Assistant",
    model,
    instructions: "You are a helpful test assistant.",
    loop: { stopWhen: { maxSteps: 4 } },
  })
  return new SixbCtor({
    id: PROJECT_ID,
    ontology: [],
    agents: [agent],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

function agentStorageOf(sixb: TestSixb): AgentStorage {
  const storage = sixb.storage.agents
  if (!storage) {
    throw new Error("expected agent storage")
  }
  return storage
}

async function listMessages(storage: AgentStorage, threadId: string) {
  const result = await storage.messages.list({ projectId: PROJECT_ID, threadId, order: "asc" })
  return result.messages
}

describe("AgentWorker", () => {
  test("trigger persists the user message and enqueues an intent without creating a run", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const result = await sixb.agents.request({ agentId: "assistant", text: "hello" })

    expect(result.createdThread).toBe(true)
    expect(result.jobId).toBeDefined()

    const messages = await listMessages(storage, result.threadId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "user", runId: null })
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "hello" }])

    // Reserve-at-claim: no run record exists yet, and the thread is still idle.
    const runs = await storage.runs.list({ projectId: PROJECT_ID, threadId: result.threadId })
    expect(runs.runs).toHaveLength(0)
    const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: result.threadId })
    expect(thread?.activeRunId).toBeNull()
  })

  test("runs a full multi-step turn: reserves, persists the assistant message, finalizes with usage", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const streamed: SixbMessagePart[] = []

    const worker = new AgentWorker(sixb, {
      tools: echoTool,
      streamSink: { onPart: (part) => void streamed.push(part) },
    })
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(run.attempt).toBe(1)
      expect(run.finishReason).toBe("stop")
      expect(run.modelId).toBe("mock-model")
      expect(run.usage?.outputTokens).toBeGreaterThan(0)
      expect(run.usage?.inputTokens).toBeGreaterThan(0)

      // Thread released after finalization (single-flight pointer cleared).
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()

      const messages = await listMessages(storage, threadId)
      const assistant = messages.find((message) => message.role === "assistant")
      expect(assistant).toBeDefined()
      expect(assistant?.runId).toBe(run.id)

      const parts = assistant?.parts ?? []
      expect(parts.some((part) => part.type === "reasoning")).toBe(true)
      expect(parts.some((part) => part.type === "step-start")).toBe(true)
      expect(
        parts.some(
          (part) =>
            part.type === "tool-call" &&
            part.toolName === "echo" &&
            part.state === "output-available"
        )
      ).toBe(true)
      expect(parts.some((part) => part.type === "text" && part.text.includes("Echoed hi"))).toBe(
        true
      )

      // The stream seam saw exactly the persisted parts, in order.
      expect(streamed).toEqual([...parts])
    } finally {
      await worker.stop()
    }
  })

  test("rejects a second message while a run is active (single-flight, trigger layer)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Open a thread and simulate an in-flight run by reserving directly.
    const first = await sixb.agents.request({ agentId: "assistant", text: "first" })
    await storage.runs.reserve({
      id: createAgentRunId(),
      projectId: PROJECT_ID,
      threadId: first.threadId,
      agentId: "assistant",
      triggerMessageId: first.triggerMessageId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const promise = sixb.agents.request({
      agentId: "assistant",
      text: "second",
      threadId: first.threadId,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentRequestError)
    await expect(promise).rejects.toMatchObject({ code: "active_run_exists" })
  })

  test("reclaims a crashed run on redelivery and completes it (attempt++)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // Trigger normally, then simulate a worker that crashed mid-run: an active run whose lease has
    // already expired, with the same trigger message the redelivered job carries.
    const { threadId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })
    const crashedRunId = createAgentRunId()
    await storage.runs.reserve({
      id: crashedRunId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() - 1_000) },
    })

    const worker = new AgentWorker(sixb, { tools: echoTool })
    await worker.start()
    try {
      const reclaimed = await waitFor(
        async () => {
          const run = await storage.runs.getById({ projectId: PROJECT_ID, id: crashedRunId })
          return run && run.status !== "running" ? run : null
        },
        { label: "crashed run reclaimed + finished" }
      )
      expect(reclaimed.status).toBe("succeeded")
      expect(reclaimed.attempt).toBe(2)
    } finally {
      await worker.stop()
    }
  })

  test("a worker whose lease was reclaimed writes nothing (fencing)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const { threadId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })

    // This worker reserved the run, but its lease already expired and another worker reclaimed it.
    const runId = createAgentRunId()
    const staleRun = await storage.runs.reserve({
      id: runId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() - 1_000) },
    })
    await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: runId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const promise = runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage,
        tools: echoTool,
        streamSink: { onPart() {} },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
      },
      agent: sixb.agents.getById("assistant")!,
      run: staleRun,
      signal: new AbortController().signal,
    })
    await expect(promise).rejects.toBeInstanceOf(AgentLeaseLostError)

    // No assistant message was written; the run is still owned by the reclaiming worker.
    const messages = await listMessages(storage, threadId)
    expect(messages.every((message) => message.role !== "assistant")).toBe(true)
    const run = await storage.runs.getById({ projectId: PROJECT_ID, id: runId })
    expect(run?.status).toBe("running")
  })

  test("records a run-level failure on the record (model error)", async () => {
    const failingModel = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.error(new Error("provider boom"))
          },
        }),
      }),
    })
    const sixb = buildSixb(failingModel)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb)
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run failed" }
      )
      expect(run.status).toBe("failed")
      expect(run.error).toBeDefined()

      // Thread released so a later message can run.
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })

  test("cancels the run when the worker is stopped mid-turn", async () => {
    // A model whose stream blocks until the call is aborted, so the turn is reliably in-flight.
    const blockingModel = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: async (options) => {
        const blocked = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
            if (options.abortSignal?.aborted) {
              abort()
            } else {
              options.abortSignal?.addEventListener("abort", abort, { once: true })
            }
          },
        })
        return { stream: blocked }
      },
    })
    const sixb = buildSixb(blockingModel)
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb)
    await worker.start()
    const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "hang" })

    // Wait until the run is reserved and in-flight, then stop the worker.
    await waitFor(
      async () => {
        const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
        return list.runs[0]?.status === "running" ? list.runs[0] : null
      },
      { label: "run running" }
    )
    await worker.stop()

    const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
    expect(list.runs[0]?.status).toBe("cancelled")
    const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
    expect(thread?.activeRunId).toBeNull()
  })
})
