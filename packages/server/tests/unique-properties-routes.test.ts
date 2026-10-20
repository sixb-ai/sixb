import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Person = defineObjectType({
  id: "UniquePerson",
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { unique: true }),
    prop("name", "string"),
  ],
})

function createApp() {
  const host = new SixbHost({
    id: "unique-properties-http",
    ontology: [Person],
    storage: new InMemoryStorage(),
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
  return createSixbApi(new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() }))
}

test("the ontology API reports unique properties", async () => {
  const app = createApp()

  const response = await app.fetch(new Request(`http://localhost/api/object-types/${Person.id}`))

  expect(response.status).toBe(200)
  const objectType = (await response.json()) as {
    properties: { id: string; unique?: boolean }[]
  }
  expect(objectType.properties.map(({ id, unique }) => ({ id, unique }))).toEqual([
    { id: "id", unique: undefined },
    { id: "email", unique: true },
    { id: "name", unique: undefined },
  ])
})

test("a write that takes another object's unique value answers 409", async () => {
  const app = createApp()
  const put = (id: string, email: string) =>
    app.fetch(
      new Request(`http://localhost/api/objects/${Person.id}/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ properties: { email } }),
      })
    )

  expect((await put("ada", "ada@example.com")).status).toBe(200)
  const refused = await put("bob", "ada@example.com")

  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({
    error: `[Sixb] Another '${Person.id}' object already has this 'email'.`,
    code: "object.unique_violation",
  })
})

test("an object is found by a unique property", async () => {
  const app = createApp()
  await app.fetch(
    new Request(`http://localhost/api/objects/${Person.id}/ada`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ properties: { email: "ada@example.com", name: "Ada" } }),
    })
  )
  const getBy = (propertyId: string, value: unknown) =>
    app.fetch(
      new Request(`http://localhost/api/objects/${Person.id}/by/${propertyId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      })
    )

  const found = await getBy("email", "ada@example.com")
  expect(found.status).toBe(200)
  expect(await found.json()).toMatchObject({ primaryId: "ada", properties: { name: "Ada" } })

  const missing = await getBy("email", "bob@example.com")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: "Object not found" })

  const notUnique = await getBy("name", "Ada")
  expect(notUnique.status).toBe(400)
  expect(await notUnique.json()).toEqual({
    error:
      "[Sixb] Cannot look up 'UniquePerson.name' by value: getBy needs a property declared with unique: true.",
  })
})

describe("getObjectByUniqueProperty authorization", () => {
  const projectId = "unique-properties-auth"
  const pii = defineMarking("pii")
  const Customer = defineObjectType({
    id: "Customer",
    name: "Customer",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("email", "string", { unique: true }),
      prop("taxId", "string", { unique: true, markings: [pii] }),
    ],
  })
  const Secret = defineObjectType({
    id: "Secret",
    name: "Secret",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("code", "string", { unique: true }),
    ],
  })
  const staff = defineGroup("staff")
  const reader = defineRole("reader", { grantedTo: [staff], grants: [can.view(Customer)] })

  async function createAuthorizedApp() {
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: projectId,
      ontology: [Customer, Secret],
      markings: [pii],
      groups: [staff],
      roles: [reader],
      auth: { id: "test", kind: "dev" },
      storage,
      broker: new InMemoryBroker(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      queues: new InMemoryQueues(),
    })
    const trusted = createTestSixb(host)
    await trusted.objects(Customer).upsert({
      properties: { id: "c1", email: "ada@example.com", taxId: "FR-1" },
    })
    await trusted.objects(Secret).upsert({ properties: { id: "s1", code: "s-1" } })

    const credential = createSessionCredential("ses_staff")
    await storage.auth.users.create({ id: "usr_staff", projectId, email: "staff@acme.com" })
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId: "usr_staff",
      groupId: staff.id,
      source: "manual",
    })
    await storage.auth.sessions.create({
      id: credential.sessionId,
      projectId,
      userId: "usr_staff",
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-10-08T10:00:00.000Z"),
      expiresAt: new Date("2099-10-08T10:00:00.000Z"),
    })

    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )
    return (objectTypeId: string, propertyId: string, body: unknown) =>
      app.fetch(
        new Request(`http://localhost/api/objects/${objectTypeId}/by/${propertyId}`, {
          method: "POST",
          headers: {
            cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
            "x-sixb-csrf": "csrf_1",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      )
  }

  // Removal proof: answer 403 for every AuthorizationError in the route; the hidden type then
  // answers 403 instead of looking missing.
  test("a type the caller cannot view looks missing", async () => {
    const getBy = await createAuthorizedApp()

    const hidden = await getBy("Secret", "code", { value: "s-1" })

    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ error: "Object not found" })
  })

  test("a marked property needs clearance: 403", async () => {
    const getBy = await createAuthorizedApp()

    expect((await getBy("Customer", "email", { value: "ada@example.com" })).status).toBe(200)
    const marked = await getBy("Customer", "taxId", { value: "FR-1" })

    expect(marked.status).toBe(403)
    expect(await marked.json()).toEqual({
      error:
        "[Sixb] Cannot look up 'Customer.taxId' by value: it requires clearance for marking 'pii'.",
    })
  })

  test("an invalid or missing value is a bad request", async () => {
    const getBy = await createAuthorizedApp()

    const invalid = await getBy("Customer", "email", { value: 42 })
    expect(invalid.status).toBe(400)

    const missing = await getBy("Customer", "email", {})
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error:
        "[Sixb] Cannot look up 'Customer.email' by undefined: no object holds a null or missing value.",
    })
  })
})
