import { describe, expect, test } from "bun:test"
import {
  type AgentStorage,
  agentRunControlStreamId,
  agentRunStreamId,
  agents as agentScope,
  can,
  createAgentRunExecutionToken,
  createSessionCredential,
  defineAgent,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Sixb,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Minimal stand-in: these route tests never invoke the model (the worker does), so a partial shape
// cast through unknown is enough to satisfy defineAgent's type.
const model = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "test-model",
} as unknown as Parameters<typeof defineAgent>[1]["model"]

type StartedRunInput = Parameters<AgentStorage["runs"]["create"]>[0] &
  Omit<Parameters<AgentStorage["runs"]["start"]>[0], "id" | "projectId">

function testExecution(token = createAgentRunExecutionToken()) {
  return { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) }
}

async function createStartedRun(storage: AgentStorage, input: StartedRunInput) {
  await storage.runs.create(input)
  return storage.runs.start({
    id: input.id,
    projectId: input.projectId,
    executionPrincipal: input.executionPrincipal,
    modelId: input.modelId,
    execution: input.execution,
    startedAt: input.startedAt,
  })
}

const assistant = defineAgent("assistant", {
  name: "Support Assistant",
  description: "Answers support questions.",
  model,
  reasoning: "medium",
  instructions: "Do not expose this over HTTP.",
  loop: { stopWhen: { maxSteps: 4 } },
})

const ops = defineAgent("ops", {
  name: "Ops Agent",
  model,
  instructions: "Internal ops instructions.",
})

const supportUsers = defineGroup("support-users")
const opsUsers = defineGroup("ops-users")
const admins = defineGroup("admins")

const supportAgentRunner = defineRole("support.agent-runner", {
  grantedTo: [supportUsers],
  grants: [can.run(assistant)],
})

const opsAgentRunner = defineRole("ops.agent-runner", {
  grantedTo: [opsUsers],
  grants: [can.run(ops)],
})

const adminAgentRunner = defineRole("admin.agent-runner", {
  grantedTo: [admins],
  grants: [can.run(agentScope())],
})

function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "agent-route-tests",
    ontology: [],
    agents: [assistant, ops],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues,
    groups: [supportUsers, opsUsers, admins],
    roles: [supportAgentRunner, opsAgentRunner, adminAgentRunner],
    auth: options.auth ? { id: "test", kind: "dev" as const } : undefined,
  })

  return { sixb, storage, queues }
}

function createApp(options: { readonly auth?: boolean } = {}) {
  const { sixb, storage, queues } = createRuntime(options)
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, sixb, storage, queues }
}

