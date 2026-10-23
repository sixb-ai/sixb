import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  noopLoggerProvider,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestAgentExecution } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerModelCallRoutes } from "../src/routes/model-calls"

const projectId = "model-call-routes"
const PNG = new Uint8Array([137, 80, 78, 71, 1])

async function setup() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  await storage.auth.users.create({ projectId, id: "alice", email: "alice@example.test" })
  await storage.executions.create({
    projectId,
    id: "exec_request",
    requestedBy: { type: "user", id: "alice" },
    executor: { type: "request", requestId: "request" },
    source: { type: "http", requestId: "request" },
    correlationId: "request",
    authorizationRef: { type: "principal", principal: { type: "user", id: "alice" } },
  })
  const file = await blobStorage.put({ body: PNG, mediaType: "image/png" })
  await storage.aiUsage.recordModelCallFiles({
    projectId,
    executionId: "exec_request",
    callId: "call_1",
    files: [file],
    recordedAt: new Date("2026-10-22T12:00:00.000Z"),
  })

  // A call made by an Agent run in alice's thread.
  await storage.agents.threads.create({
    id: "thread_alice",
    projectId,
    ownerPrincipal: { type: "user", id: "alice" },
  })
  const agentExecutionId = await createTestAgentExecution(storage, {
    projectId,
    runId: "run_alice",
  })
  await storage.agents.runs.create({
    id: "run_alice",
    projectId,
    threadId: "thread_alice",
    triggerMessageId: "message_alice",
    executionId: agentExecutionId,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  await storage.aiUsage.recordModelCallFiles({
    projectId,
    executionId: agentExecutionId,
    callId: "call_agent",
    files: [file],
    recordedAt: new Date("2026-10-22T12:00:00.000Z"),
  })
  const host = new SixbHost({
    id: projectId,
    ontology: [] as const,
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    logger: noopLoggerProvider,
  })
  const as = (userId: string) => {
    const context: AuthorizationContext = {
      principal: { type: "user", id: userId },
      groupIds: [],
      roleIds: [],
      // Both may use the Agent; only alice owns the thread.
      grants: { ...emptyGrantIndex(), "run:agent": true },
    }
    const app = new Elysia()
    app.derive(({ request }) => ({
      sixb: bindRequestExecution(host, {
        request,
        authorization: { type: "principal", context },
      }),
    }))
    registerModelCallRoutes(app, host)
    return (path: string, method = "GET") =>
      app.handle(new Request(`http://localhost${path}`, { method }))
  }
  return { file, alice: as("alice"), bob: as("bob") }
}

describe("model call routes", () => {
  test("a call's files are served to the run's readers, and hidden from others", async () => {
    const { file, alice, bob } = await setup()

    const call = await alice("/api/ai/model-calls/call_1/files")
    expect(call.status).toBe(200)
    expect(await call.json()).toEqual({
      callId: "call_1",
      files: [file],
      recordedAt: "2026-10-22T12:00:00.000Z",
    })

    const content = await alice("/api/ai/model-calls/call_1/files/content?path=/files/0")
    expect(content.status).toBe(200)
    expect(content.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG)
    const head = await alice("/api/ai/model-calls/call_1/files/content?path=/files/0", "HEAD")
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")

    // Another user learns nothing, not even that the call exists.
    expect((await bob("/api/ai/model-calls/call_1/files")).status).toBe(404)
    expect((await bob("/api/ai/model-calls/call_1/files/content?path=/files/0")).status).toBe(404)
    expect((await alice("/api/ai/model-calls/call_missing/files")).status).toBe(404)
  })

  test("an Agent run's files follow its thread's readers", async () => {
    const { alice, bob } = await setup()

    // Proven by replacing `canViewAgentRun` in runtime/sixb.ts with `async () => true`: bob reads.
    expect((await alice("/api/ai/model-calls/call_agent/files")).status).toBe(200)
    expect((await bob("/api/ai/model-calls/call_agent/files")).status).toBe(404)
    expect((await bob("/api/ai/model-calls/call_agent/files/content?path=/files/0")).status).toBe(
      404
    )
  })

  test("content paths stay inside the call's files", async () => {
    const { alice } = await setup()
    const content = (path: string) =>
      alice(`/api/ai/model-calls/call_1/files/content?path=${encodeURIComponent(path)}`)

    expect((await content("/files/1")).status).toBe(404)
    expect((await content("/callId")).status).toBe(400)
  })
})
