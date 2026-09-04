import { describe, expect, test } from "bun:test"
import {
  can,
  defineAgent,
  defineGroup,
  defineObjectType,
  defineRole,
  every,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  SixbHost,
} from "@sixb/core"
import { agentRunControlStreamId, agentRunStreamId } from "@sixb/core/agents/streams"
import { createAgentRunExecutionToken } from "@sixb/core/internal/agents"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type {
  AgentRunFailureCode,
  AgentStorage,
  AiUsageStorage,
  SixbFailure,
} from "@sixb/core/storage"
import { createTestAgentExecution, createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Minimal stand-in: these route tests never invoke the model (the worker does), so a partial shape
// cast through unknown is enough to satisfy defineAgent's type.
const model = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "test-model",
} as unknown as Parameters<typeof defineAgent>[1]["model"]

const FAILURE: SixbFailure<AgentRunFailureCode> = {
  code: "internal.unexpected",
  message: "dispatch failed",
  retryable: false,
  at: "2026-06-27T10:00:02.000Z",
  details: { agentId: "assistant" },
}

type StartedRunInput = Omit<Parameters<AgentStorage["runs"]["create"]>[0], "executionId" | "spec"> &
  Omit<Parameters<AgentStorage["runs"]["start"]>[0], "id" | "projectId">

function testExecution(token = createAgentRunExecutionToken()) {
  return { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) }
}

async function createStartedRun(storage: InMemoryStorage, input: StartedRunInput) {
  const executionId = await createTestAgentExecution(storage, {
    projectId: input.projectId,
    agentId: input.agentId,
    runId: input.id,
  })
  await storage.agents.runs.create({
    ...input,
    executionId,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  return storage.agents.runs.start({
    id: input.id,
    projectId: input.projectId,
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
  loop: {
    stopWhen: { maxSteps: 4 },
    context: { windowTokens: 10_000 },
  },
})

const ops = defineAgent("ops", {
  name: "Ops Agent",
  model,
  instructions: "Internal ops instructions.",
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true },
    }),
  ],
  search: { title: "name", defaultText: ["name"] },
})

const supportUsers = defineGroup("support-users")
const opsUsers = defineGroup("ops-users")
const admins = defineGroup("admins")
const agentOnlyUsers = defineGroup("agent-only-users")

const supportAgentRunner = defineRole("support.agent-runner", {
  grantedTo: [supportUsers],
  grants: [can.run(assistant), can.view(Invoice)],
})

const opsAgentRunner = defineRole("ops.agent-runner", {
  grantedTo: [opsUsers],
  grants: [can.run(ops)],
})

const adminAgentRunner = defineRole("admin.agent-runner", {
  grantedTo: [admins],
  grants: [can.run(every.agent())],
})

const agentOnlyRunner = defineRole("agent-only.runner", {
  grantedTo: [agentOnlyUsers],
  grants: [can.run(assistant)],
})

function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const sixb = new SixbHost<readonly OntologySource[]>({
    id: "agent-route-tests",
    ontology: [Invoice],
    agents: [assistant, ops],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues,
    groups: [supportUsers, opsUsers, admins, agentOnlyUsers],
    roles: [supportAgentRunner, opsAgentRunner, adminAgentRunner, agentOnlyRunner],
    auth: options.auth ? { id: "test", kind: "dev" as const } : undefined,
  })

  return { sixb, storage, queues }
}

