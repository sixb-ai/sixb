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

// A message the user sends while a turn runs steers it: the turn reads it after the step that was
// running, answers again in the same turn, and stores both messages so the next turn replays the
// bytes the steered request sent.

const projectId = "turn-steering"
const threadId = "thr_1"
const ava: Principal = { type: "user", id: "usr_ava" }
const LEASE = () => new Date(Date.now() + 60_000).toISOString()

function createHost(model: WorkerTestModel) {
  const storage = new InMemoryStorage()
  const host: AgentRunSessionHost = {
    projectId,
    storage: storage as AgentRunSessionHost["storage"],
    broker: new InMemoryBroker(),
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    security: { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog,
    domainEvents: { emit: async () => {} },
    sdk: {
      id: projectId,
      withScope: () => {
        throw new Error("A turn run directly reaches no project SDK.")
      },
    },
    definitions: {
      models: createModelCatalog({ language: [model] }),
    } as unknown as AgentRunPlanDefinitions,
  }
  return { storage, host }
}

/** A conversation with one message from Ava, and a queued turn waiting to run. */
async function seedTurn(storage: InMemoryStorage, runId: string) {
  const thread = await storage.agents.threads.getById({ projectId, id: threadId })
  if (!thread) {
    await storage.agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: ava,
      createdAt: new Date("2026-11-14T16:00:00.000Z"),
    })
  }
  const triggerId = `msg_trigger_${runId}`
  await storage.agents.messages.append({
    id: triggerId,
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
    triggerMessageId: triggerId,
    spec: {
      model: { provider: "mock", modelId: "mock-model" },
      timeZone: "America/New_York",
      locale: "en-US",
    },
    createdAt: new Date("2026-11-14T16:01:00.000Z"),
  })
  return run as ConversationAgentRunRecord
}

/** The run's session, as the worker holds it, or as a runner on a computer reaches it over HTTP. */
async function openSession(
  mode: "in-process" | "http",
  host: AgentRunSessionHost,
  run: ConversationAgentRunRecord
): Promise<AgentRunSession<ConversationAgentRunRecord>> {
  if (mode === "in-process") {
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE() })
    if (!session) throw new Error("Expected the turn to be claimed.")
    return session
  }
  const claimed = await claimAgentRunForRunner(host, { run, leaseExpiresAt: LEASE() })
  if (!claimed || claimed.run.kind !== "conversation") {
    throw new Error("Expected the runner's claim to succeed.")
  }
  return createHttpAgentRunSession({
    apiUrl: "http://sixb.test",
    runnerToken: claimed.runnerToken,
    run: claimed.run,
    fetch: async (request) =>
      (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
  })
}

function testTool(
  name: string,
  run: () => Promise<string>,
  description = "A tool the turn runs."
): ModelTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    parseInput: () => ({}),
    execute: async () => run(),
    errorText: (error) => (error instanceof Error ? error.message : "The tool failed."),
  } as ModelTool
}

async function runTurn(
  session: AgentRunSession<ConversationAgentRunRecord>,
  tools: readonly ModelTool[]
) {
  const model = await session.models.language({ provider: "mock", modelId: "mock-model" })
  const turn = await session.context()
  const finished = await runAgentTurn({
    context: {
      id: projectId,
      blobStorage: new InMemoryBlobStorage(),
      tools,
      systemPrompt: "Test system prompt.",
      projectTimeZone: "UTC",
      projectLocale: "en-US",
    },
    plan: {
      instructions: "Answer clearly.",
      model,
      recordedModel: model,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: session.run,
    session,
    signal: session.cancelled,
    threadContext: agentThreadModelContext(turn.history),
  })
  await session.close()
  return finished
}

function answer(text: string): LanguageModelStreamEvent[] {
  return [
    { type: "stream-start" },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 6 } },
  ]
}

