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
  SixbHost,
} from "@sixb/core"
import { createAgentRunExecutionToken } from "@sixb/core/internal/agents"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestAgentExecution } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// The inbox as the app drives it: what waits beside a running turn, changed, promoted, or withdrawn
// before the turn reads it.

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
} satisfies LanguageModel

const projectId = "agent-inbox-route-tests"
const users = defineGroup("inbox-users")
const runner = defineRole("inbox.agent-runner", { grantedTo: [users], grants: [can.run(agent)] })

function createApp() {
  const storage = new InMemoryStorage()
  const sixb = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [model] },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [users],
    roles: [runner],
    auth: { id: "test", kind: "dev" as const },
  })
  const app = createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, storage, sixb }
}

async function seedSession(storage: InMemoryStorage, userId: string) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId,
    email: `${userId}@acme.com`,
  })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId,
    groupId: users.id,
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-27T10:00:00.000Z"),
    expiresAt: new Date("2099-06-27T10:00:00.000Z"),
  })
  return {
    cookie: `sixb_session_app=${credential.cookieValue}`,
    csrf: {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

/**
 * A conversation whose turn runs: created and messaged over the API, then claimed, so the run
 * carries the owner as the person who asked for it.
 */
async function runningThread(
  app: ReturnType<typeof createApp>["app"],
  storage: InMemoryStorage,
  headers: { readonly cookie: string; readonly csrf: Record<string, string> }
): Promise<string> {
  const created = await app.handle(
    request("/api/agent-threads", "POST", { title: "Inbox" }, headers.csrf)
  )
  const threadId = ((await created.json()) as { thread: { id: string } }).thread.id

  const sent = await app.handle(
    request(
      `/api/agent-threads/${threadId}/messages`,
      "POST",
      { text: "Read the book." },
      headers.csrf
    )
  )
  const runId = ((await sent.json()) as { run: { id: string } }).run.id
  await storage.agents.runs.start({
    id: runId,
    projectId,
    execution: {
      token: createAgentRunExecutionToken(),
      queueLeaseExpiresAt: new Date(Date.now() + 60_000),
    },
  })
  return threadId
}

function request(path: string, method: string, body: unknown, headers: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("agent thread inbox routes", () => {
  test("a steered message waits, changes, and is withdrawn by the person who sent it", async () => {
    const { app, storage } = createApp()
    const owner = await seedSession(storage, "owner")
    const threadId = await runningThread(app, storage, owner)

    const sent = await app.handle(
      request(
        `/api/agent-threads/${threadId}/messages`,
        "POST",
        { text: "Check src/v2 instead.", delivery: "steer" },
        owner.csrf
      )
    )
    expect(sent.status).toBe(202)
    const body = (await sent.json()) as {
      run?: unknown
      item?: { id: string; mode: string; parts: { text?: string }[] }
    }
    expect(body.run).toBeUndefined()
    expect(body.item?.mode).toBe("steer")
    expect(body.item?.parts[0]?.text).toBe("Check src/v2 instead.")
    const itemId = body.item!.id

    const listed = await app.handle(
      request(`/api/agent-threads/${threadId}/inbox`, "GET", undefined, { cookie: owner.cookie })
    )
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { items: { id: string }[] }).items.map((item) => item.id)
    ).toEqual([itemId])

    const updated = await app.handle(
      request(
        `/api/agent-threads/${threadId}/inbox/${itemId}`,
        "PATCH",
        { text: "Read the fixtures too.", delivery: "queue", reasoning: "high" },
        owner.csrf
      )
    )
    expect(updated.status).toBe(200)
    const edited = (await updated.json()) as {
      item: { mode: string; parts: { text?: string }[]; spec?: { reasoning?: string } }
    }
    expect(edited.item.mode).toBe("queue")
    expect(edited.item.parts[0]?.text).toBe("Read the fixtures too.")
    expect(edited.item.spec?.reasoning).toBe("high")

    const withdrawn = await app.handle(
      request(`/api/agent-threads/${threadId}/inbox/${itemId}`, "DELETE", undefined, owner.csrf)
    )
    expect(withdrawn.status).toBe(204)
    expect(await storage.agents.inbox.list({ projectId, threadId })).toEqual([])
  })

  test("refuses another reader's steer with the code the client acts on", async () => {
    const { app, storage } = createApp()
    const owner = await seedSession(storage, "owner")
    const guest = await seedSession(storage, "guest")
    const threadId = await runningThread(app, storage, owner)
    await storage.agents.threads.addParticipants({
      projectId,
      threadId,
      principals: [{ type: "user", id: "guest" }],
      addedBy: { type: "user", id: "owner" },
      maxParticipants: 50,
    })

    const refused = await app.handle(
      request(
        `/api/agent-threads/${threadId}/messages`,
        "POST",
        { text: "And the fixtures.", delivery: "steer" },
        guest.csrf
      )
    )
    expect(refused.status).toBe(403)
    expect((await refused.json()) as { code?: string }).toMatchObject({
      code: "not_run_requester",
    })

    // The same message queued for their own turn is accepted.
    const queued = await app.handle(
      request(
        `/api/agent-threads/${threadId}/messages`,
        "POST",
        { text: "And the fixtures.", delivery: "queue" },
        guest.csrf
      )
    )
    expect(queued.status).toBe(202)
    expect((await queued.json()) as { item?: { mode?: string } }).toMatchObject({
      item: { mode: "queue" },
    })
    expect(owner.cookie).toContain("sixb_session_app=")
  })
})
