import { expect, test } from "bun:test"
import {
  type AuthorizationContext,
  col,
  defineDataset,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { Elysia } from "elysia"
import { registerDefinitionRoutes } from "../src/routes/definitions"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const bills = defineDataset("bills", {
  schema: [col("bill_id", "string"), col("vendor_id", "string", { nullable: true })],
  primaryKey: "bill_id",
  partitionBy: ["vendor_id"],
})

function host(): SixbHost {
  return new SixbHost({
    id: "definitions-test",
    ontology: [Invoice],
    datasets: [bills],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

function routes(sixb: SixbHost, grants: Partial<AuthorizationContext["grants"]>) {
  const authorization: AuthorizationContext = {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), ...grants },
  }
  const app = new Elysia()
  app.derive(({ request }) => ({
    sixb: bindRequestExecution(sixb, {
      request,
      authorization: { type: "principal", context: authorization },
    }),
  }))
  return registerDefinitionRoutes(app, sixb)
}

test("GET /api/definitions answers whoever may observe the Console", async () => {
  const sixb = host()
  const request = () => new Request("http://localhost/api/definitions")

  expect((await routes(sixb, {}).handle(request())).status).toBe(403)

  const response = await routes(sixb, { "observe:console": true }).handle(request())
  expect(response.status).toBe(200)
  const manifest = await response.json()
  expect(manifest.commit).toBeNull()
  expect(manifest.definitions).toContainEqual({
    kind: "objectType",
    id: "Invoice",
    file: null,
    hash: expect.any(String),
  })
  expect(manifest.datasets).toEqual([
    {
      kind: "dataset",
      id: "bills",
      schema: {
        columns: [
          { name: "bill_id", type: "string" },
          { name: "vendor_id", type: "string", nullable: true },
        ],
      },
      primaryKey: "bill_id",
      partitionBy: ["vendor_id"],
    },
  ])
})
