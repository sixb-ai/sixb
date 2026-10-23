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
  prop,
  ref,
  SixbHost,
  SYSTEM_PRINCIPAL,
  userRef,
} from "@sixb/core"
import { createAccessTokenCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "object-query-current-user"
const NOW = new Date("2026-10-20T10:00:00.000Z")

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
      query: { searchable: true, sortable: true },
    }),
    prop("assignee", ref.user(), {
      nullable: true,
      query: { searchable: true, filterable: true },
    }),
  ],
})

const members = defineGroup("members")
const taskReader = defineRole("task.reader", { grantedTo: [members], grants: [can.view(Task)] })

async function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Task],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [members],
    roles: [taskReader],
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  for (const id of ["usr_alice", "usr_bob"]) {
    await storage.auth.users.create({ id, projectId, email: `${id}@acme.com` })
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId: id,
      groupId: members.id,
      source: "manual",
    })
  }
  await storage.auth.serviceAccounts.create({
    id: "svc_reports",
    projectId,
    name: "Reports",
    status: "active",
    createdByPrincipal: SYSTEM_PRINCIPAL,
    createdAt: NOW,
    updatedAt: NOW,
  })
  await storage.auth.serviceAccountGroupMemberships.upsert({
    projectId,
    serviceAccountId: "svc_reports",
    groupId: members.id,
    source: "manual",
  })

  const tasks = createTestSixb(host).objects(Task)
  await tasks.upsert({ properties: { id: "t1", assignee: userRef("usr_alice") } })
  await tasks.upsert({ properties: { id: "t2", assignee: userRef("usr_bob") } })
  await tasks.upsert({ properties: { id: "t3", assignee: null } })

  return { app, storage }
}

async function seedToken(
  storage: InMemoryStorage,
  subject: { readonly type: "user" | "serviceAccount"; readonly id: string }
): Promise<string> {
  const kind = subject.type === "user" ? "personal" : "serviceAccount"
  const credential = createAccessTokenCredential(kind)
  await storage.auth.accessTokens.create({
    id: credential.tokenId,
    projectId,
    name: `${subject.id} token`,
    kind,
    subject,
    tokenHash: credential.tokenHash,
    createdAt: NOW,
    expiresAt: new Date("2099-10-20T10:00:00.000Z"),
  })
  return credential.tokenValue
}

describe("POST /api/objects/query with currentUser()", () => {
  test("binds { type: 'currentUser' } to the caller, and to no one for a service account", async () => {
    const { app, storage } = await createApp()
    const query = (token: string, op: "eq" | "neq") =>
      app.fetch(
        new Request("http://localhost/api/objects/query", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "id" }],
              input: {
                kind: "filter",
                predicate: { op, propertyId: "assignee", value: { type: "currentUser" } },
                input: { kind: "start", objectTypeId: Task.id },
              },
            },
          }),
        })
      )
    const ids = async (response: Response) => {
      expect(response.status).toBe(200)
      const body = (await response.json()) as { objects: { primaryId: string }[] }
      return body.objects.map((object) => object.primaryId)
    }

    const alice = await seedToken(storage, { type: "user", id: "usr_alice" })
    expect(await ids(await query(alice, "eq"))).toEqual(["t1"])
    expect(await ids(await query(alice, "neq"))).toEqual(["t2", "t3"])

    const reports = await seedToken(storage, { type: "serviceAccount", id: "svc_reports" })
    expect(await ids(await query(reports, "eq"))).toEqual([])
    expect(await ids(await query(reports, "neq"))).toEqual(["t1", "t2", "t3"])
  })
})
