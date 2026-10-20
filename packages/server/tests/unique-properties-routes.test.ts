import { expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
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
