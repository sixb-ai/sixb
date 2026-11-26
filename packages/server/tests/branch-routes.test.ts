import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "test-project"
const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const developers = defineGroup("developers")
const operators = defineGroup("operators")
const sales = defineGroup("sales")
const roles = [
  defineRole("developers", { grantedTo: [developers], grants: [can.manage(project.source)] }),
  defineRole("operators", { grantedTo: [operators], grants: [can.observe(project.console)] }),
  defineRole("sales", { grantedTo: [sales], grants: [can.view(Order)] }),
]

async function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Order],
    groups: [developers, operators, sales],
    roles,
    source: { repository: "acme/shop" },
    auth: { id: "test", kind: "dev" as const },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, storage }
}

async function signIn(storage: InMemoryStorage, userId: string, groupId: string) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })
  await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-11-24T10:00:00.000Z"),
    expiresAt: new Date("2099-11-24T10:00:00.000Z"),
  })

  return {
    cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
    "x-sixb-csrf": "csrf_1",
    "content-type": "application/json",
  }
}

function call(
  app: ReturnType<typeof createSixbApi>,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown
) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  )
}

describe("branch routes", () => {
  test("open, list, refresh, stop and delete a branch", async () => {
    const { app, storage } = await createApp()
    const headers = await signIn(storage, "usr_dev", "developers")
    const name = "feature/invoices"

    const opened = await call(app, "/api/branches", "POST", headers, { name })
    expect(opened.status).toBe(202)
    expect(await opened.json()).toMatchObject({
      name,
      wanted: "running",
      createdBy: "usr_dev",
      data: null,
    })

    const listed = (await (await call(app, "/api/branches", "GET", headers)).json()) as {
      branches: Record<string, unknown>[]
    }
    expect(listed.branches.map((branch) => branch.name)).toEqual([name])
    expect(listed.branches[0]).not.toHaveProperty("key")

    const refreshed = await call(app, "/api/branches/refresh", "POST", headers, { name })
    expect(await refreshed.json()).toMatchObject({ refreshRequestedAt: expect.any(String) })

    const stopped = await call(app, "/api/branches/stop", "POST", headers, { name })
    expect(await stopped.json()).toMatchObject({ wanted: "stopped" })

    const deleted = await call(
      app,
      `/api/branches?name=${encodeURIComponent(name)}`,
      "DELETE",
      headers
    )
    expect(await deleted.json()).toMatchObject({ wanted: "deleted" })
  })

  // A branch runs code nobody reviewed on its creator's data: who sees one stays a trusted set.
  // Guard check: take `console.observe` again in `assertMayManageBranches` (`branches/execution.ts`).
  test("refuse, on every route, whoever does not manage the project's source", async () => {
    const { app, storage } = await createApp()
    const developer = await signIn(storage, "usr_dev", "developers")
    await call(app, "/api/branches", "POST", developer, { name: "feature/invoices" })
    const name = "feature/invoices"

    for (const [userId, groupId] of [
      ["usr_ops", "operators"],
      ["usr_sales", "sales"],
    ] as const) {
      const headers = await signIn(storage, userId, groupId)
      const answers = [
        await call(app, "/api/branches", "GET", headers),
        await call(app, "/api/branches", "POST", headers, { name: "feature/other" }),
        await call(app, "/api/branches/refresh", "POST", headers, { name }),
        await call(app, "/api/branches/stop", "POST", headers, { name }),
        await call(app, "/api/branches/sign-in", "POST", headers, { name }),
        await call(app, `/api/branches?name=${encodeURIComponent(name)}`, "DELETE", headers),
      ]
      expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403, 403])
    }

    expect((await storage.hostedBranches.list({ projectId })).map((row) => row.wanted)).toEqual([
      "running",
    ])
  })
})
