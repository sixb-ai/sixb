import { describe, expect, test } from "bun:test"
import type { ModelCatalogInput } from "@sixb/core"
import {
  agent,
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  param,
  prop,
  SixbHost,
} from "@sixb/core"
import { createAgentRunExecutionToken } from "@sixb/core/internal/agents"
import { agentRunControlStreamId, agentRunStreamId } from "@sixb/core/internal/agents/streams"
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

// Route tests register the binding but never invoke the provider.
const model = {
  providerId: "test",
  modelId: "test-model",
  definition: {
    kind: "language",
    providerId: "test",
    modelId: "test-model",
    capabilities: {},
  },
  stream: async () => {
    throw new Error("Must not invoke the route test model")
  },
} satisfies NonNullable<ModelCatalogInput["language"]>[number]

const FAILURE: SixbFailure<AgentRunFailureCode> = {
  code: "internal.unexpected",
  message: "dispatch failed",
  retryable: false,
  at: "2026-06-27T10:00:02.000Z",
  details: { runId: "run-failed", threadId: "thread-failed" },
}

type StartedRunInput = Omit<Parameters<AgentStorage["runs"]["create"]>[0], "executionId" | "spec"> &
  Omit<Parameters<AgentStorage["runs"]["start"]>[0], "id" | "projectId">

function testExecution(token = createAgentRunExecutionToken()) {
  return { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) }
}

