import { expect, test } from "bun:test"
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
  requestAgentRunCancel,
  serveAgentRunSession,
} from "@sixb/core/internal/agents"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { createModelCatalog } from "@sixb/core/models"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { runAgentTurn } from "../src/run-agent-turn"
import { agentThreadModelContext } from "../src/thread-context"
import { WorkerTestModel } from "./worker-model-fixture"

// A turn stopped right after its model's last step keeps what the model wrote, whether its runner
// is in the worker's process or reaches its session over HTTP.

const projectId = "stopped-turn"
const threadId = "thread"
const runId = "run_1"
const LEASE = () => new Date(Date.now() + 60_000).toISOString()

/** A queued turn, and the session host its runner works against. */
async function seed(stop: () => Promise<void>) {
  const storage = new InMemoryStorage()
  await storage.agents.threads.create({
    id: threadId,
    projectId,
    ownerPrincipal: { type: "user", id: "ava" },
  })
  await storage.agents.messages.append({
    id: "message_1",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "Summarize the open invoices." }],
  })
  const executionId = await createTestAgentExecution(storage, { projectId, runId })
  const run = await storage.agents.runs.create({
    id: runId,
    projectId,
    executionId,
    threadId,
    triggerMessageId: "message_1",
    spec: { model: { provider: "mock", modelId: "mock-model" } },
  })

  // Its answer is complete when Ava clicks Stop: the stream has nothing more to send.
  const model = new WorkerTestModel({
    stream: async () => ({
      events: (async function* (): AsyncGenerator<LanguageModelStreamEvent> {
        yield { type: "stream-start" }
        yield { type: "text-start", id: "answer" }
        yield { type: "text-delta", id: "answer", delta: "Three invoices are open." }
        yield { type: "text-end", id: "answer" }
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        }
        await stop()
      })(),
    }),
  })
  const host: AgentRunSessionHost = {
    projectId,
    storage: storage as AgentRunSessionHost["storage"],
    broker: new InMemoryBroker(),
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    security: { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog,
    // A turn run directly has no environment, so nothing it does binds the run's SDK.
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
  return { storage, host, run: run as ConversationAgentRunRecord }
}

/** Run the turn as a runner does, in its session, and return what its thread kept. */
async function runTurn(
  storage: InMemoryStorage,
  session: AgentRunSession<ConversationAgentRunRecord>
) {
  const model = await session.models.language({ provider: "mock", modelId: "mock-model" })
  const finished = await runAgentTurn({
    context: {
      id: projectId,
      blobStorage: new InMemoryBlobStorage(),
      tools: [],
      systemPrompt: "Test system prompt.",
      projectTimeZone: "UTC",
      projectLocale: "en",
    },
    plan: {
      instructions: "Answer clearly.",
      model,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: session.run,
    session,
    // As a runner joins its stop with the session's, which a Stop aborts.
    signal: session.cancelled,
    stopSignal: new AbortController().signal,
    threadContext: agentThreadModelContext((await session.context()).history),
  })
  await session.close()

  const { messages } = await storage.agents.messages.list({ projectId, threadId, order: "asc" })
  return {
    status: finished.status,
    answer: messages.filter((message) => message.role === "assistant").map((each) => each.parts),
  }
}

/** In the worker's process: the broker's cancel aborts the session at once. */
async function inProcess() {
  let session: AgentRunSession<ConversationAgentRunRecord> | null = null
  const { storage, host, run } = await seed(async () => {
    await requestAgentRunCancel({ ...host, storage: host.storage.agents }, runId)
    const cancelled = session?.cancelled
    if (cancelled && !cancelled.aborted) {
      await new Promise((resolve) => cancelled.addEventListener("abort", resolve, { once: true }))
    }
  })
  session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE() })
  if (!session) throw new Error("Expected the turn to be claimed.")
  return runTurn(storage, session)
}

/** Over HTTP: the runner hears the Stop on the session's next answer, the held-calls read. */
async function overHttp() {
  const { storage, host, run } = await seed(() =>
    requestAgentRunCancel({ ...host, storage: host.storage.agents }, runId)
  )
  const claimed = await claimAgentRunForRunner(host, { run, leaseExpiresAt: LEASE() })
  if (!claimed) throw new Error("Expected the turn to be claimed.")
  const session = createHttpAgentRunSession({
    apiUrl: "http://sixb.test",
    runnerToken: claimed.runnerToken,
    run: claimed.run as ConversationAgentRunRecord,
    fetch: async (request) =>
      (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
  })
  return runTurn(storage, session)
}

// Guard proof: drop "heldCalls.holdsRun" from STOPPING_OPERATIONS; the read the turn makes after
// its model's last step is refused, and the turn throws without recording its answer. Drop the
// stopped header from the session's answers instead, and the turn records `succeeded`.
test("a turn stopped after its model's last step keeps its answer over HTTP, as in process", async () => {
  const kept = await inProcess()

  expect(kept).toEqual({
    status: "cancelled",
    answer: [
      [
        { type: "step-start" },
        expect.objectContaining({ type: "text", text: "Three invoices are open." }),
      ],
    ],
  })
  expect(await overHttp()).toEqual(kept)
})
