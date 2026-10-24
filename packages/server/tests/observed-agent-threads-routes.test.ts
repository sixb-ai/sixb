import { describe, expect, test } from "bun:test"
import type { LanguageModel } from "@sixb/core"
import {
  agent,
  can,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  SixbHost,
} from "@sixb/core"
import { createAccessTokenCredential, createSessionCredential } from "@sixb/core/internal/auth"
import { createTestAgentExecution } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Route tests register the binding but never invoke the provider.
const model = {
  providerId: "test",
  modelId: "test-model",
  definition: { kind: "language", providerId: "test", modelId: "test-model", capabilities: {} },
  stream: async () => {
    throw new Error("Must not invoke the route test model")
  },
} satisfies LanguageModel

const runners = defineGroup("runners")
const threadObservers = defineGroup("thread-observers")
const activityObservers = defineGroup("activity-observers")
const roles = [
  defineRole("runner", { grantedTo: [runners], grants: [can.run(agent)] }),
  defineRole("thread-observer", {
    grantedTo: [threadObservers],
    grants: [can.observe(agent.threads)],
  }),
  defineRole("activity-observer", {
    grantedTo: [activityObservers],
    grants: [can.observe(project.activity)],
  }),
]

const projectId = "observed-agent-threads"

function createFixture() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [model] },
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    groups: [runners, threadObservers, activityObservers],
    roles,
    auth: { id: "test", kind: "dev" },
    activity: { enabled: true },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  /** A browser session for a new user in these groups: its cookie, and a mutation's CSRF pair. */
  async function browser(userId: string, groupIds: readonly string[], displayName?: string) {
    await storage.auth.users.create({
      projectId,
      id: userId,
      email: `${userId}@example.test`,
      ...(displayName ? { displayName } : {}),
    })
    for (const groupId of groupIds) {
      await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
    }

    const credential = createSessionCredential(`ses_${userId}`)
    await storage.auth.sessions.create({
      projectId,
      id: credential.sessionId,
      userId,
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf-token`,
      origin: "http://app.localhost",
      "x-sixb-csrf": "csrf-token",
    }
  }

  function request(
    path: string,
    headers: Record<string, string>,
    init: { readonly method?: string; readonly body?: unknown } = {}
  ) {
    return app.fetch(
      new Request(`http://api.localhost${path}`, {
        method: init.method ?? "GET",
        headers: { ...headers, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    )
  }

  /** Marie's conversation: her question with a file, and the run it started. */
  async function seedConversation() {
    const fileRef = await blobStorage.put({
      body: new TextEncoder().encode("late invoices"),
      fileName: "late.csv",
      mediaType: "text/csv",
    })
    await storage.agents.threads.create({
      projectId,
      id: "thr_marie",
      ownerPrincipal: { type: "user", id: "marie" },
      title: "Overdue invoices",
    })
    await storage.agents.messages.append({
      projectId,
      id: "msg_marie",
      threadId: "thr_marie",
      runId: null,
      role: "user",
      authorPrincipal: { type: "user", id: "marie" },
      parts: [
        { type: "text", text: "Which invoices are late?" },
        { type: "file", fileRef },
      ],
    })
    const executionId = await createTestAgentExecution(storage, { projectId, runId: "run_marie" })
    await storage.agents.runs.create({
      projectId,
      id: "run_marie",
      threadId: "thr_marie",
      executionId,
      triggerMessageId: "msg_marie",
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
  }

  /** A personal access token for a new user in these groups. */
  async function accessToken(userId: string, groupIds: readonly string[]) {
    await storage.auth.users.create({ projectId, id: userId, email: `${userId}@example.test` })
    for (const groupId of groupIds) {
      await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
    }

    const credential = createAccessTokenCredential("personal", `tok_${userId}`)
    await storage.auth.accessTokens.create({
      id: credential.tokenId,
      projectId,
      name: "Observer token",
      kind: "personal",
      subject: { type: "user", id: userId },
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return { authorization: `Bearer ${credential.tokenValue}` }
  }

  /** Marie's document: version 1 from her conversation, version 2 from code. */
  async function seedArtifact() {
    const file = await blobStorage.put({
      body: new TextEncoder().encode("# Late invoices"),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const version = {
      entry: "document.md",
      files: [{ path: "document.md", file }],
      outline: { kind: "document" as const, headings: [] },
      references: [],
      author: { type: "user" as const, id: "marie" },
      createdAt: new Date(),
    }
    await storage.artifacts.create({
      projectId,
      id: "art_0000000001",
      kind: "document",
      owner: { type: "user", id: "marie" },
      version: {
        ...version,
        title: "Late invoices",
        origin: { threadId: "thr_marie", runId: "run_marie" },
      },
    })
    await storage.artifacts.publish({
      projectId,
      artifactId: "art_0000000001",
      kind: "document",
      version: { ...version, title: "Edited from code" },
    })
    return file
  }

  return { app, storage, browser, request, accessToken, seedConversation, seedArtifact }
}

describe("observed agent thread routes", () => {
  // Guard proof: register the observed routes with `sixb.agent.threads.getById` instead of
  // `sixb.agent.observed.getById`; the observer then gets 404 everywhere.
  test("an observer reads another user's conversation, with its authors and files", async () => {
    const fixture = createFixture()
    await fixture.browser("marie", [runners.id], "Marie Curie")
    const observer = await fixture.browser("olivia", [threadObservers.id])
    await fixture.seedConversation()

    const thread = await fixture.request("/api/observed-agent-threads/thr_marie", observer)
    expect(thread.status).toBe(200)
    expect(await thread.json()).toMatchObject({
      id: "thr_marie",
      ownerPrincipal: { type: "user", id: "marie" },
      title: "Overdue invoices",
    })

    const messages = await fixture.request(
      "/api/observed-agent-threads/thr_marie/messages",
      observer
    )
    expect(await messages.json()).toMatchObject({
      total: 1,
      messages: [{ id: "msg_marie", authorPrincipal: { type: "user", id: "marie" } }],
      authors: [{ type: "user", id: "marie", displayName: "Marie Curie" }],
    })

    const runs = await fixture.request("/api/observed-agent-threads/thr_marie/runs", observer)
    expect(await runs.json()).toMatchObject({ runs: [{ id: "run_marie", status: "queued" }] })

    const path = encodeURIComponent("/parts/1/fileRef")
    const file = await fixture.request(
      `/api/observed-agent-threads/thr_marie/messages/msg_marie/files/content?path=${path}`,
      observer
    )
    expect(file.status).toBe(200)
    expect(await file.text()).toBe("late invoices")

    const missing = await fixture.request("/api/observed-agent-threads/thr_missing", observer)
    expect(missing.status).toBe(404)
  })

  // Guard proof: drop the assertAuthorized call in createObservedAgentThreadsRuntime; the owner
  // and the activity observer then read these routes.
  test("takes can.observe(agent.threads): neither the owner nor activity alone is enough", async () => {
    const fixture = createFixture()
    const owner = await fixture.browser("marie", [runners.id])
    const activity = await fixture.browser("arthur", [activityObservers.id, runners.id])
    await fixture.seedConversation()

    for (const headers of [owner, activity]) {
      for (const path of [
        "",
        "/messages",
        "/runs",
        "/messages/msg_marie/files/content?path=%2Fparts%2F1%2FfileRef",
      ]) {
        const response = await fixture.request(
          `/api/observed-agent-threads/thr_marie${path}`,
          headers
        )
        expect(response.status).toBe(403)
        expect(JSON.stringify(await response.json())).not.toContain("Which invoices")
      }
    }

    expect((await fixture.request("/api/agent-threads/thr_marie", owner)).status).toBe(200)
  })

  test("an observer cannot write: the owner routes stay the owner's", async () => {
    const fixture = createFixture()
    const observer = await fixture.browser("olivia", [threadObservers.id, runners.id])
    await fixture.seedConversation()

    const writes = [
      ["/api/agent-threads/thr_marie/messages", { text: "Let me answer" }],
      ["/api/agent-threads/thr_marie/cancel", { runId: "run_marie" }],
      ["/api/agent-threads/thr_marie/runs/run_marie/retry", {}],
      ["/api/agent-threads/thr_marie/sandbox/recreate", { expectedSandboxName: "sandbox" }],
    ] as const
    for (const [path, body] of writes) {
      expect((await fixture.request(path, observer, { method: "POST", body })).status).toBe(404)
    }
    const listed = await (await fixture.request("/api/agent-threads", observer)).json()
    expect(listed.total).toBe(0)
    expect(
      (await fixture.storage.agents.messages.list({ projectId, threadId: "thr_marie" })).total
    ).toBe(1)
  })

  // Guard proof: drop `thread` from the Agent entry of ActivityTimelineEntrySchema; the observer's
  // timeline then loses the title.
  test("a visit's Agent run is titled and openable only with can.observe(agent.threads)", async () => {
    const fixture = createFixture()
    const marie = await fixture.browser("marie", [runners.id])
    const both = await fixture.browser("olivia", [activityObservers.id, threadObservers.id])
    const activity = await fixture.browser("arthur", [activityObservers.id])

    const capture = await fixture.request("/api/activity/events", marie, {
      method: "POST",
      body: { events: [{ id: "e1", type: "page.view", route: "/agents" }] },
    })
    expect(capture.status).toBe(200)
    const created = await fixture.request("/api/agent-threads", marie, {
      method: "POST",
      body: { title: "Overdue invoices" },
    })
    const { thread } = await created.json()
    const posted = await fixture.request(`/api/agent-threads/${thread.id}/messages`, marie, {
      method: "POST",
      body: { text: "Which invoices are late?" },
    })
    expect(posted.status).toBe(202)

    const range = `from=${new Date(Date.now() - 60_000).toISOString()}&to=${new Date(
      Date.now() + 60_000
    ).toISOString()}`
    const visits = await (await fixture.request(`/api/activity/visits?${range}`, both)).json()
    const timelineOf = async (headers: Record<string, string>) => {
      const response = await fixture.request(
        `/api/activity/visits/${visits.visits[0].id}/timeline`,
        headers
      )
      const timeline = await response.json()
      return timeline.entries.find((entry: { kind: string }) => entry.kind === "agent")
    }

    expect(await timelineOf(both)).toMatchObject({
      threadId: thread.id,
      thread: { title: "Overdue invoices" },
    })
    const withoutGrant = await timelineOf(activity)
    expect(withoutGrant).toMatchObject({ threadId: thread.id, messages: 1 })
    expect(withoutGrant).not.toHaveProperty("thread")
  })

  // Guard proofs: drop the `orObserved` fallback from artifactReader's `get`, and the observer gets
  // 404 for what its conversation published; drop the session check, and the access token reads it.
  // Guard proof: return "update" for an observer in createArtifactsRuntime's conversation rule;
  // the observer's publish and page data then go through.
  test("an observer reads every version of what a conversation shares, read-only, from a session", async () => {
    const fixture = createFixture()
    await fixture.browser("marie", [runners.id])
    const observer = await fixture.browser("olivia", [threadObservers.id])
    const activity = await fixture.browser("arthur", [activityObservers.id])
    const token = await fixture.accessToken("tess", [threadObservers.id])
    const file = await fixture.seedArtifact()

    // Shared whole: version 2, from code, is its latest for the observer too.
    const read = await fixture.request("/api/artifacts/art_0000000001", observer)
    expect(read.status).toBe(200)
    const body = await read.json()
    expect(body).toMatchObject({
      artifact: { latestVersion: 2, title: "Edited from code" },
      access: "read",
    })
    expect(body.versions.map((version: { version: number }) => version.version)).toEqual([2, 1])

    const content = await fixture.request(
      "/api/artifacts/art_0000000001/versions/1/content?path=document.md",
      observer
    )
    expect(await content.text()).toBe("# Late invoices")
    // Framing reads the version first: a document is refused for its kind, not as unknown.
    const frame = await fixture.request(
      "/api/artifacts/art_0000000001/versions/1/frame",
      observer,
      { method: "POST" }
    )
    expect(frame.status).toBe(409)

    // An observer only reads: no version, no page data, no delete.
    const publish = await fixture.request("/api/artifacts/art_0000000001/versions", observer, {
      method: "POST",
      body: { kind: "document", title: "Mine now", files: [{ path: "document.md", file }] },
    })
    expect(publish.status).toBe(403)
    expect(await publish.json()).toMatchObject({ code: "read_only" })
    const state = await fixture.request("/api/artifacts/art_0000000001/state", observer)
    expect(state.status).toBe(403)
    expect(await state.json()).toMatchObject({ code: "read_only" })
    const removed = await fixture.request("/api/artifacts/art_0000000001", observer, {
      method: "DELETE",
    })
    expect(removed.status).toBe(403)
    expect(
      (await fixture.storage.artifacts.get({ projectId, id: "art_0000000001" }))?.latestVersion
    ).toBe(2)

    // Neither activity alone nor an access token reads it.
    for (const headers of [activity, token]) {
      const refused = await fixture.request("/api/artifacts/art_0000000001", headers)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ code: "not_shared" })
    }
  })
})