async function createStartedRun(storage: InMemoryStorage, input: StartedRunInput) {
  const executionId = await createTestAgentExecution(storage, {
    projectId: input.projectId,
    runId: input.id,
    authority: "inherited",
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
  grants: [can.run(agent), can.view(Invoice)],
})

const opsAgentRunner = defineRole("ops.agent-runner", {
  grantedTo: [opsUsers],
  grants: [can.run(agent)],
})

const adminAgentRunner = defineRole("admin.agent-runner", {
  grantedTo: [admins],
  grants: [can.run(agent)],
})

const agentOnlyRunner = defineRole("agent-only.runner", {
  grantedTo: [agentOnlyUsers],
  grants: [can.run(agent)],
})

function createRuntime(options: { readonly auth?: boolean; readonly sandbox?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const sixb = new SixbHost({
    id: "agent-route-tests",
    ontology: [Invoice],
    models: { language: [model] },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues,
    ...(options.sandbox
      ? {
          sandboxes: {
            create: async () => {
              throw new Error("Must not create a sandbox")
            },
            resume: async () => {
              throw new Error("Must not resume a sandbox")
            },
            configuration: {
              params: { clientId: param("string") },
              resolve: async () => {
                throw new Error("Must not resolve on thread creation")
              },
            },
          },
        }
      : {}),
    groups: [supportUsers, opsUsers, admins, agentOnlyUsers],
    roles: [supportAgentRunner, opsAgentRunner, adminAgentRunner, agentOnlyRunner],
    auth: options.auth ? { id: "test", kind: "dev" as const } : undefined,
  })

  return { sixb, storage, queues }
}

function createApp(options: { readonly auth?: boolean; readonly sandbox?: boolean } = {}) {
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
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-27T10:00:00.000Z"),
    expiresAt: new Date("2099-06-27T10:00:00.000Z"),
  })

  return {
    headers: { cookie: `sixb_session_app=${credential.cookieValue}` },
    csrfHeaders: {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
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
  test("owner-scopes explicit workspace recovery and hides ownership tokens", async () => {
    const { app, storage, sixb } = createApp({ sandbox: true, auth: true })
    const owner = await seedSession(storage, "workspace-owner")
    const stranger = await seedSession(storage, "workspace-stranger")
    await storage.agents.threads.create({
      projectId: sixb.id,
      id: "recovery",
      ownerPrincipal: { type: "user", id: "workspace-owner" },
      sandboxParams: { clientId: "acme" },
    })
    await createStartedRun(storage, {
      projectId: sixb.id,
      id: "recovery-run",
      threadId: "recovery",
      triggerMessageId: "trigger",
      execution: testExecution("private-owner-token"),
    })
    await storage.agents.threads.transitionSandbox({
      projectId: sixb.id,
      id: "recovery",
      action: "acquire",
      runId: "recovery-run",
      executionToken: "private-owner-token",
      name: "old-name",
      sourceFingerprint: "a".repeat(64),
    })
    const path = "/api/agent-threads/recovery/sandbox/recreate"
    const body = { expectedSandboxName: "old-name" }
    expect((await app.fetch(jsonRequest(path, "POST", body, stranger.csrfHeaders))).status).toBe(
      404
    )
    expect((await app.fetch(jsonRequest(path, "POST", body, owner.csrfHeaders))).status).toBe(409)
    const visible = await app.fetch(
      new Request("http://localhost/api/agent-threads/recovery", { headers: owner.headers })
    )
    expect(await visible.text()).not.toContain("private-owner-token")
    await storage.agents.runs.finish({
      projectId: sixb.id,
      id: "recovery-run",
      executionToken: "private-owner-token",
      status: "failed",
    })
    const response = await app.fetch(jsonRequest(path, "POST", body, owner.csrfHeaders))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sandboxParams: { clientId: "acme" },
      sandboxState: { status: "new", initialized: false },
    })
    expect((await app.fetch(jsonRequest(path, "POST", body, owner.csrfHeaders))).status).toBe(409)
  })

  test("round-trips validated workspace bindings and admits fresh workspace runs", async () => {
    const { app, storage, sixb } = createApp({ sandbox: true })
    const created = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", {
        threadId: "sandbox-thread",
        sandbox: { clientId: "acme" },
      })
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      thread: { sandboxParams: { clientId: "acme" } },
    })
    const list = await app.fetch(new Request("http://localhost/api/agent-threads"))
    expect(await list.json()).toMatchObject({
      threads: [{ sandboxParams: { clientId: "acme" } }],
    })
    const run = await app.fetch(
      jsonRequest("/api/agent-threads/sandbox-thread/messages", "POST", { text: "Work" })
    )
    expect(run.status).toBe(202)
    expect(
      (await storage.agents.messages.list({ projectId: sixb.id, threadId: "sandbox-thread" }))
        .messages
    ).toHaveLength(1)
  })

  test("validates dynamic sandbox params and rejects runtime fields", async () => {
    const { app, storage, sixb } = createApp({ sandbox: true })
    for (const sandbox of [
      {},
      { clientId: 42 },
      { clientId: "acme", other: true },
      { params: { clientId: "acme" }, env: { TOKEN: "secret" } },
    ]) {
      const response = await app.fetch(jsonRequest("/api/agent-threads", "POST", { sandbox }))
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    }
    expect((await storage.agents.threads.list({ projectId: sixb.id })).total).toBe(0)
    const disabled = createApp()
    expect(
      (await disabled.app.fetch(jsonRequest("/api/agent-threads", "POST", { sandbox: {} }))).status
    ).toBe(400)
  })
  test("rejects legacy selectors instead of silently retargeting a request", async () => {
    const { app, storage, sixb } = createApp()
    for (const request of [
      jsonRequest("/api/agent-threads", "POST", { agentId: "legacy" }),
      new Request("http://localhost/api/agent-threads?agentId=legacy"),
    ]) {
      const response = await app.fetch(request)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    }
    expect((await storage.agents.threads.list({ projectId: sixb.id })).total).toBe(0)
  })

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
      jsonRequest("/api/agent-threads", "POST", {}, agentOnly.csrfHeaders)
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
      jsonRequest("/api/agent-threads", "POST", {}, support.csrfHeaders)
    )
    const thread = (await threadResponse.json()) as { thread: { id: string } }
    const context = [
      {
        context: {
          kind: "object",
          ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
          label: "July maintenance",
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
      contentVersion: 2,
      parts: [
        { type: "context", ...context[0] },
        { type: "context", ...context[1] },
        { type: "text", text: "What should I do next?" },
      ],
    })
  })

  test.each([
    {
      name: "a blank object context label, naming the field",
      context: {
        kind: "object",
        ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
        label: "   ",
      },
      error: "[Sixb] Invalid agent context: context[0].context.label must be a non-empty string.",
    },
    {
      name: "a missing object context",
      context: { kind: "object", ref: { objectTypeId: "Invoice", primaryId: "missing" } },
      error:
        "[Sixb] Invalid agent context: context references an unknown object 'Invoice:missing'.",
    },
  ])("rejects $name before persisting a message or run", async ({ context, error }) => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-invalid-context",
      projectId: sixb.id,
      ownerPrincipal: { type: "system", id: "system" },
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/messages`, "POST", {
        text: "Check this invoice",
        context: [{ context, origin: "ambient" }],
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error, code: "invalid_context" })
    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: thread.id })
    ).resolves.toMatchObject({ total: 0 })
    await expect(
      storage.agents.runs.list({ projectId: sixb.id, threadId: thread.id })
    ).resolves.toMatchObject({ total: 0 })
  })

  test("describes the project Agent without exposing its executable configuration", async () => {
    const { app } = createApp()
    const response = await app.fetch(new Request("http://localhost/api/agent"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      name: "Sixb",
      model: { provider: "test", modelId: "test-model" },
    })
    for (const path of ["/api/agents", "/api/agents/assistant"]) {
      expect((await app.fetch(new Request(`http://localhost${path}`))).status).toBe(404)
    }
  })

  test("requires can.run(agent) to access the Agent", async () => {
    const { app, storage } = createApp({ auth: true })
    const support = await seedSession(storage, "usr_support", ["support-users"])
    const noAccess = await seedSession(storage, "usr_none", [])
    expect(
      (await app.fetch(new Request("http://localhost/api/agent", { headers: support.headers })))
        .status
    ).toBe(200)
    expect(
      (await app.fetch(new Request("http://localhost/api/agent", { headers: noAccess.headers })))
        .status
    ).toBe(404)
    expect(
      (
        await app.fetch(
          jsonRequest("/api/agent-threads", "POST", { title: "Denied" }, noAccess.csrfHeaders)
        )
      ).status
    ).toBe(404)
    expect(
      (
        await app.fetch(
          jsonRequest("/api/agent-threads", "POST", { title: "Allowed" }, support.csrfHeaders)
        )
      ).status
    ).toBe(201)
  })

  test("creates a thread, posts a message, and exposes a durable queued run", async () => {
    const { app, storage, sixb } = createApp()

    const createThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", {
        title: "Pipeline check",
      })
    )
    expect(createThreadResponse.status).toBe(201)
    const createThreadBody = (await createThreadResponse.json()) as {
      thread: { id: string; ownerPrincipal: unknown; title: string }
    }
    expect(createThreadBody.thread.title).toBe("Pipeline check")
    expect(createThreadBody.thread).not.toHaveProperty("agentId")
    expect(createThreadBody.thread.ownerPrincipal).toEqual({ type: "system", id: "system" })

    const listThreadsResponse = await app.fetch(
      new Request("http://localhost/api/agent-threads?limit=5")
    )
    expect(listThreadsResponse.status).toBe(200)
    expect(await listThreadsResponse.json()).toMatchObject({
      total: 1,
      hasMore: false,
      threads: [{ id: createThreadBody.thread.id, messageCount: 0 }],
    })

    const attachment = await sixb.blobStorage.put({
      body: new TextEncoder().encode("pipeline log contents"),
      fileName: "pipeline.log",
      mediaType: "text/plain",
    })
    // Regression proof: drop assertAttachments from requestAgentRun; the message is accepted.
    const invalidAttachmentResponse = await app.fetch(
      jsonRequest(`/api/agent-threads/${createThreadBody.thread.id}/messages`, "POST", {
        text: "Check the failed pipeline.",
        attachments: [{ ...attachment, mediaType: "text/plain,text/html" }],
      })
    )
    expect(invalidAttachmentResponse.status).toBe(400)
    expect(await invalidAttachmentResponse.json()).toEqual({
      error: "[Sixb] Attachment 0 is not a valid file reference.",
      code: "invalid_attachment",
    })
    // Strict on browser hints, naming the field and the code clients retry on.
    const invalidZoneResponse = await app.fetch(
      jsonRequest(`/api/agent-threads/${createThreadBody.thread.id}/messages`, "POST", {
        text: "Check the failed pipeline.",
        timeZone: "Etc/Unknown",
      })
    )
    expect(invalidZoneResponse.status).toBe(400)
    expect(await invalidZoneResponse.json()).toEqual({
      error: `[Sixb] Agent request 'timeZone' must be an IANA time zone; received "Etc/Unknown".`,
      code: "invalid_locale",
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
    expect(postMessageBody.run).not.toHaveProperty("agentId")

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
      jsonRequest("/api/agent-threads", "POST", { threadId: "thr-dup" })
    )
    expect(first.status).toBe(201)

    const second = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { threadId: "thr-dup" })
    )
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: string }
    expect(body.error).toBe("Agent thread already exists")
    // The generic message must not leak the raw provider message (id / project / [SixbHost*] prefix).
    expect(body.error).not.toContain("thr-dup")
    expect(body.error).not.toContain("[SixbHost")
  })

  test("projects a run's diagnostics and context checkpoint onto its durable assistant message", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thr-compaction",
      projectId: sixb.id,
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
      triggerMessageId: "msg-current-user",
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
    const diagnostics = [
      {
        code: "step_limit_reached" as const,
        severity: "warning" as const,
        scope: "run" as const,
        message: "The Agent reached its 100-step limit before producing a final answer.",
      },
    ]
    await storage.agents.runs.finish({
      id: "run-compaction",
      projectId: sixb.id,
      executionToken,
      status: "succeeded",
      diagnostics,
    })

    const response = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`)
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      messages: { id: string; parts: unknown[]; annotations: unknown[]; compaction?: unknown }[]
    }
    // Diagnostics are annotations beside the parts, never edits to them.
    expect(body.messages.find((message) => message.id === "msg-compacted-response")).toEqual(
      expect.objectContaining({
        parts: [{ type: "text", text: "Here is the completed research." }],
        annotations: diagnostics,
        compaction: {
          checkpointId: checkpoint.id,
          summary: checkpoint.summary,
          createdAt: checkpoint.createdAt.toISOString(),
        },
      })
    )
    expect(
      body.messages.filter(
        (message) =>
          message.id !== "msg-compacted-response" &&
          ("compaction" in message || message.annotations.length > 0)
      )
    ).toEqual([])

    const runResponse = await app.fetch(
      new Request("http://localhost/api/agent-runs/run-compaction")
    )
    expect(runResponse.status).toBe(200)
    expect(await runResponse.json()).toMatchObject({ diagnostics })
  })

  test("returns 409 when posting to a thread with an active run", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-active",
      projectId: sixb.id,
      ownerPrincipal: { type: "system", id: "system" },
    })
    await createStartedRun(storage, {
      id: "run-active",
      projectId: sixb.id,
      threadId: thread.id,
      triggerMessageId: "msg-existing",
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

  test("returns a coded 429 and retry time for an exhausted AI usage limit", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-limit-exhausted",
      projectId: sixb.id,
      ownerPrincipal: { type: "system", id: "system" },
    })
    await storage.aiLimits.createPolicy({
      id: "project_tokens_exhausted",
      projectId: sixb.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 0 },
    })

    const response = await app.fetch(
      jsonRequest(`/api/agent-threads/${thread.id}/messages`, "POST", { text: "blocked" })
    )

    expect(response.status).toBe(429)
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(0)
    const responseBody = await response.json()
    expect(responseBody).toMatchObject({
      code: "ai.usage_limit_exceeded",
      details: {
        resetAt: expect.any(String),
      },
    })
    expect(responseBody.details).not.toHaveProperty("policies")
    await expect(
      storage.agents.messages.list({ projectId: sixb.id, threadId: thread.id })
    ).resolves.toMatchObject({ messages: [], total: 0 })
  })

  test("cancels a queued run before a worker starts it", async () => {
    const { app, storage, sixb } = createApp()
    const request = await createTestSixb(sixb).agent.runs.request({
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
    const request = await createTestSixb(sixb).agent.runs.request({
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

  test("accepts a continuation flag in place of text, and neither is rejected", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const session = await seedSession(storage, "usr_continue", ["support-users"])
    const created = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", {}, session.csrfHeaders)
    )
    const { thread } = (await created.json()) as { thread: { id: string } }
    const post = (body: unknown) =>
      app.fetch(
        jsonRequest(`/api/agent-threads/${thread.id}/messages`, "POST", body, session.csrfHeaders)
      )

    expect((await post({})).status).toBe(400)
    const continued = await post({ continue: true })
    expect(continued.status).toBe(202)
    const { run } = (await continued.json()) as { run: { triggerMessageId: string } }
    await expect(
      storage.agents.messages.getById({ projectId: sixb.id, id: run.triggerMessageId })
    ).resolves.toMatchObject({ parts: [{ type: "continuation" }] })
  })

  test("retries a failed run with a fresh attribution snapshot and the same trigger", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const session = await seedSession(storage, "usr_retry", ["support-users", "admins"])
    const createThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", {}, session.csrfHeaders)
    )
    expect(createThreadResponse.status).toBe(201)
    const thread = (await createThreadResponse.json()) as { thread: { id: string } }
    const messageResponse = await app.fetch(
      jsonRequest(
        `/api/agent-threads/${thread.thread.id}/messages`,
        "POST",
        { text: "try this", reasoning: "medium", timeZone: "Europe/Paris", locale: "fr-FR" },
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
      spec: {
        model: { provider: "test", modelId: "test-model" },
        reasoning: "medium",
        timeZone: "Europe/Paris",
        locale: "fr-FR",
      },
    })
    await expect(
      storage.executions.getById({ projectId: sixb.id, id: originalRun?.executionId ?? "" })
    ).resolves.toMatchObject({
      requestedBy: { type: "user", id: "usr_retry" },
      requesterGroupIds: ["admins", "support-users"],
    })
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
      spec: originalRun?.spec,
    })
    await expect(
      storage.executions.getById({ projectId: sixb.id, id: retriedRun?.executionId ?? "" })
    ).resolves.toMatchObject({
      requestedBy: { type: "user", id: "usr_retry" },
      requesterGroupIds: ["ops-users", "support-users"],
    })

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
    const first = await createTestSixb(sixb).agent.runs.request({
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

    const second = await createTestSixb(sixb).agent.runs.request({
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

  test("retries an interrupted run but not one that was stopped", async () => {
    const { app, storage, sixb } = createApp()
    const retry = async (finishReason: "interrupted" | undefined) => {
      const request = await createTestSixb(sixb).agent.runs.request({ text: "resume me" })
      const execution = testExecution()
      await storage.agents.runs.start({ id: request.run.id, projectId: sixb.id, execution })
      await storage.agents.runs.finish({
        id: request.run.id,
        projectId: sixb.id,
        executionToken: execution.token,
        status: "cancelled",
        ...(finishReason === undefined ? {} : { finishReason }),
      })
      return app.fetch(
        jsonRequest(
          `/api/agent-threads/${request.run.threadId}/runs/${request.run.id}/retry`,
          "POST",
          {}
        )
      )
    }

    const stopped = await retry(undefined)
    expect(stopped.status).toBe(409)
    await expect(stopped.json()).resolves.toEqual({
      error: "Only failed or interrupted agent runs can be retried",
    })

    const interrupted = await retry("interrupted")
    expect(interrupted.status).toBe(202)
    await expect(interrupted.json()).resolves.toMatchObject({ run: { status: "queued" } })
  })

  test("reads agent runs without exposing execution tokens", async () => {
    const { app, storage, sixb } = createApp()
    const thread = await storage.agents.threads.create({
      id: "thread-run",
      projectId: sixb.id,
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage, {
      id: "run-readable",
      projectId: sixb.id,
      threadId: thread.id,
      triggerMessageId: "msg-user",
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
    expect(body).not.toHaveProperty("agentId")

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
      ownerPrincipal: { type: "system", id: "system" },
    })
    const firstExecutionId = await createTestAgentExecution(storage, {
      projectId: sixb.id,
      runId: "run-list-1",
    })
    await storage.agents.runs.create({
      id: "run-list-1",
      projectId: sixb.id,
      executionId: firstExecutionId,
      threadId: thread.id,
      triggerMessageId: "msg-list-1",
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    await storage.agents.runs.finishQueued({
      id: "run-list-1",
      projectId: sixb.id,
      status: "cancelled",
    })
    const secondExecutionId = await createTestAgentExecution(storage, {
      projectId: sixb.id,
      runId: "run-list-2",
    })
    await storage.agents.runs.create({
      id: "run-list-2",
      projectId: sixb.id,
      executionId: secondExecutionId,
      threadId: thread.id,
      triggerMessageId: "msg-list-2",
      spec: { model: { provider: "test", modelId: "test-model" } },
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
      ownerPrincipal: { type: "system", id: "system" },
    })
    const run = await createStartedRun(storage, {
      id: "run-cancel",
      projectId: sixb.id,
      threadId: thread.id,
      triggerMessageId: "msg-user",
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
    // Guard proof: declare the 409 with ErrorResponseSchema; Elysia then strips the code.
    expect(await finished.json()).toMatchObject({ code: "run_not_active" })

    // A run that belongs to another thread cannot be cancelled through this one.
    const otherThread = await storage.agents.threads.create({
      id: "thread-other",
      projectId: sixb.id,
      ownerPrincipal: { type: "system", id: "system" },
    })
    const otherRun = await createStartedRun(storage, {
      id: "run-other",
      projectId: sixb.id,
      threadId: otherThread.id,
      triggerMessageId: "msg-other",
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
      jsonRequest("/api/agent-threads", "POST", { title: "Owner thread" }, owner.csrfHeaders)
    )
    const otherThreadResponse = await app.fetch(
      jsonRequest("/api/agent-threads", "POST", { title: "Other thread" }, other.csrfHeaders)
    )
    expect(ownerThreadResponse.status).toBe(201)
    expect(otherThreadResponse.status).toBe(201)
    const ownerThread = (await ownerThreadResponse.json()) as { thread: { id: string } }
    const otherThread = (await otherThreadResponse.json()) as { thread: { id: string } }
    await storage.agents.threads.create({
      id: "owner-ops-thread",
      projectId: sixb.id,
      ownerPrincipal: { type: "user", id: "usr_owner" },
      title: "Existing conversation",
    })

    const ownerList = await app.fetch(
      new Request("http://localhost/api/agent-threads", { headers: owner.headers })
    )
    expect(ownerList.status).toBe(200)
    expect(await ownerList.json()).toMatchObject({
      total: 2,
      threads: expect.arrayContaining(
        [{ id: "owner-ops-thread" }].map((item) => expect.objectContaining(item))
      ),
    })

    const hiddenOwnedThread = await app.fetch(
      new Request("http://localhost/api/agent-threads/owner-ops-thread", {
        headers: owner.headers,
      })
    )
    expect(hiddenOwnedThread.status).toBe(200)
    expect(await hiddenOwnedThread.json()).toMatchObject({ id: "owner-ops-thread" })

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

  test("forks a readable thread into the caller's own, files and diagnostics included", async () => {
    // Removal proof: keep only the thread's own runs in readThreadMessages' diagnostics lookup;
    // the copied answer loses its step-limit annotation.
    const { app, storage, sixb } = createApp({ auth: true })
    const owner = await seedSession(storage, "usr_owner")
    const other = await seedSession(storage, "usr_other")

    const attachment = await sixb.blobStorage.put({
      body: new TextEncoder().encode("pipeline export"),
      fileName: "pipeline.csv",
      mediaType: "text/csv",
    })
    await storage.agents.threads.create({
      id: "deals",
      projectId: sixb.id,
      ownerPrincipal: { type: "user", id: "usr_owner" },
      title: "Slipped deals",
    })
    await storage.agents.messages.append({
      id: "question",
      projectId: sixb.id,
      threadId: "deals",
      runId: null,
      role: "user",
      parts: [
        { type: "text", text: "Which deals slipped?" },
        { type: "file", fileRef: attachment },
      ],
    })

    const executionToken = createAgentRunExecutionToken()
    await createStartedRun(storage, {
      id: "run-answered",
      projectId: sixb.id,
      threadId: "deals",
      triggerMessageId: "question",
      execution: testExecution(executionToken),
    })
    await storage.agents.messages.append({
      id: "answer",
      projectId: sixb.id,
      threadId: "deals",
      runId: "run-answered",
      role: "assistant",
      parts: [{ type: "text", text: "Acme and Globex." }],
    })
    const diagnostics = [
      {
        code: "step_limit_reached" as const,
        severity: "warning" as const,
        scope: "run" as const,
        message: "The Agent reached its 100-step limit before producing a final answer.",
      },
    ]
    await storage.agents.runs.finish({
      id: "run-answered",
      projectId: sixb.id,
      executionToken,
      status: "succeeded",
      diagnostics,
    })

    // A turn still running stays behind.
    const running = await app.fetch(
      jsonRequest("/api/agent-threads/deals/messages", "POST", { text: "Why?" }, owner.csrfHeaders)
    )
    expect(running.status).toBe(202)

    const hidden = await app.fetch(
      jsonRequest("/api/agent-threads/deals/fork", "POST", {}, other.csrfHeaders)
    )
    expect(hidden.status).toBe(404)

    const response = await app.fetch(
      jsonRequest("/api/agent-threads/deals/fork", "POST", {}, owner.csrfHeaders)
    )
    expect(response.status).toBe(201)
    const { thread } = (await response.json()) as { thread: { id: string } }
    expect(thread).toMatchObject({
      ownerPrincipal: { type: "user", id: "usr_owner" },
      title: "Slipped deals",
      activeRunId: null,
      messageCount: 2,
    })

    const messages = await app.fetch(
      new Request(`http://localhost/api/agent-threads/${thread.id}/messages`, {
        headers: owner.headers,
      })
    )
    const { messages: copied } = (await messages.json()) as {
      messages: { id: string; runId: string | null; annotations: unknown[] }[]
    }
    expect(copied.map((message) => message.runId)).toEqual([null, "run-answered"])
    expect(copied[0]?.id).not.toBe("question")
    expect(copied[1]?.annotations).toEqual(diagnostics)

    const file = await app.fetch(
      new Request(
        `http://localhost/api/agent-threads/${thread.id}/messages/${copied[0]?.id}/files/content?path=${encodeURIComponent("/parts/1/fileRef")}`,
        { headers: owner.headers }
      )
    )
    expect(file.status).toBe(200)
    expect(await file.text()).toBe("pipeline export")
  })
})

