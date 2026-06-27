import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import {
  type AgentMessagePart,
  AgentRequestError,
  type AgentStorage,
  AgentStorageError,
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
  type Storage,
} from "@sixb/core"
import { jsonSchema, type ToolSet, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import { AgentWorker, type AgentWorkerStorage } from "../src"
import { AgentFinalizationError, AgentLeaseLostError } from "../src/errors"
import { finishRunOrThrow } from "../src/finalize"
import { runAgentTurn } from "../src/run-agent-turn"
import { waitFor } from "./helpers"

const PROJECT_ID = "agent-worker-tests"
const REQUESTER = { type: "user", id: "usr_requester" } as const

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
}

function stream(chunks: LanguageModelV3StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
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

function workerStorageOf(storage: Storage): AgentWorkerStorage {
  if (!storage.agents) {
    throw new Error("expected agent storage")
  }
  return storage as AgentWorkerStorage
}

async function listMessages(storage: AgentStorage, threadId: string) {
  const result = await storage.messages.list({ projectId: PROJECT_ID, threadId, order: "asc" })
  return result.messages
}

/**
 * Wrap root storage so agent `runs.finish` fails with a non-terminal (infra) error its first
 * `failTimes` calls, including when the worker finalizes through `storage.transaction(...)`.
 */
function withFlakyAgentFinishStorage(storage: Storage, failTimes: number): Storage {
  const agents = storage.agents
  if (!agents) {
    throw new Error("expected agent storage")
  }
  let fails = 0
  const wrapAgents = (agents: AgentStorage): AgentStorage => ({
    threads: agents.threads,
    messages: agents.messages,
    runs: {
      reserve: (input) => agents.runs.reserve(input),
      renewLease: (input) => agents.runs.renewLease(input),
      reclaim: (input) => agents.runs.reclaim(input),
      getById: (params) => agents.runs.getById(params),
      list: (input) => agents.runs.list(input),
      finish: (input) => {
        if (fails < failTimes) {
          fails += 1
          return Promise.reject(new Error("storage blip"))
        }
        return agents.runs.finish(input)
      },
    },
  })
  return {
    ...storage,
    agents: wrapAgents(agents),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const agents = tx.agents
        return run({
          ...tx,
          ...(agents ? { agents: wrapAgents(agents) } : {}),
        })
      }, options),
  }
}

function withAlwaysFailingTransactionalFinish(storage: Storage): Storage {
  const agents = storage.agents
  if (!agents) {
    throw new Error("expected agent storage")
  }
  const wrapAgents = (agents: AgentStorage): AgentStorage => ({
    threads: agents.threads,
    messages: agents.messages,
    runs: {
      reserve: (input) => agents.runs.reserve(input),
      renewLease: (input) => agents.runs.renewLease(input),
      reclaim: (input) => agents.runs.reclaim(input),
      getById: (params) => agents.runs.getById(params),
      list: (input) => agents.runs.list(input),
      finish: () => Promise.reject(new Error("storage down after message generation")),
    },
  })
  return {
    ...storage,
    agents: wrapAgents(agents),
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const agents = tx.agents
        return run({
          ...tx,
          ...(agents ? { agents: wrapAgents(agents) } : {}),
        })
      }, options),
  }
}

/** A model whose stream opens then hangs until aborted — used to force a turn timeout. */
function hangingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async (options) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          const abort = () => controller.error(new DOMException("Aborted", "AbortError"))
          if (options.abortSignal?.aborted) {
            abort()
          } else {
            options.abortSignal?.addEventListener("abort", abort, { once: true })
          }
        },
      }),
    }),
  })
}

