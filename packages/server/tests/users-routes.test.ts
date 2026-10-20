import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
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
import { createAccessTokenCredential } from "@sixb/core/internal/auth"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import {
  bindRequestExecution,
  type RequestExecutionAuthorization,
} from "@sixb/core/internal/request-execution"
import { Elysia } from "elysia"
import { registerUserRoutes } from "../src/routes/users"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "users-routes"

async function createHost(): Promise<SixbHost> {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })

  const people = [
    { id: "usr_ava", email: "ava@acme.com", displayName: "Ava Martin" },
    { id: "usr_ben", email: "ben@acme.com", displayName: "Ben Okafor" },
    { id: "usr_cleo", email: "cleo@acme.com", status: "suspended" as const },
  ]
  for (const [index, person] of people.entries()) {
    await storage.auth.users.create({
      ...person,
      projectId: PROJECT_ID,
      createdAt: new Date(`2026-05-14T10:0${index}:00.000Z`),
    })
  }

  return host
}

function member(grants: { readonly users?: boolean } = {}): RequestExecutionAuthorization {
  const context: AuthorizationContext = {
    principal: { type: "user", id: "usr_reader" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "view:users": grants.users ?? false },
  }
  return { type: "principal", context }
}

function routes(host: SixbHost, authorization: RequestExecutionAuthorization) {
  const app = new Elysia()
  app.derive(({ request }) => ({ sixb: bindRequestExecution(host, { request, authorization }) }))
  return registerUserRoutes(app, host)
}

async function get(app: ReturnType<typeof routes>, path: string) {
  const response = await app.handle(new Request(`http://localhost${path}`))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("GET /api/users", () => {
  test("lists active members and filters by status and search", async () => {
    const app = routes(await createHost(), member({ users: true }))

    expect(await get(app, "/api/users")).toEqual({
      status: 200,
      body: {
        users: [
          { id: "usr_ava", email: "ava@acme.com", displayName: "Ava Martin", status: "active" },
          { id: "usr_ben", email: "ben@acme.com", displayName: "Ben Okafor", status: "active" },
        ],
        hasMore: false,
        total: 2,
      },
    })

    const suspended = await get(app, "/api/users?status=suspended")
    expect(suspended.body.users).toEqual([
      { id: "usr_cleo", email: "cleo@acme.com", status: "suspended" },
    ])

    const page = await get(app, "/api/users?status=all&search=acme&limit=1&offset=1")
    expect(page.body).toMatchObject({ users: [{ id: "usr_ben" }], hasMore: true, total: 3 })
  })

  test("rejects limits outside 1 to 200, long searches and unknown statuses", async () => {
    const app = routes(await createHost(), member({ users: true }))
    const longSearch = `search=${"a".repeat(201)}`

    for (const query of [
      "limit=0",
      "limit=201",
      "limit=1.5",
      "offset=-1",
      "status=invited",
      longSearch,
    ]) {
      expect((await get(app, `/api/users?${query}`)).status).toBe(422)
    }
  })

  test("needs can.view(project.users)", async () => {
    const app = routes(await createHost(), member())

    expect(await get(app, "/api/users")).toEqual({
      status: 403,
      body: { error: "[Sixb] Principal 'usr_reader' is not allowed to view the member directory." },
    })
    expect((await get(app, "/api/users/usr_missing")).status).toBe(403)
  })

  test("is closed to shared sessions", async () => {
    const app = routes(await createHost(), {
      type: "delegated",
      access: { grants: [] },
      delegation: { kind: "share", grantId: "grant-1", sessionId: "session-1" },
    })

    expect((await get(app, "/api/users")).status).toBe(403)
    expect((await get(app, "/api/users/usr_ava")).status).toBe(403)
  })
})

describe("GET /api/users/:userId", () => {
  test("returns a member, suspended or not, and 404 for an unknown id", async () => {
    const app = routes(await createHost(), member({ users: true }))

    expect(await get(app, "/api/users/usr_cleo")).toEqual({
      status: 200,
      body: { id: "usr_cleo", email: "cleo@acme.com", status: "suspended" },
    })
    expect(await get(app, "/api/users/usr_missing")).toEqual({
      status: 404,
      body: { error: "[SixbServer] User 'usr_missing' not found." },
    })
  })
})

describe("the member directory with an access token", () => {
  const team = defineGroup("team")
  const directoryReaders = defineRole("directory-readers", {
    grantedTo: [team],
    grants: [can.view(project.users)],
  })

  async function serve() {
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: PROJECT_ID,
      ontology: [],
      groups: [team],
      roles: [directoryReaders],
      storage,
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      auth: { id: "test", kind: "dev" as const },
    })
    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )

    for (const [id, groupId] of [
      ["usr_reader", team.id],
      ["usr_outsider", undefined],
    ] as const) {
      await storage.auth.users.create({ id, projectId: PROJECT_ID, email: `${id}@acme.com` })
      if (groupId) {
        await storage.auth.groupMemberships.upsert({
          projectId: PROJECT_ID,
          userId: id,
          groupId,
          source: "manual",
        })
      }
    }

    const tokenFor = async (userId: string) => {
      const credential = createAccessTokenCredential("personal")
      await storage.auth.accessTokens.create({
        id: credential.tokenId,
        projectId: PROJECT_ID,
        name: "CLI",
        kind: "personal",
        subject: { type: "user", id: userId },
        tokenHash: credential.tokenHash,
        createdAt: new Date("2026-05-16T10:00:00.000Z"),
        expiresAt: new Date("2099-05-16T10:00:00.000Z"),
      })
      return { authorization: `Bearer ${credential.tokenValue}` }
    }

    return { app, tokenFor }
  }

  test("answers a personal access token with the holder's grants", async () => {
    const { app, tokenFor } = await serve()

    const reader = await tokenFor("usr_reader")
    const listed = await app.fetch(new Request("http://localhost/api/users", { headers: reader }))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ total: 2 })

    const one = await app.fetch(
      new Request("http://localhost/api/users/usr_outsider", { headers: reader })
    )
    expect(await one.json()).toMatchObject({ id: "usr_outsider", status: "active" })

    const outsider = await tokenFor("usr_outsider")
    const denied = await app.fetch(new Request("http://localhost/api/users", { headers: outsider }))
    expect(denied.status).toBe(403)
  })
})