describe("a thread's participants over HTTP", () => {
  // Guard proof: return null for "participant" in createAgentThreadAccessRule; Bob then gets 404
  // on every read below.
  test("a participant reads and talks in the thread; anyone else gets 404", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const alice = await seedSession(storage, "usr_alice")
    const bob = await seedSession(storage, "usr_bob")
    const cleo = await seedSession(storage, "usr_cleo")
    await storage.auth.users.updateProfile({
      projectId: sixb.id,
      id: "usr_alice",
      displayName: "Alice Martin",
    })

    const get = (path: string, as: { headers: Record<string, string> }) =>
      app.fetch(new Request(`http://localhost${path}`, { headers: as.headers }))
    const post = (path: string, body: unknown, as: { csrfHeaders: Record<string, string> }) =>
      app.fetch(jsonRequest(path, "POST", body, as.csrfHeaders))
    const remove = (path: string, as: { csrfHeaders: Record<string, string> }) =>
      app.fetch(
        new Request(`http://localhost${path}`, { method: "DELETE", headers: as.csrfHeaders })
      )

    const created = await post("/api/agent-threads", { title: "Late deals" }, alice)
    const { thread } = (await created.json()) as { thread: { id: string } }
    const path = `/api/agent-threads/${thread.id}`

    const attachment = await sixb.blobStorage.put({
      body: new TextEncoder().encode("deals.csv"),
      fileName: "deals.csv",
      mediaType: "text/plain",
    })
    const asked = await post(
      `${path}/messages`,
      { text: "Which slipped?", attachments: [attachment] },
      alice
    )
    const { run: alicesRun } = (await asked.json()) as {
      run: { id: string; triggerMessageId: string }
    }

    // Only the owner shares, and only with an active user.
    expect(
      (await post(`${path}/participants`, { users: [{ type: "user", id: "usr_bob" }] }, cleo))
        .status
    ).toBe(404)
    expect(
      (await post(`${path}/participants`, { users: [{ type: "user", id: "usr_nobody" }] }, alice))
        .status
    ).toBe(400)
    const unknownEmail = await post(
      `${path}/participants`,
      { users: [{ email: "nobody@acme.com" }] },
      alice
    )
    expect(unknownEmail.status).toBe(400)
    expect(await unknownEmail.json()).toMatchObject({
      code: "invalid_participant",
      error:
        "[Sixb] Agent thread participant references user 'nobody@acme.com', which does not exist.",
    })

    // By email, as someone who cannot browse the members directory would; each comes back named.
    // Guard proof: serialize `participant.principal` unnamed in serializeThreads; Bob then has
    // no display name.
    await storage.auth.users.updateProfile({
      projectId: sixb.id,
      id: "usr_bob",
      displayName: "Bob Stone",
    })
    const shared = await post(
      `${path}/participants`,
      { users: [{ email: "USR_BOB@acme.com" }] },
      alice
    )
    expect(shared.status).toBe(200)
    const sharedBody = await shared.json()
    expect(sharedBody).toMatchObject({
      id: thread.id,
      owner: { type: "user", id: "usr_alice", displayName: "Alice Martin" },
      participants: [
        {
          principal: { type: "user", id: "usr_bob", displayName: "Bob Stone" },
          addedBy: { type: "user", id: "usr_alice" },
        },
      ],
    })
    expect(JSON.stringify(sharedBody)).not.toContain("@acme.com")
    expect(
      (await post(`${path}/participants`, { users: [{ type: "user", id: "usr_cleo" }] }, bob))
        .status
    ).toBe(403)

    // Bob reads it all, and finds it among the threads shared with him.
    expect((await get(path, bob)).status).toBe(200)
    expect(await (await get("/api/agent-threads?sharedWithMe=true", bob)).json()).toMatchObject({
      threads: [{ id: thread.id }],
      total: 1,
    })
    expect(await (await get("/api/agent-threads", bob)).json()).toMatchObject({ total: 0 })

    const messages = await get(`${path}/messages`, bob)
    expect(messages.status).toBe(200)
    expect(await messages.json()).toMatchObject({
      messages: [{ authorPrincipal: { type: "user", id: "usr_alice" } }],
      authors: [{ type: "user", id: "usr_alice", displayName: "Alice Martin" }],
    })
    const file = `${path}/messages/${alicesRun.triggerMessageId}/files/content?path=${encodeURIComponent("/parts/1/fileRef")}`
    expect(await (await get(file, bob)).text()).toBe("deals.csv")
    expect((await get(`${path}/runs`, bob)).status).toBe(200)
    expect((await get(`/api/agent-runs/${alicesRun.id}`, bob)).status).toBe(200)

    // One turn at a time; Bob stops only his own turns, Alice any.
    expect((await post(`${path}/messages`, { text: "Why?" }, bob)).status).toBe(409)
    const notBobs = await post(`${path}/cancel`, { runId: alicesRun.id }, bob)
    expect(notBobs.status).toBe(403)
    expect(await notBobs.json()).toMatchObject({ code: "not_run_requester" })
    expect((await post(`${path}/cancel`, { runId: alicesRun.id }, alice)).status).toBe(202)

    const bobAsked = await post(`${path}/messages`, { text: "Why did Acme slip?" }, bob)
    expect(bobAsked.status).toBe(202)
    const { run: bobsRun } = (await bobAsked.json()) as { run: { id: string } }
    expect((await post(`${path}/cancel`, { runId: bobsRun.id }, bob)).status).toBe(202)

    // Only Bob retries his failed turn: it runs again with his rights, never the owner's.
    const failedAsk = await post(`${path}/messages`, { text: "And Globex?" }, bob)
    const { run: failed } = (await failedAsk.json()) as { run: { id: string } }
    await storage.agents.runs.finishQueued({ projectId: sixb.id, id: failed.id, status: "failed" })
    const ownerRetry = await post(`${path}/runs/${failed.id}/retry`, {}, alice)
    expect(ownerRetry.status).toBe(403)
    expect(await ownerRetry.json()).toMatchObject({ code: "not_run_requester" })
    const retried = await post(`${path}/runs/${failed.id}/retry`, {}, bob)
    expect(retried.status).toBe(202)
    const { run: retry } = (await retried.json()) as { run: { id: string } }
    expect((await post(`${path}/cancel`, { runId: retry.id }, alice)).status).toBe(202)

    // The sandbox is the owner's to recreate.
    const recreate = `${path}/sandbox/recreate`
    const bobRecreates = await post(recreate, { expectedSandboxName: "any" }, bob)
    expect(bobRecreates.status).toBe(403)
    expect(await bobRecreates.json()).toMatchObject({ code: "not_thread_owner" })
    expect((await post(recreate, { expectedSandboxName: "any" }, cleo)).status).toBe(404)

    // Cleo sees nothing of it.
    for (const hidden of [
      path,
      `${path}/messages`,
      `${path}/runs`,
      file,
      `/api/agent-runs/${bobsRun.id}`,
    ]) {
      expect((await get(hidden, cleo)).status).toBe(404)
    }
    expect((await post(`${path}/messages`, { text: "Me too" }, cleo)).status).toBe(404)
    expect((await post(`${path}/cancel`, { runId: bobsRun.id }, cleo)).status).toBe(404)
    expect(await (await get("/api/agent-threads?sharedWithMe=true", cleo)).json()).toMatchObject({
      total: 0,
    })

    // Bob removes only himself; once he left, the thread is gone for him.
    expect((await remove(`${path}/participants/usr_alice`, bob)).status).toBe(400)
    expect((await remove(`${path}/participants/usr_cleo`, bob)).status).toBe(403)
    expect((await remove(`${path}/participants/usr_bob`, cleo)).status).toBe(404)
    const left = await remove(`${path}/participants/usr_bob`, bob)
    expect(left.status).toBe(204)
    expect(await left.text()).toBe("")
    expect((await get(path, bob)).status).toBe(404)
  })

  test("a participant forks the thread into their own; once removed, they get 404", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const alice = await seedSession(storage, "usr_alice")
    const bob = await seedSession(storage, "usr_bob")
    await storage.auth.users.updateProfile({
      projectId: sixb.id,
      id: "usr_bob",
      displayName: "Bob Durand",
    })

    const post = (path: string, body: unknown, as: { csrfHeaders: Record<string, string> }) =>
      app.fetch(jsonRequest(path, "POST", body, as.csrfHeaders))

    const created = await post("/api/agent-threads", { title: "Late deals" }, alice)
    const { thread } = (await created.json()) as { thread: { id: string } }
    const path = `/api/agent-threads/${thread.id}`
    expect((await post(`${path}/messages`, { text: "Which slipped?" }, alice)).status).toBe(202)
    expect(
      (await post(`${path}/participants`, { users: [{ type: "user", id: "usr_bob" }] }, alice))
        .status
    ).toBe(200)

    const forked = await post(`${path}/fork`, {}, bob)
    expect(forked.status).toBe(201)
    expect(await forked.json()).toMatchObject({
      thread: {
        ownerPrincipal: { type: "user", id: "usr_bob" },
        owner: { type: "user", id: "usr_bob", displayName: "Bob Durand" },
        title: "Late deals",
        participants: [],
        // Alice's question is still being answered: it stays behind.
        messageCount: 0,
      },
    })

    const removed = await app.fetch(
      new Request(`http://localhost${path}/participants/usr_bob`, {
        method: "DELETE",
        headers: alice.csrfHeaders,
      })
    )
    expect(removed.status).toBe(204)
    expect((await post(`${path}/fork`, {}, bob)).status).toBe(404)
  })
})