describe("AgentWorker", () => {
  test("trigger persists the user message and enqueues an intent without creating a run", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    const result = await sixb.agents.request({
      agentId: "assistant",
      text: "hello",
      principal: REQUESTER,
    })

    expect(result.createdThread).toBe(true)
    expect(result.jobId).toBeDefined()
    expect(result.runId.startsWith("agt_run_")).toBe(true)

    const messages = await listMessages(storage, result.threadId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: "user", runId: null })
    expect(messages[0]?.authorPrincipal).toEqual(REQUESTER)
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
    const streamed: AgentMessagePart[] = []

    const worker = new AgentWorker(sixb, {
      tools: echoTool,
      streamSink: { onPart: (part) => void streamed.push(part) },
    })
    await worker.start()
    try {
      const { threadId, runId } = await sixb.agents.request({
        agentId: "assistant",
        text: "echo hi",
      })

      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run terminal" }
      )

      expect(run.status).toBe("succeeded")
      expect(run.id).toBe(runId)
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
      id: first.runId,
      projectId: PROJECT_ID,
      threadId: first.threadId,
      agentId: "assistant",
      triggerMessageId: first.triggerMessageId,
      requestedByPrincipal: REQUESTER,
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
    const { threadId, runId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })
    const crashedRunId = runId
    await storage.runs.reserve({
      id: crashedRunId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      requestedByPrincipal: REQUESTER,
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

    const { threadId, runId, triggerMessageId } = await sixb.agents.request({
      agentId: "assistant",
      text: "echo hi",
    })

    // This worker reserved the run, but its lease already expired and another worker reclaimed it.
    const staleRun = await storage.runs.reserve({
      id: runId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId,
      requestedByPrincipal: REQUESTER,
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
        storage: workerStorageOf(sixb.storage),
        tools: echoTool,
        streamSink: { onPart() {} },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
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

  test("absorbs a transient finalize blip in place: one run, one message, no lock", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    // The worker sees a storage whose `finish` fails twice before succeeding; the trigger keeps using
    // the real storage (both delegate to the same underlying state).
    const workerSixb = {
      id: sixb.id,
      events: sixb.events,
      storage: withFlakyAgentFinishStorage(sixb.storage, 2),
      queues: sixb.queues,
      agents: sixb.agents,
    }

    const worker = new AgentWorker(workerSixb, { tools: echoTool })
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run finalized after blip" }
      )

      // The in-place retry recovered: the run succeeded on this delivery, with exactly one assistant
      // message (no redelivery, so no duplicate turn), and the thread is released (no silent lock).
      expect(run.status).toBe("succeeded")
      expect(run.attempt).toBe(1)
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
      const assistants = (await listMessages(storage, threadId)).filter(
        (m) => m.role === "assistant"
      )
      expect(assistants).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  test("rolls back the assistant message when finalization fails before redelivery", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)
    const request = await sixb.agents.request({ agentId: "assistant", text: "echo hi" })
    const run = await storage.runs.reserve({
      id: request.runId,
      projectId: PROJECT_ID,
      threadId: request.threadId,
      agentId: "assistant",
      triggerMessageId: request.triggerMessageId,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
    })

    const failingStorage = withAlwaysFailingTransactionalFinish(sixb.storage)
    await expect(
      runAgentTurn({
        context: {
          id: PROJECT_ID,
          storage: workerStorageOf(failingStorage),
          tools: echoTool,
          streamSink: { onPart() {} },
          leaseMs: 60_000,
          heartbeatMs: 20_000,
          defaultMaxSteps: 4,
          turnTimeoutMs: 60_000,
        },
        agent: sixb.agents.getById("assistant")!,
        run,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(AgentFinalizationError)

    const afterFailure = await storage.runs.getById({ projectId: PROJECT_ID, id: request.runId })
    expect(afterFailure?.status).toBe("running")
    expect(
      (await listMessages(storage, request.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(0)

    const reclaimed = await storage.runs.reclaim({
      projectId: PROJECT_ID,
      id: request.runId,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) },
      now: new Date(Date.now() + 120_000),
    })
    await runAgentTurn({
      context: {
        id: PROJECT_ID,
        storage: workerStorageOf(sixb.storage),
        tools: echoTool,
        streamSink: { onPart() {} },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        defaultMaxSteps: 4,
        turnTimeoutMs: 60_000,
      },
      agent: sixb.agents.getById("assistant")!,
      run: reclaimed,
      signal: new AbortController().signal,
    })

    const finalRun = await storage.runs.getById({ projectId: PROJECT_ID, id: request.runId })
    expect(finalRun?.status).toBe("succeeded")
    expect(finalRun?.attempt).toBe(2)
    expect(
      (await listMessages(storage, request.threadId)).filter((m) => m.role === "assistant")
    ).toHaveLength(1)
  })

  test("fails the run and releases the thread when a turn exceeds its wall-clock budget", async () => {
    const sixb = buildSixb(hangingModel())
    const storage = agentStorageOf(sixb)

    const worker = new AgentWorker(sixb, { turnTimeoutMs: 50 })
    await worker.start()
    try {
      const { threadId } = await sixb.agents.request({ agentId: "assistant", text: "hang" })
      const run = await waitFor(
        async () => {
          const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
          const found = list.runs[0]
          return found && found.status !== "running" ? found : null
        },
        { label: "run timed out" }
      )

      expect(run.status).toBe("failed")
      expect(run.error).toContain("turn budget")
      // Thread released so a later message can run, and no assistant message was persisted.
      const thread = await storage.threads.getById({ projectId: PROJECT_ID, id: threadId })
      expect(thread?.activeRunId).toBeNull()
      const messages = await listMessages(storage, threadId)
      expect(messages.every((m) => m.role !== "assistant")).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  test("holds a different turn behind a live active run without stealing it (single-flight, worker layer)", async () => {
    const sixb = buildSixb(toolThenAnswerModel())
    const storage = agentStorageOf(sixb)

    // A live run (valid, far-future lease) owns the thread, triggered by message "A".
    const {
      threadId,
      runId: activeRunId,
      triggerMessageId: triggerA,
    } = await sixb.agents.request({
      agentId: "assistant",
      text: "first",
    })
    const [queuedA] = await sixb.queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "test-drain",
      limit: 1,
      leaseMs: 60_000,
    })
    if (!queuedA) {
      throw new Error("expected queued first turn")
    }
    await sixb.queues.agents.complete({
      projectId: PROJECT_ID,
      jobId: queuedA.job.id,
      leaseId: queuedA.leaseId,
    })

    await storage.runs.reserve({
      id: activeRunId,
      projectId: PROJECT_ID,
      threadId,
      agentId: "assistant",
      triggerMessageId: triggerA,
      requestedByPrincipal: REQUESTER,
      lease: { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 300_000) },
    })

    // A redelivered job for a *different* trigger lands while that run is live. The worker must hold
    // it (single-flight), never reclaiming the still-leased run.
    await sixb.queues.agents.enqueue({
      projectId: PROJECT_ID,
      jobs: [
        {
          type: "agent.run.requested",
          payload: {
            agentId: "assistant",
            threadId,
            runId: createAgentRunId(),
            triggerMessageId: "trigger-B",
          },
        },
      ],
    })

    const worker = new AgentWorker(sixb, { tools: echoTool })
    await worker.start()
    try {
      // Let the worker claim + hold the job (held jobs are rescheduled a full lease out, so B will
      // not run again inside the test window). The active run must be untouched: not reclaimed, no
      // second run created, and no assistant message written.
      await Bun.sleep(150)

      const list = await storage.runs.list({ projectId: PROJECT_ID, threadId })
      expect(list.runs).toHaveLength(1)
      expect(list.runs[0]?.id).toBe(activeRunId)
      expect(list.runs[0]?.status).toBe("running")
      expect(list.runs[0]?.attempt).toBe(1)
      const assistants = (await listMessages(storage, threadId)).filter(
        (m) => m.role === "assistant"
      )
      expect(assistants).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })
})

describe("finishRunOrThrow", () => {
  function finishingStorage(finish: AgentStorage["runs"]["finish"]): AgentStorage {
    return { runs: { finish } } as unknown as AgentStorage
  }

  const succeededInput = {
    projectId: PROJECT_ID,
    id: "agt_run_x",
    leaseId: "agt_lease_x",
    status: "succeeded",
  } as const

  test("raises AgentFinalizationError when an infra error persists across retries", async () => {
    const storage = finishingStorage(() => Promise.reject(new Error("db down")))
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentFinalizationError
    )
  })

  test("raises AgentLeaseLostError when the run is no longer ours (terminal storage error)", async () => {
    const storage = finishingStorage(() =>
      Promise.reject(new AgentStorageError("lease_lost", "gone"))
    )
    await expect(finishRunOrThrow(storage, succeededInput)).rejects.toBeInstanceOf(
      AgentLeaseLostError
    )
  })
})
