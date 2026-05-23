import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Pario,
  prop,
} from "@pario/core"
import { createParioApi, ParioServer } from "../src/server"

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

interface OpenApiOperation {
  readonly security?: unknown
}

interface OpenApiDocument {
  readonly components?: {
    readonly securitySchemes?: Record<string, unknown>
  }
  readonly paths?: Record<string, Record<string, OpenApiOperation>>
}

function createApp() {
  const pario = new Pario<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })

  return createParioApi(new ParioServer({ pario, quiet: true, ui: false }))
}

describe("OpenAPI docs", () => {
  test("documents CSRF auth for protected mutating API routes", async () => {
    const app = createApp()
    const response = await app.fetch(new Request("http://localhost/docs/json"))

    expect(response.status).toBe(200)

    const spec = (await response.json()) as OpenApiDocument
    expect(spec.components?.securitySchemes?.parioCsrf).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-pario-csrf",
      description:
        "Required for authenticated mutating requests. Use the csrfToken returned by GET /api/auth/session.",
    })

    const csrfRoutes = [
      ["post", "/api/auth/sign-out"],
      ["post", "/api/auth/invitations"],
      ["post", "/api/auth/invitations/{invitationId}/revoke"],
      ["post", "/api/syncs/{syncId}/runs"],
      ["post", "/api/pipelines/{pipelineId}/runs"],
      ["put", "/api/objects/{objectTypeId}/{objectId}"],
      ["post", "/api/objects/{objectTypeId}/{objectId}/actions/{actionId}"],
      ["put", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["delete", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["post", "/api/objects/{objectTypeId}/{objectId}/telemetry/{propertyId}"],
    ] as const

    for (const [method, path] of csrfRoutes) {
      expect(spec.paths?.[path]?.[method]?.security).toEqual([{ parioCsrf: [] }])
    }

    expect(spec.paths?.["/api/auth/invitations"]?.get?.security).toBeUndefined()
  })
})