describe("a shared conversation's artifacts over HTTP", () => {
  // Guard proof: make createArtifactAccessRule return "none" past the owner check; Bob then gets
  // 403 not_shared for the thread's artifact too.
  test("a participant reads and updates them; anyone else is told they are not shared", async () => {
    const { app, storage, sixb } = createApp({ auth: true })
    const alice = { type: "user", id: "usr_alice" } as const
    await seedSession(storage, "usr_alice")
    const bob = await seedSession(storage, "usr_bob")
    const cleo = await seedSession(storage, "usr_cleo")

    await storage.agents.threads.create({
      projectId: sixb.id,
      id: "thr_shared",
      ownerPrincipal: alice,
    })
    await storage.agents.threads.addParticipants({
      projectId: sixb.id,
      threadId: "thr_shared",
      principals: [{ type: "user", id: "usr_bob" }],
      addedBy: alice,
      maxParticipants: 50,
    })
    const file = await sixb.blobStorage.put({
      body: new TextEncoder().encode("# Late deals"),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const version = {
      title: "Late deals",
      entry: "document.md",
      files: [{ path: "document.md", file }],
      outline: { kind: "document" as const, headings: [] },
      references: [],
      author: alice,
      createdAt: new Date(),
    }
    await storage.artifacts.create({
      projectId: sixb.id,
      id: "art_0000000001",
      kind: "document",
      owner: alice,
      version: { ...version, origin: { threadId: "thr_shared", runId: "run_shared" } },
    })
    await storage.artifacts.create({
      projectId: sixb.id,
      id: "art_0000000002",
      kind: "document",
      owner: alice,
      version: { ...version, title: "Private notes" },
    })

    const call = (
      path: string,
      as: Awaited<ReturnType<typeof seedSession>>,
      init: RequestInit = {}
    ) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: init.method ? as.csrfHeaders : as.headers,
        })
      )

    const read = await call("/api/artifacts/art_0000000001", bob)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ artifact: { owner: alice }, access: "update" })

    const saved = await call("/api/artifacts/art_0000000001/versions", bob, {
      method: "POST",
      body: JSON.stringify({
        kind: "document",
        title: "Bob's edit",
        files: [{ path: "document.md", file }],
      }),
    })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({
      artifact: { owner: alice, latestVersion: 2 },
      version: { author: { type: "user", id: "usr_bob" } },
    })
    const kept = await call("/api/artifacts/art_0000000001/state/filters", bob, {
      method: "PUT",
      body: JSON.stringify({ value: { region: "EMEA" } }),
    })
    expect(kept.status).toBe(200)

    const removed = await call("/api/artifacts/art_0000000001", bob, { method: "DELETE" })
    expect(removed.status).toBe(403)
    expect(await removed.json()).toMatchObject({ code: "not_allowed" })

    const listed = await call("/api/artifacts?thread=thr_shared", bob)
    expect((await listed.json()).artifacts.map((each: { id: string }) => each.id)).toEqual([
      "art_0000000001",
    ])

    for (const [path, as] of [
      ["/api/artifacts/art_0000000002", bob],
      ["/api/artifacts/art_0000000001", cleo],
      ["/api/artifacts/art_0000000001/versions/latest", cleo],
    ] as const) {
      const refused = await call(path, as)
      expect(refused.status, path).toBe(403)
      expect(await refused.json()).toMatchObject({ code: "not_shared" })
    }
    expect((await call("/api/artifacts/art_0000000009", bob)).status).toBe(404)
  })
})
