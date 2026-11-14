import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryStorage,
  type SecurityDefinitionCatalog,
} from "@sixb/core"
import {
  type AgentRunPlanDefinitions,
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  claimAgentRunForRunner,
  createHttpAgentRunSession,
  NOOP_STREAM_SINK,
  readAgentTurnHistory,
  requestAgentRunCancel,
  serveAgentRunSession,
} from "@sixb/core/internal/agents"
import {
  createModelCatalog,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  type ModelTool,
} from "@sixb/core/models"
import type { ConversationAgentRunRecord, Principal } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { conversationModelMessages } from "../src/conversation-messages"
import { runAgentTurn } from "../src/run-agent-turn"
import { agentThreadModelContext } from "../src/thread-context"
import { WorkerTestModel } from "./worker-model-fixture"

const projectId = "turn-steering"
const threadId = "thr_1"
const ava: Principal = { type: "user", id: "usr_ava" }
const LEASE = () => new Date(Date.now() + 60_000).toISOString()

function createFixture(model: WorkerTestModel) {
  const storage = new InMemoryStorage()
  const broker = new InMemoryBroker()
  const host: AgentRunSessionHost = {
    projectId,
    storage: storage as AgentRunSessionHost["storage"],
    broker,
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    security: { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog,
    domainEvents: { emit: async () => {} },
    sdk: {
      id: projectId,
      withScope: () => {
        throw new Error("Direct turn test reaches no project SDK.")
      },
    },
    definitions: {
      models: createModelCatalog({ language: [model] }),
    } as unknown as AgentRunPlanDefinitions,
  }
  return { storage, broker, host }
}

async function seedTurn(storage: InMemoryStorage, runId: string) {
  const existing = await storage.agents.threads.getById({ projectId, id: threadId })
  if (!existing) {
    await storage.agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: ava,
      createdAt: new Date("2026-11-14T16:00:00.000Z"),
    })
  }
  const trigId = `msg_trig_${runId}`
  await storage.agents.messages.append({
    id: trigId,
    projectId,
    threadId,
    runId: null,
    role: "user",
    authorPrincipal: ava,
    parts: [{ type: "text", text: "Check the build." }],
    createdAt: new Date("2026-11-14T16:01:00.000Z"),
  })
  const executionId = await createTestAgentExecution(storage, { projectId, runId })
  const run = await storage.agents.runs.create({
    id: runId,
    projectId,
    executionId,
    threadId,
    triggerMessageId: trigId,
    spec: {
      model: { provider: "mock", modelId: "mock-model" },
      timeZone: "America/New_York",
      locale: "en-US",
    },
    createdAt: new Date("2026-11-14T16:01:00.000Z"),
  })
  return run as ConversationAgentRunRecord
}

async function openSession(
  mode: "in-process" | "http",
  host: AgentRunSessionHost,
  run: ConversationAgentRunRecord
): Promise<AgentRunSession<ConversationAgentRunRecord>> {
  if (mode === "in-process") {
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE() })
    if (!session) throw new Error("Expected run to be claimed.")
    return session
  }
  const claimed = await claimAgentRunForRunner(host, { run, leaseExpiresAt: LEASE() })
  if (!claimed || claimed.run.kind !== "conversation") {
    throw new Error("Expected runner claim to succeed.")
  }
  return createHttpAgentRunSession({
    apiUrl: "http://session.local",
    runnerToken: claimed.runnerToken,
    run: claimed.run,
    fetch: async (request) => {
      const response = await serveAgentRunSession(host, request)
      if (!response) throw new Error(`Unhandled session path: ${request.url}`)
      return response
    },
  })
}