describe("a turn's mid-run steers", () => {
  test.each([
    "in-process",
    "http",
  ] as const)("are read after the running step and replay byte-identically (%s)", async (mode) => {
    const requests: LanguageModelRequest[] = []
    const model = new WorkerTestModel({
      stream: async (request) => {
        requests.push(request)
        const firstCall = requests.length === 1
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            for (const event of firstCall
              ? [
                  { type: "stream-start" } as const,
                  {
                    type: "tool-call" as const,
                    toolCallId: "call_1",
                    toolName: "check_folder",
                    input: "{}",
                  },
                  {
                    type: "finish" as const,
                    finishReason: "tool-calls" as const,
                    usage: { inputTokens: 20, outputTokens: 8 },
                  },
                ]
              : answer("Checked src/v2 as asked.")) {
              yield event
            }
          })(),
        }
      },
    })

    const { storage, host } = createHost(model)
    const run = await seedTurn(storage, "run_1")
    const tool = testTool("check_folder", async () => {
      // Ava steers while the tool runs: her message waits for the step to finish.
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
      return "src/v1 has 3 files."
    })

    const session = await openSession(mode, host, run)
    const finished = await runTurn(session, [tool])

    expect(finished.status).toBe("succeeded")
    expect(requests).toHaveLength(2)
    // The step after the tool read the steer, so the thread's inbox is empty.
    expect(await storage.agents.inbox.list({ projectId, threadId })).toEqual([])

    const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
    expect(messages.map((message) => ({ role: message.role, runId: message.runId }))).toEqual([
      { role: "user", runId: null },
      { role: "assistant", runId: "run_1" },
      { role: "user", runId: null },
      { role: "assistant", runId: "run_1" },
    ])
    const steer = messages[2]
    expect(steer?.id).toBe("msg_steer_1")
    expect(steer?.authorPrincipal).toEqual(ava)
    expect(steer?.parts).toEqual([{ type: "text", text: "Check src/v2 instead." }])
    expect(steer?.metadata).toEqual({ timeZone: "America/New_York", locale: "en-US" })

    // The next turn's request starts with the bytes the steered request sent, its steer too: only
    // the answer that followed it is new.
    const replayed = conversationModelMessages({
      threadContext: agentThreadModelContext(
        await readAgentTurnHistory({ projectId, storage }, threadId)
      ),
      project: { timeZone: "UTC", locale: "en-US" },
    })
    const steered = requests[1]!.messages.slice(1)
    expect(replayed.slice(0, steered.length)).toEqual(steered)
  })

  test("are read before the turn ends when they come as the model answers", async () => {
    const requests: LanguageModelRequest[] = []
    let storage: InMemoryStorage | undefined
    const model = new WorkerTestModel({
      stream: async (request) => {
        requests.push(request)
        if (requests.length === 2) {
          return {
            events: (async function* () {
              yield* answer("Q4 is included now.")
            })(),
          }
        }
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
            yield { type: "text-start", id: "answer" }
            yield { type: "text-delta", id: "answer", delta: "Revenue grew in Q3." }
            yield { type: "text-end", id: "answer" }
            // Sent while the answer streams, before the turn would end on it.
            await storage!.agents.inbox.enqueue({
              id: "inb_late",
              projectId,
              threadId,
              messageId: "msg_late",
              authorPrincipal: ava,
              mode: "steer",
              parts: [{ type: "text", text: "Include Q4 too." }],
              createdAt: new Date("2026-11-14T16:02:00.000Z"),
            })
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 12, outputTokens: 4 },
            }
          })(),
        }
      },
    })

    const fixture = createHost(model)
    storage = fixture.storage
    const run = await seedTurn(fixture.storage, "run_late")
    const session = await openSession("in-process", fixture.host, run)
    const finished = await runTurn(session, [])

    expect(finished.status).toBe("succeeded")
    expect(requests).toHaveLength(2)
    // The second request follows the first answer with the steer, not with the turn's end.
    expect(requests[1]!.messages).toHaveLength(requests[0]!.messages.length + 2)

    const { messages } = await fixture.storage.agents.messages.list({
      projectId,
      threadId,
      order: "asc",
    })
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(messages[2]?.id).toBe("msg_late")
    expect(await fixture.storage.agents.inbox.list({ projectId, threadId })).toEqual([])
  })

  test("stay in the inbox when the turn stops before answering them", async () => {
    const requests: LanguageModelRequest[] = []
    const stop = new AbortController()
    const model = new WorkerTestModel({
      stream: async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return {
            events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
              yield { type: "stream-start" }
              yield {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "check_folder",
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
        // The turn reads Ava's steers before this call, then stops before it answers.
        stop.abort()
        return {
          events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
            yield { type: "stream-start" }
          })(),
        }
      },
    })

    const { storage, host } = createHost(model)
    const run = await seedTurn(storage, "run_stop")
    const tool = testTool("check_folder", async () => {
      await storage.agents.inbox.enqueue({
        id: "inb_0",
        projectId,
        threadId,
        messageId: "msg_steer_0",
        authorPrincipal: ava,
        mode: "steer",
        parts: [{ type: "text", text: "Read src/v2." }],
        createdAt: new Date("2026-11-14T16:02:00.000Z"),
      })
      await storage.agents.inbox.enqueue({
        id: "inb_1",
        projectId,
        threadId,
        messageId: "msg_steer_1",
        authorPrincipal: ava,
        mode: "steer",
        parts: [{ type: "text", text: "And skip the fixtures." }],
        createdAt: new Date("2026-11-14T16:03:00.000Z"),
      })
      return "src/v1 has 3 files."
    })

    const session = await openSession("in-process", host, run)
    const turn = await session.context()
    const model0 = await session.models.language({ provider: "mock", modelId: "mock-model" })
    const finished = await runAgentTurn({
      context: {
        id: projectId,
        blobStorage: new InMemoryBlobStorage(),
        tools: [tool],
        systemPrompt: "Test system prompt.",
        projectTimeZone: "UTC",
        projectLocale: "en-US",
      },
      plan: {
        instructions: "Answer clearly.",
        model: model0,
        recordedModel: model0,
        tools: [],
        skills: [],
        ontologyDocs: { files: [], index: [] },
      },
      run: session.run,
      session,
      signal: AbortSignal.any([stop.signal, session.cancelled]),
      threadContext: agentThreadModelContext(turn.history),
    })
    await session.close()

    // The turn read both steers, then stopped before a step answered them.
    expect(requests).toHaveLength(2)
    expect(finished.status).toBe("cancelled")
    expect(finished.finishReason).toBeUndefined()

    // Neither reached the thread, so both wait again, as if never read.
    const pending = await storage.agents.inbox.list({ projectId, threadId })
    expect(pending.map((item) => ({ id: item.id, claimed: item.claimedBy !== undefined }))).toEqual(
      [
        { id: "inb_0", claimed: false },
        { id: "inb_1", claimed: false },
      ]
    )
    const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
    expect(messages.map((message) => message.id)).toEqual(["msg_trigger_run_stop", messages[1]!.id])
    expect(messages[1]!.role).toBe("assistant")
  })

  test("cannot carry a file, which a mid-turn read cannot prepare", async () => {
    const { storage } = createHost(new WorkerTestModel({}))
    await seedTurn(storage, "run_file")

    const error = await storage.agents.inbox
      .enqueue({
        id: "inb_file",
        projectId,
        threadId,
        messageId: "msg_file",
        authorPrincipal: ava,
        mode: "steer",
        parts: [
          {
            type: "file",
            fileRef: {
              blobId: "blob_1",
              digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              fileName: "chart.png",
              mediaType: "image/png",
              sizeBytes: 12,
            },
          },
        ],
      })
      .catch((caught: unknown) => caught)
    expect(String(error)).toContain("carries no file")

    // Queueing it for the next turn is what a file takes, where the turn prepares it.
    const queued = await storage.agents.inbox.enqueue({
      id: "inb_file",
      projectId,
      threadId,
      messageId: "msg_file",
      authorPrincipal: ava,
      mode: "queue",
      parts: [{ type: "text", text: "Look at this chart." }],
    })
    expect(queued.created).toBe(true)
  })
})
