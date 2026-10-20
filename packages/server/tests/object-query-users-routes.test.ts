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
  ref,
  resolveAuthorizationContext,
  SixbHost,
  userRef,
} from "@sixb/core"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestSixb } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerObjectRoutes } from "../src/routes/objects"

const projectId = "object-query-users-routes"

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("assignee", ref.user(), { nullable: true }),
  ],
})

const members = defineGroup("members")
const directory = defineGroup("directory")
const taskReader = defineRole("task-reader", {
  grantedTo: [members, directory],
  grants: [can.view(Task)],
})
const directoryReader = defineRole("directory-reader", {
  grantedTo: [directory],
  grants: [can.view(project.users)],
})

async function createHost(): Promise<SixbHost> {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Task],
    groups: [members, directory],
    roles: [taskReader, directoryReader],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })

  await storage.auth.users.create({
    id: "usr_ava",
    projectId,
    email: "ava@acme.com",
    displayName: "Ava Martin",
    createdAt: new Date("2026-05-14T10:00:00.000Z"),
  })
  await createTestSixb(host)
    .objects(Task)
    .upsert({ properties: { id: "t1", title: "Ship", assignee: userRef("usr_ava") } })

  return host
}

function routes(host: SixbHost, groupIds: readonly string[]) {
  const context = resolveAuthorizationContext({
    principal: { type: "user", id: "usr_reader" },
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
  const app = new Elysia()
  app.derive(({ request }) => ({
    sixb: bindRequestExecution(host, { request, authorization: { type: "principal", context } }),
  }))
  return registerObjectRoutes(app, host)
}

async function query(app: ReturnType<typeof routes>, users: readonly string[]) {
  const response = await app.handle(
    new Request("http://localhost/api/objects/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          kind: "expand",
          input: { kind: "start", objectTypeId: Task.id },
          expansions: [],
          users,
        },
      }),
    })
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("POST /api/objects/query with expanded user properties", () => {
  test("returns the profiles next to the references", async () => {
    const app = routes(await createHost(), ["directory"])

    const { status, body } = await query(app, ["assignee"])

    expect(status).toBe(200)
    expect(body.objects).toMatchObject([
      {
        properties: { assignee: { type: "user", id: "usr_ava" } },
        users: {
          assignee: {
            id: "usr_ava",
            email: "ava@acme.com",
            displayName: "Ava Martin",
            status: "active",
          },
        },
      },
    ])
  })

  test("omits the profiles without can.view(project.users), without failing", async () => {
    const app = routes(await createHost(), ["members"])

    const { status, body } = await query(app, ["assignee"])

    expect(status).toBe(200)
    expect((body.objects as Record<string, unknown>[])[0]?.users).toEqual({})
  })

  test("rejects a property that is not a user reference", async () => {
    const app = routes(await createHost(), ["directory"])

    const { status, body } = await query(app, ["title"])

    expect(status).toBe(400)
    expect(body.issues).toMatchObject([{ path: "$.users[0]", code: "invalid_user_expansion" }])
  })
})