describe("runAgentTurn steering", () => {
  test.each([
    "in-process",
    "http",
  ] as const)("injects mid-tool steers at the step boundary (%s) and replays byte-identically", async (mode) => {
    const seenRequests: LanguageModelRequest[] = []
    let callCount = 0

    const model = new WorkerTestModel({
      stream: async (request) => {
        seenRequests.push(request)
        callCount += 1
        if (callCount === 1) {
          return {
            events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
              yield { type: "stream-start" }
              yield {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "check_dir",
                input: "{}",
              }
              yield {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 20, outputTokens: 8 },
              }
            })(),
          }
        }
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
            yield { type: "text-start", id: "t1" }
            yield { type: "text-delta", id: "t1", delta: "Checked src/v2 as requested." }
            yield { type: "text-end", id: "t1" }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 35, outputTokens: 9 },
            }
          })(),
        }
      },
    })

    const { storage, host } = createFixture(model)
    const run = await seedTurn(storage, "run_1")

    const tool: ModelTool = {
      name: "check_dir",
      description: "Inspect directory",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        // User submits a steer while check_dir is running.
        await storage.agents.inbox.enqueue({
          id: "inb_1",
          projectId,
          threadId,
          messageId: "msg_steer_1",
          authorPrincipal: ava,
          mode: "steer",
          parts: [{ type: "text", text: "Check src/v2 instead." }],
          timeZone: "America/New_York",
          locale: "en-US",
          createdAt: new Date("2026-11-14T16:01:30.000Z"),
        })
        return "Checked src/v1"
      },
    }

    const session = await openSession(mode, host, run)
    const sessionModel = await session.models.language({ provider: "mock", modelId: "mock-model" })
    const history = (await session.context()).history

    const finished = await runAgentTurn({
      context: {
        id: projectId,
        blobStorage: new InMemoryBlobStorage(),
        tools: [tool],
        systemPrompt: "System prompt.",
        projectTimeZone: "UTC",
        projectLocale: "en-US",
      },
      plan: {
        instructions: "Help the user.",
        model: sessionModel,
        recordedModel: sessionModel,
        tools: [],
      },
      run: session.run,
      session,
      signal: AbortSignal.any([new AbortController().signal, session.cancelled]),
      threadContext: agentThreadModelContext(history),
    })
    await session.close()

    expect(finished.status).toBe("succeeded")
    expect(await storage.agents.inbox.list({ projectId, threadId })).toEqual([])

    const { messages } = await storage.agents.messages.list({
      projectId,
      threadId,
      order: "asc",
    })
    expect(messages.map((m) => ({ role: m.role, runId: m.runId }))).toEqual([
      { role: "user", runId: null },
      { role: "assistant", runId: "run_1" },
      { role: "user", runId: null },
      { role: "assistant", runId: "run_1" },
    ])

    // Verify Turn 2 replays the exact prefix bytes Step 1 of Turn 1 sent (plus Step 1's reply).
    const nextHistory = await readAgentTurnHistory({ projectId, storage }, threadId)
    const replayed = conversationModelMessages({
      threadContext: agentThreadModelContext(nextHistory),
      project: { timeZone: "UTC", locale: "en-US" },
    })
    const step1SentWithoutSystem = seenRequests[1]!.messages.slice(1)
    expect(replayed.slice(0, step1SentWithoutSystem.length)).toEqual(step1SentWithoutSystem)
  })

  test("catches a steer sent while streaming the final answer via beforeComplete", async () => {
    let callCount = 0
    let storageRef: InMemoryStorage | undefined

    const model = new WorkerTestModel({
      stream: async () => {
        callCount += 1
        if (callCount === 1) {
          return {
            events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
              yield { type: "stream-start" }
              yield { type: "text-start", id: "a1" }
              yield { type: "text-delta", id: "a1", delta: "Initial summary." }
              yield { type: "text-end", id: "a1" }
              await storageRef!.agents.inbox.enqueue({
                id: "inb_late",
                projectId,
                threadId,
                messageId: "msg_late",
                authorPrincipal: ava,
                mode: "steer",
                parts: [{ type: "text", text: "Include Q4 numbers too." }],
                createdAt: new Date("2026-11-14T16:02:00.000Z"),
              })
              yield {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 12, outputTokens: 4 },
              }
            })(),
          }
        }
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
            yield { type: "text-start", id: "a2" }
            yield { type: "text-delta", id: "a2", delta: "Updated with Q4 numbers." }
            yield { type: "text-end", id: "a2" }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 22, outputTokens: 6 },
            }
          })(),
        }
      },
    })

    const { storage, host } = createFixture(model)
    storageRef = storage
    const run = await seedTurn(storage, "run_late")
    const session = await openSession("in-process", host, run)
    const sessionModel = await session.models.language({ provider: "mock", modelId: "mock-model" })
    const history = (await session.context()).history

    await runAgentTurn({
      context: {
        id: projectId,
        blobStorage: new InMemoryBlobStorage(),
        tools: [],
        systemPrompt: "System prompt.",
        projectTimeZone: "UTC",
        projectLocale: "en-US",
      },
      plan: {
        instructions: "Help.",
        model: sessionModel,
        recordedModel: sessionModel,
        tools: [],
      },
      run: session.run,
      session,
      signal: AbortSignal.any([new AbortController().signal, session.cancelled]),
      threadContext: agentThreadModelContext(history),
    })
    await session.close()

    expect(callCount).toBe(2)
    const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  test("releases an unanswered steer back to the inbox if cancelled before the step writes", async () => {
    let callCount = 0
    let cancelTurn: (() => Promise<void>) | undefined

    const model = new WorkerTestModel({
      stream: async (_req, signal) => {
        callCount += 1
        if (callCount === 1) {
          return {
            events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
              yield { type: "stream-start" }
              yield {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "step_one",
                input: "{}",
              }
              yield {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 10, outputTokens: 5 },
              }
            })(),
          }
        }
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            await cancelTurn?.()
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
          })(),
        }
      },
    })

    const { storage, broker, host } = createFixture(model)
    const run = await seedTurn(storage, "run_abort")
    cancelTurn = () => requestAgentRunCancel({ projectId, broker, storage: storage.agents }, run.id)

    const tool: ModelTool = {
      name: "step_one",
      description: "First step",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await storage.agents.inbox.enqueue({
          id: "inb_unanswered",
          projectId,
          threadId,
          messageId: "msg_unanswered",
          authorPrincipal: ava,
          mode: "steer",
          parts: [{ type: "text", text: "Wait for me" }],
        })
        return "done"
      },
    }

    const session = await openSession("in-process", host, run)
    const sessionModel = await session.models.language({ provider: "mock", modelId: "mock-model" })
    const history = (await session.context()).history

    const finished = await runAgentTurn({
      context: {
        id: projectId,
        blobStorage: new InMemoryBlobStorage(),
        tools: [tool],
        systemPrompt: "System prompt.",
        projectTimeZone: "UTC",
        projectLocale: "en-US",
      },
      plan: {
        instructions: "Help.",
        model: sessionModel,
        recordedModel: sessionModel,
        tools: [],
      },
      run: session.run,
      session,
      signal: AbortSignal.any([new AbortController().signal, session.cancelled]),
      threadContext: agentThreadModelContext(history),
    })
    await session.close()

    expect(finished.status).toBe("cancelled")
    const pending = await storage.agents.inbox.list({ projectId, threadId })
    expect(pending.map((item) => ({ id: item.id, claimed: item.claimedBy !== undefined }))).toEqual([
      { id: "inb_unanswered", claimed: false },
    ])
  })
})
