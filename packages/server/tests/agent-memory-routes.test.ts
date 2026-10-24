import { describe, expect, test } from "bun:test"
import type { ModelCatalogInput } from "@sixb/core"
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
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "agent-memory-route-tests"
// can.run(agent) needs a language model; the routes never invoke it.
const model = {
  providerId: "test",
  modelId: "test-model",
  definition: { kind: "language", providerId: "test", modelId: "test-model", capabilities: {} },
  stream: async () => {
    throw new Error("Must not invoke the route test model")
  },
} satisfies NonNullable<ModelCatalogInput["language"]>[number]
const users = defineGroup("users")
const keepers = defineGroup("keepers")
const agentUser = defineRole("assistant.user", { grantedTo: [users], grants: [can.run(agent)] })
const knowledgeKeeper = defineRole("assistant.knowledge-keeper", {
  grantedTo: [keepers],
  grants: [can.manage(agent.memory)],
})

function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    models: { language: [model] },
    groups: [users, keepers],
    roles: [agentUser, knowledgeKeeper],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" as const },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, storage }
}

async function seedSession(
  storage: InMemoryStorage,
  userId: string,
  groupIds: readonly string[] = [users.id]
) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: PROJECT_ID,
    email: `${userId}@acme.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: PROJECT_ID,
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: PROJECT_ID,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-13T10:00:00.000Z"),
    expiresAt: new Date("2099-10-13T10:00:00.000Z"),
  })
  const cookie = `sixb_session_app=${credential.cookieValue}`
  const mutationHeaders = {
    cookie: `${cookie}; sixb_csrf_app=csrf_1`,
    "x-sixb-csrf": "csrf_1",
    "content-type": "application/json",
  }
  return {
    get: (path: string) => new Request(url(path), { headers: { cookie } }),
    save: (repo: string, body: unknown) =>
      new Request(url(`/api/agent-memory/${repo}/revisions`), {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(body),
      }),
    delete: (repo: string) =>
      new Request(url(`/api/agent-memory/${repo}`), { method: "DELETE", headers: mutationHeaders }),
  }
}

function url(path: string): string {
  return `http://localhost${path}`
}

const entry = (contents: string) => ({ path: "MEMORY.md", contents })

describe("agent memory routes", () => {
  test("a user saves, reads, lists, and deletes their own memory", async () => {
    const { app, storage } = createApp()
    const priya = await seedSession(storage, "usr_priya")

    const saved = await app.fetch(
      priya.save("user", {
        baseRevision: 0,
        message: "Remember Priya prefers short bullet summaries",
        changes: [entry("# Memory: Priya\n\n## Index\n- [[team_structure]]\n")],
      })
    )
    expect(saved.status).toBe(201)
    expect(await saved.json()).toEqual({
      repo: "user",
      revision: 1,
      warnings: [{ path: "MEMORY.md", link: "team_structure" }],
    })

    const repo = await app.fetch(priya.get("/api/agent-memory/user"))
    expect(repo.status).toBe(200)
    expect(await repo.json()).toEqual({
      repo: "user",
      revision: 1,
      files: [entry("# Memory: Priya\n\n## Index\n- [[team_structure]]\n")],
    })

    const history = await app.fetch(priya.get("/api/agent-memory/user/revisions?limit=10"))
    expect(await history.json()).toEqual({
      revisions: [
        {
          revision: 1,
          message: "Remember Priya prefers short bullet summaries",
          author: { type: "user", id: "usr_priya" },
          changes: [{ path: "MEMORY.md", deleted: false }],
          createdAt: expect.any(String),
        },
      ],
      hasMore: false,
      total: 1,
    })

    const adam = await seedSession(storage, "usr_adam")
    expect(await (await app.fetch(adam.get("/api/agent-memory/user"))).json()).toMatchObject({
      revision: 0,
      files: [],
    })

    const deleted = await app.fetch(priya.delete("user"))
    expect(deleted.status).toBe(200)
    expect(await (await app.fetch(priya.get("/api/agent-memory/user"))).json()).toMatchObject({
      revision: 0,
    })
  })

  test("reads the repo as an earlier revision left it, for its history", async () => {
    const { app, storage } = createApp()
    const priya = await seedSession(storage, "usr_priya")
    await app.fetch(priya.save("user", { baseRevision: 0, message: "One", changes: [entry("a")] }))
    await app.fetch(priya.save("user", { baseRevision: 1, message: "Two", changes: [entry("b")] }))

    const first = await app.fetch(priya.get("/api/agent-memory/user?revision=1"))
    expect(await first.json()).toEqual({ repo: "user", revision: 1, files: [entry("a")] })
    expect((await app.fetch(priya.get("/api/agent-memory/user?revision=latest"))).status).toBe(422)
  })

  test("returns a conflict with the other save's contents and saves nothing", async () => {
    const { app, storage } = createApp()
    const priya = await seedSession(storage, "usr_priya")
    await app.fetch(
      priya.save("user", { baseRevision: 0, message: "Start", changes: [entry("a")] })
    )
    await app.fetch(
      priya.save("user", { baseRevision: 1, message: "Theirs", changes: [entry("b")] })
    )

    const rejected = await app.fetch(
      priya.save("user", { baseRevision: 1, message: "Mine", changes: [entry("c")] })
    )

    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({
      error:
        "Another save changed these files since they were loaded. Merge their contents into yours and save again.",
      code: "conflict",
      revision: 2,
      conflicts: [entry("b")],
    })
  })

  test("rejects a save the Agent can fix with what to change", async () => {
    const { app, storage } = createApp()
    const priya = await seedSession(storage, "usr_priya")

    const rejected = await app.fetch(
      priya.save("user", {
        baseRevision: 0,
        message: "Topic only",
        changes: [{ path: "notes.md", contents: "x" }],
      })
    )

    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({
      error: "[Sixb] Agent memory repo must keep its MEMORY.md.",
      code: "invalid_save",
    })
  })

  test("lets everyone who can run the agent save the project's memory, and keepers delete it", async () => {
    const { app, storage } = createApp()
    const keeper = await seedSession(storage, "usr_keeper", [users.id, keepers.id])
    const member = await seedSession(storage, "usr_member")
    const outsider = await seedSession(storage, "usr_outsider", [])

    expect(
      (
        await app.fetch(
          member.save("project", { baseRevision: 0, message: "S", changes: [entry("p")] })
        )
      ).status
    ).toBe(201)
    expect(await (await app.fetch(keeper.get("/api/agent-memory/project"))).json()).toMatchObject({
      revision: 1,
    })

    const denied = await app.fetch(member.delete("project"))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: "not_allowed" })
    expect((await app.fetch(outsider.get("/api/agent-memory/project"))).status).toBe(403)
    expect(
      (
        await app.fetch(
          outsider.save("project", { baseRevision: 1, message: "X", changes: [entry("x")] })
        )
      ).status
    ).toBe(403)
    expect((await app.fetch(keeper.delete("project"))).status).toBe(200)
  })

  test("names only the two repos", async () => {
    const { app, storage } = createApp()
    const priya = await seedSession(storage, "usr_priya")

    const response = await app.fetch(priya.get("/api/agent-memory/user:usr_adam"))

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  })
})