async function seedSession(
  storage: InMemoryStorage,
  userId: string,
  groupIds: readonly string[] = ["support-users"]
) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "agent-route-tests",
    email: `${userId}@acme.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "agent-route-tests",
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "agent-route-tests",
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-27T10:00:00.000Z"),
    expiresAt: new Date("2099-06-27T10:00:00.000Z"),
  })

  return {
    headers: { cookie: `sixb_session=${credential.cookieValue}` },
    csrfHeaders: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

function jsonRequest(
  path: string,
  method: "POST",
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" }
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

describe("agent routes", () => {
  test("lists and reads registered agents without private runtime fields", async () => {
    const { app } = createApp()

    const listResponse = await app.fetch(new Request("http://localhost/api/agents"))
    expect(listResponse.status).toBe(200)
    const agents = (await listResponse.json()) as Record<string, unknown>[]

    expect(agents).toEqual([
      {
        id: "assistant",
        name: "Support Assistant",
        description: "Answers support questions.",
        modelId: "test-model",
        reasoning: "medium",
        groupIds: [],
        loop: { stopWhen: { maxSteps: 4 } },
      },
      {
        id: "ops",
        name: "Ops Agent",
        modelId: "test-model",
        groupIds: [],
      },
    ])
    expect("instructions" in agents[0]).toBe(false)
    expect("model" in agents[0]).toBe(false)

    const getResponse = await app.fetch(new Request("http://localhost/api/agents/assistant"))
    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toMatchObject({ id: "assistant", name: "Support Assistant" })

    const missingResponse = await app.fetch(new Request("http://localhost/api/agents/missing"))
    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toEqual({ error: "Agent not found" })
  })

  test("narrows the agent catalog and rejects thread creation without can.run", async () => {
    const { app, storage } = createApp({ auth: true })
    const support = await seedSession(storage, "usr_support", ["support-users"])
    const opsSession = await seedSession(storage, "usr_ops", ["ops-users"])
    const admin = await seedSession(storage, "usr_admin", ["admins"])
    const noAccess = await seedSession(storage, "usr_none", [])

    const supportList = await app.fetch(
      new Request("http://localhost/api/agents", { headers: support.headers })
    )
    expect(((await supportList.json()) as { id: string }[]).map((agent) => agent.id)).toEqual([
      "assistant",
    ])

    const hidden = await app.fetch(
      new Request("http://localhost/api/agents/ops", { headers: support.headers })
    )
    expect(hidden.status).toBe(404)

    const opsList = await app.fetch(
      new Request("http://localhost/api/agents", { headers: opsSession.headers })
    )
    expect(((await opsList.json()) as { id: string }[]).map((agent) => agent.id)).toEqual(["ops"])

    const adminList = await app.fetch(
      new Request("http://localhost/api/agents", { headers: admin.headers })
    )
    expect(((await adminList.json()) as { id: string }[]).map((agent) => agent.id)).toEqual([
      "assistant",
      "ops",
    ])

    const deniedThread = await app.fetch(
      jsonRequest(
        "/api/agent-threads",
        "POST",
        { agentId: "assistant", title: "Denied" },
        noAccess.csrfHeaders
      )
    )
    // An ungranted agent is hidden: creation 404s (agent not found) rather than 403, so the
    // response does not disclose that the agent id exists.
    expect(deniedThread.status).toBe(404)

    const allowedThread = await app.fetch(
      jsonRequest(
        "/api/agent-threads",
        "POST",
        { agentId: "assistant", title: "Allowed" },
        support.csrfHeaders
      )
    )
    expect(allowedThread.status).toBe(201)
  })

  test("creates a thread, posts a message, and exposes a durable queued run", async () => {
    const { app, storage, sixb } = createApp()

    const createThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", {
        agentId: "assistant",
        title: "Pipeline check",
      })
    )
    expect(createThreadResponse.status).toBe(201)
    const createThreadBody = (await createThreadResponse.json()) as {
      thread: { id: string; ownerPrincipal: unknown; title: string }
    }
    expect(createThreadBody.thread.title).toBe("Pipeline check")
    expect(createThreadBody.thread.ownerPrincipal).toEqual({ type: "system", id: "system" })

    const listThreadsResponse = await app.fetch(
      new Request("http://localhost/api/agent-threads?agentId=assistant&limit=5")
    )
    expect(listThreadsResponse.status).toBe(200)
    expect(await listThreadsResponse.json()).toMatchObject({
      total: 1,
      hasMore: false,
      threads: [{ id: createThreadBody.thread.id, agentId: "assistant", messageCount: 0 }],
    })

    const attachment = await sixb.blobStorage.put({
      body: new TextEncoder().encode("pipeline log contents"),
      fileName: "pipeline.log",
      mediaType: "text/plain",
    })
    const postMessageResponse = await app.fetch(
      jsonRequest(`/api/agent-threads/${createThreadBody.thread.id}/messages`, "POST", {
        text: "Check the failed pipeline.",
        attachments: [attachment],
      })
    )
    expect(postMessageResponse.status).toBe(202)
    const postMessageBody = (await postMessageResponse.json()) as {
      run: {
        id: string
        threadId: string
        triggerMessageId: string
        status: "queued"
        attempt: number
        streamId: string
      }
    }
    expect(postMessageBody).toMatchObject({
      run: {
        threadId: createThreadBody.thread.id,
        status: "queued",
        attempt: 0,
        streamId: `agents.runs.${postMessageBody.run.id}`,
      },
    })

    await expect(
      storage.agents.runs.getById({ projectId: sixb.id, id: postMessageBody.run.id })
    ).resolves.toMatchObject({ status: "queued", attempt: 0 })

    const runsResponse = await app.fetch(
      new Request(
        `http://localhost/api/agent-threads/${createThreadBody.thread.id}/runs?status=queued&limit=1`
      )
    )
    expect(runsResponse.status).toBe(200)
    expect(await runsResponse.json()).toMatchObject({
      runs: [{ id: postMessageBody.run.id, status: "queued", attempt: 0 }],
      hasMore: false,
      total: 1,
    })

    const [queuedRun] = await sixb.queues.agents.claim({
      projectId: sixb.id,
      workerId: "agent-route-test",
    })
    expect(queuedRun?.job.payload).toEqual({
      agentId: "assistant",
      threadId: createThreadBody.thread.id,
      runId: postMessageBody.run.id,
      triggerMessageId: postMessageBody.run.triggerMessageId,
    })

    const messagesResponse = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${createThreadBody.thread.id}/messages`)
    )
    expect(messagesResponse.status).toBe(200)
    expect(await messagesResponse.json()).toMatchObject({
      total: 1,
      messages: [
        {
          id: postMessageBody.run.triggerMessageId,
          runId: null,
          role: "user",
          authorPrincipal: { type: "system", id: "system" },
          seq: 1,
          parts: [
            { type: "text", text: "Check the failed pipeline." },
            { type: "file", fileRef: attachment },
          ],
        },
      ],
    })

    const contentUrl = `http://localhost/api/agent-threads/${createThreadBody.thread.id}/messages/${postMessageBody.run.triggerMessageId}/files/content?path=${encodeURIComponent("/parts/1/fileRef")}`
    const contentResponse = await app.fetch(new Request(contentUrl))
    expect(contentResponse.status).toBe(200)
    expect(contentResponse.headers.get("content-type")).toBe("text/plain")
    expect(contentResponse.headers.get("content-disposition")).toContain("pipeline.log")
    expect(await contentResponse.text()).toBe("pipeline log contents")

    const headResponse = await app.fetch(new Request(contentUrl, { method: "HEAD" }))
    expect(headResponse.status).toBe(200)
    expect(headResponse.headers.get("content-length")).toBe("21")
    expect(await headResponse.text()).toBe("")

    const invalidRoot = await app.fetch(
      new Request(
        `http://localhost/api/agent-threads/${createThreadBody.thread.id}/messages/${postMessageBody.run.triggerMessageId}/files/content?path=${encodeURIComponent("/metadata/file")}`
      )
    )
    expect(invalidRoot.status).toBe(400)

    const nonFile = await app.fetch(
      new Request(
        `http://localhost/api/agent-threads/${createThreadBody.thread.id}/messages/${postMessageBody.run.triggerMessageId}/files/content?path=${encodeURIComponent("/parts/0/text")}`
      )
    )
    expect(nonFile.status).toBe(404)
  })

  test("returns a generic 409 when creating a thread with a duplicate id", async () => {
    const { app } = createApp()

    const first = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { agentId: "assistant", threadId: "thr-dup" })
    )
    expect(first.status).toBe(201)

    const second = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { agentId: "assistant", threadId: "thr-dup" })
    )
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: string }
    expect(body.error).toBe("Agent thread already exists")
    // The generic message must not leak the raw provider message (id / project / [Sixb*] prefix).
    expect(body.error).not.toContain("thr-dup")
    expect(body.error).not.toContain("[Sixb")
  })

  test("projects run diagnostics as transcript annotations without changing message parts", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thr-diagnostics",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const executionToken = createAgentRunExecutionToken()
    await createStartedRun(storage.agents, {
      id: "run-diagnostics",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "trigger-diagnostics",
      requestedByPrincipal: { type: "system", id: "system" },
      execution: testExecution(executionToken),
    })
    await storage.agents.messages.append({
      id: "msg-diagnostics",
      projectId: sixb.id,
      threadId: thread.id,
      runId: "run-diagnostics",
      role: "assistant",
      parts: [{ type: "text", text: "The report is ready." }],
    })
    const diagnostics = [
      {
        code: "output_file_too_large" as const,
        severity: "warning" as const,
        scope: "output" as const,
        path: "reports/full.csv",
        message: "This generated file was skipped.",
      },
    ]
    await storage.agents.runs.finish({
      id: "run-diagnostics",
      projectId: sixb.id,
      executionToken,
      status: "succeeded",
      diagnostics,
    })

    const messagesResponse = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`)
    )
    expect(messagesResponse.status).toBe(200)
    const messagesBody = (await messagesResponse.json()) as {
      messages: { parts: unknown[]; annotations: unknown[] }[]
    }
    expect(messagesBody.messages[0]?.parts).toEqual([
      { type: "text", text: "The report is ready." },
    ])
    expect(messagesBody.messages[0]?.annotations).toEqual(diagnostics)

    const runResponse = await app.fetch(
      new Request("http://localhost/api/agent-runs/run-diagnostics")
    )
    expect(runResponse.status).toBe(200)
    expect(await runResponse.json()).toMatchObject({ diagnostics })
  })

  test("returns 409 when posting to a thread with an active run", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-active",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    await createStartedRun(storage.agents, {
      id: "run-active",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-existing",
      requestedByPrincipal: { type: "system", id: "system" },
      execution: testExecution(),
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/messages`, "POST", {
        text: "second",
      })
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: `[Sixb] Agent thread '${thread.id}' already has an active run 'run-active'.`,
    })
  })

  test("cancels a queued run before a worker starts it", async () => {
    const { app, storage, sixb } = createApp()
    const request = await sixb.agents.request({ agentId: "assistant", text: "wait" })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${request.threadId}/cancel`, "POST", {
        runId: request.runId,
      })
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: { id: request.runId, status: "cancelled", attempt: 0 },
    })
    await expect(
      storage.agents.runs.getById({ projectId: sixb.id, id: request.runId })
    ).resolves.toMatchObject({ status: "cancelled", attempt: 0 })
    await expect(
      storage.agents.threads.getById({ projectId: sixb.id, id: request.threadId })
    ).resolves.toMatchObject({ activeRunId: null })
    const runsResponse = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${request.threadId}/runs?status=cancelled`)
    )
    expect(runsResponse.status).toBe(200)
    expect(await runsResponse.json()).toMatchObject({
      runs: [{ id: request.runId, status: "cancelled", attempt: 0 }],
      total: 1,
    })
    await expect(
      sixb.broker.read({
        projectId: sixb.id,
        streamId: agentRunStreamId(request.runId),
      })
    ).resolves.toMatchObject({
      records: [
        {
          name: "agent.run.finished",
          payload: { runId: request.runId, status: "cancelled", attempt: 0 },
        },
      ],
    })
  })

  test("cancels a run when worker startup races queued cancellation", async () => {
    const { app, storage, sixb } = createApp()
    const request = await sixb.agents.request({ agentId: "assistant", text: "pick this up" })
    const originalFinishQueued = storage.agents.runs.finishQueued.bind(storage.agents.runs)
    let raceStartup = true
    storage.agents.runs.finishQueued = async (input) => {
      if (raceStartup) {
        raceStartup = false
        await storage.agents.runs.start({
          projectId: sixb.id,
          id: request.runId,
          execution: testExecution(),
        })
      }
      return originalFinishQueued(input)
    }

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${request.threadId}/cancel`, "POST", {
        runId: request.runId,
      })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: { id: request.runId, status: "running", attempt: 1 },
    })
    await expect(
      storage.agents.runs.getById({ projectId: sixb.id, id: request.runId })
    ).resolves.toMatchObject({ status: "running", attempt: 1 })
    await expect(
      sixb.broker.read({
        projectId: sixb.id,
        streamId: agentRunControlStreamId(request.runId),
      })
    ).resolves.toMatchObject({
      records: [{ name: "agent.run.cancel", payload: { runId: request.runId } }],
    })
  })

  test("retries a failed run without duplicating its trigger message", async () => {
    const { app, storage, sixb } = createApp()
    const request = await sixb.agents.request({ agentId: "assistant", text: "try this" })
    await storage.agents.runs.finishQueued({
      id: request.runId,
      projectId: sixb.id,
      status: "failed",
      error: "dispatch failed",
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${request.threadId}/runs/${request.runId}/retry`, "POST", {})
    )
    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      run: { id: string; status: string; triggerMessageId: string }
    }
    expect(body.run).toMatchObject({
      status: "queued",
      triggerMessageId: request.triggerMessageId,
    })
    expect(body.run.id).not.toBe(request.runId)

    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: request.threadId })
    ).resolves.toMatchObject({
      messages: [{ id: request.triggerMessageId, role: "user" }],
      total: 1,
    })
    await expect(
      storage.agents.threads.getById({ projectId: sixb.id, id: request.threadId })
    ).resolves.toMatchObject({ activeRunId: body.run.id })
  })

  test("reads agent runs without exposing execution tokens", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-run",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage.agents, {
      id: "run-readable",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-user",
      requestedByPrincipal: { type: "system", id: "system" },
      modelId: "test-model",
      execution: testExecution(),
      createdAt: new Date("2026-06-27T10:00:00.000Z"),
      startedAt: new Date("2026-06-27T10:00:01.000Z"),
    })

    const response = await app.fetch(new Request(`http://localhost/api/agent-runs/${run.id}`))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({
      id: run.id,
      threadId: thread.id,
      agentId: "assistant",
      status: "running",
      modelId: "test-model",
      attempt: 1,
      streamId: `agents.runs.${run.id}`,
      startedAt: "2026-06-27T10:00:01.000Z",
    })
    expect("execution" in body).toBe(false)
  })

  test("cancel publishes a stop signal, rejects a finished run, and fences to the thread", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-cancel",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage.agents, {
      id: "run-cancel",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-user",
      requestedByPrincipal: { type: "system", id: "system" },
      execution: testExecution(),
    })

    // A running run: 202, and the stop signal lands on the run's control stream for the worker.
    const ok = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/cancel`, "POST", { runId: run.id })
    )
    expect(ok.status).toBe(202)
    expect(await ok.json()).toMatchObject({ run: { id: run.id, status: "running" } })
    const { records: control } = await sixb.broker.read({
      projectId: sixb.id,
      streamId: agentRunControlStreamId(run.id),
    })
    expect(control.some((record) => record.name === "agent.run.cancel")).toBe(true)

    // Cancelling a run that has already finished is a 409, not a silent no-op.
    await storage.agents.runs.finish({
      projectId: sixb.id,
      id: run.id,
      executionToken: run.execution?.token ?? "",
      status: "cancelled",
    })
    const finished = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/cancel`, "POST", { runId: run.id })
    )
    expect(finished.status).toBe(409)

    // A run that belongs to another thread cannot be cancelled through this one.
    const otherThread = await storage.agents.threads.create({
      id: "thread-other",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const otherRun = await createStartedRun(storage.agents, {
      id: "run-other",
      projectId: sixb.id,
      threadId: otherThread.id,
      agentId: "assistant",
      triggerMessageId: "msg-other",
      requestedByPrincipal: { type: "system", id: "system" },
      execution: testExecution(),
    })
    const crossThread = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/cancel`, "POST", { runId: otherRun.id })
    )
    expect(crossThread.status).toBe(404)
  })

  test("owner-scopes threads, messages, and runs when auth is enabled", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const owner = await seedSession(storage, "usr_owner")
    const other = await seedSession(storage, "usr_other")

    const ownerThreadResponse = await app.fetch(
      jsonRequest(
        "/api/agent-threads",
        "POST",
        { agentId: "assistant", title: "Owner thread" },
        owner.csrfHeaders
      )
    )
    const otherThreadResponse = await app.fetch(
      jsonRequest(
        "/api/agent-threads",
        "POST",
        { agentId: "assistant", title: "Other thread" },
        other.csrfHeaders
      )
    )
    expect(ownerThreadResponse.status).toBe(201)
    expect(otherThreadResponse.status).toBe(201)
    const ownerThread = (await ownerThreadResponse.json()) as { thread: { id: string } }
    const otherThread = (await otherThreadResponse.json()) as { thread: { id: string } }
    await storage.agents.threads.create({
      id: "owner-ops-thread",
      projectId: sixb.id,
      agentId: "ops",
      ownerPrincipal: { type: "user", id: "usr_owner" },
      title: "Owned but ungranted",
    })

    const ownerList = await app.fetch(
      new Request("http://localhost/api/agent-threads", { headers: owner.headers })
    )
    expect(ownerList.status).toBe(200)
    expect(await ownerList.json()).toMatchObject({
      total: 1,
      threads: [{ id: ownerThread.thread.id, ownerPrincipal: { type: "user", id: "usr_owner" } }],
    })

    const hiddenOwnedThread = await app.fetch(
      new Request("http://localhost/api/agent-threads/owner-ops-thread", {
        headers: owner.headers,
      })
    )
    expect(hiddenOwnedThread.status).toBe(404)

    const hiddenThread = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${otherThread.thread.id}`, {
        headers: owner.headers,
      })
    )
    expect(hiddenThread.status).toBe(404)

    const attachment = await sixb.blobStorage.put({
      body: new TextEncoder().encode("owner attachment"),
      fileName: "owner.txt",
      mediaType: "text/plain",
    })
    const postMessageResponse = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${ownerThread.thread.id}/messages`,
        "POST",
        { text: "hello", attachments: [attachment] },
        owner.csrfHeaders
      )
    )
    expect(postMessageResponse.status).toBe(202)
    const postMessageBody = (await postMessageResponse.json()) as {
      run: { id: string; triggerMessageId: string }
    }

    const [queuedRun] = await sixb.queues.agents.claim({
      projectId: sixb.id,
      workerId: "agent-route-auth-test",
    })
    expect(queuedRun?.job.payload).toEqual({
      agentId: "assistant",
      threadId: ownerThread.thread.id,
      runId: postMessageBody.run.id,
      triggerMessageId: postMessageBody.run.triggerMessageId,
    })

    await storage.agents.runs.start({
      id: postMessageBody.run.id,
      projectId: sixb.id,
      execution: testExecution(),
    })

    const hiddenRun = await app.fetch(
      new Request(`http://localhost/api/agent-runs/${postMessageBody.run.id}`, {
        headers: other.headers,
      })
    )
    expect(hiddenRun.status).toBe(404)

    const hiddenRuns = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${ownerThread.thread.id}/runs`, {
        headers: other.headers,
      })
    )
    expect(hiddenRuns.status).toBe(404)

    const hiddenMessages = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${ownerThread.thread.id}/messages`, {
        headers: other.headers,
      })
    )
    expect(hiddenMessages.status).toBe(404)

    const fileContentUrl = `http://localhost/api/agent-threads/${ownerThread.thread.id}/messages/${postMessageBody.run.triggerMessageId}/files/content?path=${encodeURIComponent("/parts/1/fileRef")}`
    const hiddenFileContent = await app.fetch(
      new Request(fileContentUrl, { headers: other.headers })
    )
    expect(hiddenFileContent.status).toBe(404)

    const ownerFileContent = await app.fetch(
      new Request(fileContentUrl, { headers: owner.headers })
    )
    expect(ownerFileContent.status).toBe(200)
    expect(await ownerFileContent.text()).toBe("owner attachment")
  })
})