function createApp(options: { readonly auth?: boolean } = {}) {
  const { sixb, storage, queues } = createRuntime(options)
  const app = createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
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
  test("authorizes object context and persists the exact context snapshot", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const support = await seedSession(storage, "usr_context", ["support-users"])
    const agentOnly = await seedSession(storage, "usr_agent_only", ["agent-only-users"])
    await createTestSixb(sixb)
      .objects(Invoice)
      .upsert({
        properties: { id: "inv-123", name: "July maintenance" },
      })

    const agentOnlyThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { agentId: "assistant" }, agentOnly.csrfHeaders)
    )
    const agentOnlyThread = (await agentOnlyThreadResponse.json()) as { thread: { id: string } }
    const deniedContext = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${agentOnlyThread.thread.id}/messages`,
        "POST",
        {
          text: "Check this invoice",
          context: [
            {
              context: {
                kind: "object",
                ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
              },
              origin: "ambient",
            },
          ],
        },
        agentOnly.csrfHeaders
      )
    )
    expect(deniedContext.status).toBe(403)
    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: agentOnlyThread.thread.id })
    ).resolves.toMatchObject({ total: 0 })

    const threadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { agentId: "assistant" }, support.csrfHeaders)
    )
    const thread = (await threadResponse.json()) as { thread: { id: string } }
    const context = [
      {
        context: {
          kind: "object",
          ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
        },
        origin: "ambient",
      },
      {
        context: {
          kind: "app-state",
          id: "invoice-view",
          label: "Invoice view",
          description: "Current invoice view state",
          value: { activeTab: "history" },
        },
        origin: "explicit",
      },
    ]
    const post = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${thread.thread.id}/messages`,
        "POST",
        { text: "What should I do next?", context },
        support.csrfHeaders
      )
    )
    expect(post.status).toBe(202)

    const persisted = await storage.agents.messages.list({
      projectId: sixb.id,
      threadId: thread.thread.id,
    })
    expect(persisted.messages[0]).toMatchObject({
      contentVersion: 1,
      parts: [
        { type: "context", ...context[0] },
        { type: "context", ...context[1] },
        { type: "text", text: "What should I do next?" },
      ],
    })
  })

  test("rejects a missing object context before persisting a message or run", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-missing-context",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/messages`, "POST", {
        text: "Check this invoice",
        context: [
          {
            context: {
              kind: "object",
              ref: { objectTypeId: "Invoice", primaryId: "missing" },
            },
            origin: "ambient",
          },
        ],
      })
    )

    expect(response.status).toBe(400)
    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: thread.id })
    ).resolves.toMatchObject({ total: 0 })
    await expect(
      storage.agents.runs.list({ projectId: sixb.id, threadId: thread.id })
    ).resolves.toMatchObject({ total: 0 })
  })

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
        loop: {
          stopWhen: { maxSteps: 4 },
          context: { windowTokens: 10_000 },
        },
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
    expect(queuedRun?.job.payload).toEqual({ runId: postMessageBody.run.id })

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
    // The generic message must not leak the raw provider message (id / project / [SixbHost*] prefix).
    expect(body.error).not.toContain("thr-dup")
    expect(body.error).not.toContain("[SixbHost")
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
    await createStartedRun(storage, {
      id: "run-diagnostics",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "trigger-diagnostics",
      requesterGroupIds: [],
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

  test("projects a run's context checkpoint onto its durable assistant message", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thr-compaction",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    for (const message of [
      { id: "msg-old-user", role: "user" as const, text: "Research the organization." },
      { id: "msg-old-assistant", role: "assistant" as const, text: "I started the research." },
      { id: "msg-current-user", role: "user" as const, text: "Continue." },
    ]) {
      await storage.agents.messages.append({
        id: message.id,
        projectId: sixb.id,
        threadId: thread.id,
        runId: null,
        role: message.role,
        parts: [{ type: "text", text: message.text }],
      })
    }

    const executionToken = createAgentRunExecutionToken()
    await createStartedRun(storage, {
      id: "run-compaction",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-current-user",
      requesterGroupIds: [],
      execution: testExecution(executionToken),
    })
    const checkpoint = await storage.agents.checkpoints.create({
      id: "checkpoint-compaction",
      projectId: sixb.id,
      threadId: thread.id,
      createdByRunId: "run-compaction",
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 3,
      executionToken,
      reason: "threshold",
      summary: "The user asked for organization research, and the initial review began.",
      summaryFormatVersion: 1,
      summarizedThroughSeq: 2,
      observedHeadSeq: 3,
      estimatedInputTokensBefore: 9_000,
      estimatedInputTokensAfter: 2_000,
      summaryModelId: "test-model",
      createdAt: new Date("2026-08-28T10:00:00.000Z"),
    })
    await storage.agents.messages.append({
      id: "msg-compacted-response",
      projectId: sixb.id,
      threadId: thread.id,
      runId: "run-compaction",
      role: "assistant",
      parts: [{ type: "text", text: "Here is the completed research." }],
    })
    await storage.agents.runs.finish({
      id: "run-compaction",
      projectId: sixb.id,
      executionToken,
      status: "succeeded",
    })

    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`)
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      messages: { id: string; compaction?: unknown }[]
    }
    expect(body.messages.find((message) => message.id === "msg-compacted-response")).toMatchObject({
      compaction: {
        checkpointId: checkpoint.id,
        summary: checkpoint.summary,
        createdAt: checkpoint.createdAt.toISOString(),
      },
    })
    expect(
      body.messages.filter(
        (message) => message.id !== "msg-compacted-response" && "compaction" in message
      )
    ).toEqual([])
  })

  test("returns 409 when posting to a thread with an active run", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-active",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    await createStartedRun(storage, {
      id: "run-active",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-existing",
      requesterGroupIds: [],
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
    const request = await createTestSixb(sixb).agents.runs.request({
      agentId: "assistant",
      text: "wait",
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${request.run.threadId}/cancel`, "POST", {
        runId: request.run.id,
      })
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: { id: request.run.id, status: "cancelled", attempt: 0 },
    })
    await expect(
      storage.agents.runs.getById({ projectId: sixb.id, id: request.run.id })
    ).resolves.toMatchObject({ status: "cancelled", attempt: 0 })
    await expect(
      storage.agents.threads.getById({ projectId: sixb.id, id: request.run.threadId })
    ).resolves.toMatchObject({ activeRunId: null })
    const runsResponse = await app.fetch(
      new Request(
        `http://localhost/api/agent-threads/${request.run.threadId}/runs?status=cancelled`
      )
    )
    expect(runsResponse.status).toBe(200)
    expect(await runsResponse.json()).toMatchObject({
      runs: [{ id: request.run.id, status: "cancelled", attempt: 0 }],
      total: 1,
    })
    await expect(
      sixb.broker.read({
        projectId: sixb.id,
        streamId: agentRunStreamId(request.run.id),
      })
    ).resolves.toMatchObject({
      records: [
        {
          name: "agent.run.finished",
          payload: { runId: request.run.id, status: "cancelled", attempt: 0 },
        },
      ],
    })
  })

  test("cancels a run when worker startup races queued cancellation", async () => {
    const { app, storage, sixb } = createApp()
    const request = await createTestSixb(sixb).agents.runs.request({
      agentId: "assistant",
      text: "pick this up",
    })
    const originalFinishQueued = storage.agents.runs.finishQueued.bind(storage.agents.runs)
    let raceStartup = true
    storage.agents.runs.finishQueued = async (input) => {
      if (raceStartup) {
        raceStartup = false
        await storage.agents.runs.start({
          projectId: sixb.id,
          id: request.run.id,
          execution: testExecution(),
        })
      }
      return originalFinishQueued(input)
    }

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${request.run.threadId}/cancel`, "POST", {
        runId: request.run.id,
      })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      run: { id: request.run.id, status: "running", attempt: 1 },
    })
    await expect(
      storage.agents.runs.getById({ projectId: sixb.id, id: request.run.id })
    ).resolves.toMatchObject({ status: "running", attempt: 1 })
    await expect(
      sixb.broker.read({
        projectId: sixb.id,
        streamId: agentRunControlStreamId(request.run.id),
      })
    ).resolves.toMatchObject({
      records: [{ name: "agent.run.cancel", payload: { runId: request.run.id } }],
    })
  })

  test("retries a failed run with a fresh attribution snapshot and the same trigger", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const session = await seedSession(storage, "usr_retry", ["support-users", "admins"])
    const createThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { agentId: "assistant" }, session.csrfHeaders)
    )
    expect(createThreadResponse.status).toBe(201)
    const thread = (await createThreadResponse.json()) as { thread: { id: string } }
    const messageResponse = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${thread.thread.id}/messages`,
        "POST",
        { text: "try this" },
        session.csrfHeaders
      )
    )
    expect(messageResponse.status).toBe(202)
    const request = (await messageResponse.json()) as {
      run: { id: string; threadId: string; triggerMessageId: string }
    }
    const originalRun = await storage.agents.runs.getById({
      projectId: sixb.id,
      id: request.run.id,
    })
    expect(originalRun).toMatchObject({
      requesterGroupIds: ["admins", "support-users"],
      spec: { model: { provider: "test", modelId: "test-model" }, reasoning: "medium" },
    })
    await expect(
      storage.executions.getById({ projectId: sixb.id, id: originalRun?.executionId ?? "" })
    ).resolves.toMatchObject({ requestedBy: { type: "user", id: "usr_retry" } })
    const execution = testExecution()
    await storage.agents.runs.start({
      id: request.run.id,
      projectId: sixb.id,
      execution,
    })
    await storage.transaction(async (tx) => {
      await tx.agents?.messages.append({
        id: "msg_retry_partial",
        projectId: sixb.id,
        threadId: request.run.threadId,
        runId: request.run.id,
        role: "assistant",
        parts: [
          { type: "text", text: "Partial answer" },
          {
            type: "tool-call",
            toolCallId: "call_retry_partial",
            toolName: "search",
            input: { query: "try this" },
            state: "output-available",
            output: { matches: 1 },
          },
        ],
      })
      await tx.agents?.runs.finish({
        id: request.run.id,
        projectId: sixb.id,
        executionToken: execution.token,
        status: "failed",
        error: FAILURE,
        completedAt: new Date(FAILURE.at),
      })
    })

    const failedResponse = await app.fetch(
      new Request(`http://localhost/api/agent-runs/${request.run.id}`, {
        headers: session.headers,
      })
    )
    expect(failedResponse.status).toBe(200)
    expect(await failedResponse.json()).toMatchObject({ error: FAILURE })

    await storage.auth.groupMemberships.remove({
      projectId: sixb.id,
      userId: "usr_retry",
      groupId: "admins",
    })
    await storage.auth.groupMemberships.upsert({
      projectId: sixb.id,
      userId: "usr_retry",
      groupId: "ops-users",
      source: "manual",
    })

    const response = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${request.run.threadId}/runs/${request.run.id}/retry`,
        "POST",
        {},
        session.csrfHeaders
      )
    )
    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      run: { id: string; status: string; triggerMessageId: string }
    }
    expect(body.run).toMatchObject({
      status: "queued",
      triggerMessageId: request.run.triggerMessageId,
    })
    expect(body.run.id).not.toBe(request.run.id)
    const retriedRun = await storage.agents.runs.getById({ projectId: sixb.id, id: body.run.id })
    expect(retriedRun).toMatchObject({
      requesterGroupIds: ["ops-users", "support-users"],
      spec: originalRun?.spec,
    })
    await expect(
      storage.executions.getById({ projectId: sixb.id, id: retriedRun?.executionId ?? "" })
    ).resolves.toMatchObject({ requestedBy: { type: "user", id: "usr_retry" } })

    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: request.run.threadId })
    ).resolves.toMatchObject({
      messages: [{ id: request.run.triggerMessageId, role: "user" }],
      total: 1,
    })
    await expect(
      storage.agents.threads.getById({ projectId: sixb.id, id: request.run.threadId })
    ).resolves.toMatchObject({ activeRunId: body.run.id, messageCount: 1 })
  })

  test("rolls back partial-message deletion when retry admission fails", async () => {
    const { app, storage, sixb } = createApp()
    const first = await createTestSixb(sixb).agents.runs.request({
      agentId: "assistant",
      text: "first attempt",
    })
    const execution = testExecution()
    await storage.agents.runs.start({
      id: first.run.id,
      projectId: sixb.id,
      execution,
    })
    await storage.transaction(async (tx) => {
      await tx.agents?.messages.append({
        id: "msg_retry_rollback_partial",
        projectId: sixb.id,
        threadId: first.run.threadId,
        runId: first.run.id,
        role: "assistant",
        parts: [{ type: "text", text: "Keep me if retry cannot start" }],
      })
      await tx.agents?.runs.finish({
        id: first.run.id,
        projectId: sixb.id,
        executionToken: execution.token,
        status: "failed",
        error: FAILURE,
      })
    })

    const second = await createTestSixb(sixb).agents.runs.request({
      agentId: "assistant",
      threadId: first.run.threadId,
      text: "another turn",
    })
    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${first.run.threadId}/runs/${first.run.id}/retry`, "POST", {})
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: "This conversation already has a response in progress",
    })
    await expect(
      storage.agents.messages.getById({ projectId: sixb.id, id: "msg_retry_rollback_partial" })
    ).resolves.toMatchObject({ runId: first.run.id })
    await expect(
      storage.agents.threads.getById({ projectId: sixb.id, id: first.run.threadId })
    ).resolves.toMatchObject({ activeRunId: second.run.id, messageCount: 3 })
  })

  test("reads agent runs without exposing execution tokens", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-run",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage, {
      id: "run-readable",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-user",
      requesterGroupIds: [],
      modelId: "test-model",
      execution: testExecution(),
      createdAt: new Date("2026-06-27T10:00:00.000Z"),
      startedAt: new Date("2026-06-27T10:00:01.000Z"),
    })

    await storage.aiUsage.recordModelCall({
      id: "usage-readable",
      projectId: sixb.id,
      executionId: run.executionId,
      attempt: 1,
      callId: "call-readable",
      requesterGroupIds: [],
      providerId: "test",
      requestedModelId: "test-model",
      responseId: "response-readable",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      occurredAt: new Date("2026-06-27T10:00:02.000Z"),
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
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cacheReadInputTokens: 3,
        reasoningOutputTokens: 2,
        reportingStatus: "complete",
      },
      cost: {
        amounts: [],
        ratedCallCount: 0,
        unpriceableCallCount: 0,
        unvaluedCallCount: 1,
      },
      startedAt: "2026-06-27T10:00:01.000Z",
    })
    expect("execution" in body).toBe(false)

    Object.defineProperty(storage, "aiCosts", { value: undefined })
    const unavailableResponse = await app.fetch(
      new Request(`http://localhost/api/agent-runs/${run.id}`)
    )
    expect(unavailableResponse.status).toBe(200)
    const unavailableBody = (await unavailableResponse.json()) as Record<string, unknown>
    expect(unavailableBody).toMatchObject({
      id: run.id,
      usage: { inputTokens: 12, outputTokens: 8, reportingStatus: "complete" },
    })
    expect("cost" in unavailableBody).toBe(false)
  })

  test("batches ledger summaries when listing a thread's run history", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-run-list",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const firstExecutionId = await createTestAgentExecution(storage, {
      projectId: sixb.id,
      agentId: "assistant",
      runId: "run-list-1",
    })
    await storage.agents.runs.create({
      id: "run-list-1",
      projectId: sixb.id,
      executionId: firstExecutionId,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-list-1",
      spec: { model: { provider: "test", modelId: "test-model" } },
      requesterGroupIds: [],
    })
    await storage.agents.runs.finishQueued({
      id: "run-list-1",
      projectId: sixb.id,
      status: "cancelled",
    })
    const secondExecutionId = await createTestAgentExecution(storage, {
      projectId: sixb.id,
      agentId: "assistant",
      runId: "run-list-2",
    })
    await storage.agents.runs.create({
      id: "run-list-2",
      projectId: sixb.id,
      executionId: secondExecutionId,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-list-2",
      spec: { model: { provider: "test", modelId: "test-model" } },
      requesterGroupIds: [],
    })

    const aiUsage = storage.aiUsage
    const summaryInputs: Parameters<AiUsageStorage["summarizeExecutions"]>[0][] = []
    Object.defineProperty(storage, "aiUsage", {
      value: {
        recordModelCall: (input) => aiUsage.recordModelCall(input),
        getLatestForExecution: (input) => aiUsage.getLatestForExecution(input),
        summarizeExecution: (input) => aiUsage.summarizeExecution(input),
        summarizeExecutions: (input) => {
          summaryInputs.push(input)
          return aiUsage.summarizeExecutions(input)
        },
      } satisfies AiUsageStorage,
    })
    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/runs`)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      runs: [{ id: "run-list-2" }, { id: "run-list-1" }],
      hasMore: false,
      total: 2,
    })
    // Regression guard: serializing each row independently records one input per run here.
    expect(summaryInputs).toEqual([
      {
        projectId: sixb.id,
        executionIds: [secondExecutionId, firstExecutionId],
      },
    ])
  })

  test("cancel publishes a stop signal, rejects a finished run, and fences to the thread", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-cancel",
      projectId: sixb.id,
      agentId: "assistant",
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage, {
      id: "run-cancel",
      projectId: sixb.id,
      threadId: thread.id,
      agentId: "assistant",
      triggerMessageId: "msg-user",
      requesterGroupIds: [],
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
    const otherRun = await createStartedRun(storage, {
      id: "run-other",
      projectId: sixb.id,
      threadId: otherThread.id,
      agentId: "assistant",
      triggerMessageId: "msg-other",
      requesterGroupIds: [],
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
    expect(queuedRun?.job.payload).toEqual({ runId: postMessageBody.run.id })

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
