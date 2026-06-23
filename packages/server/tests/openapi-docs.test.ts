import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

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

function createDocsApi() {
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })

  return createSixbApi(new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() }))
}

describe("OpenAPI docs", () => {
  test("documents CSRF auth for protected mutating API routes", async () => {
    const app = createDocsApi()
    const response = await app.fetch(new Request("http://localhost/docs/json"))

    expect(response.status).toBe(200)

    const spec = (await response.json()) as OpenApiDocument
    expect(spec.components?.securitySchemes?.sixbCsrf).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-sixb-csrf",
      description:
        "Required for authenticated mutating requests. Use the csrfToken returned by GET /api/auth/session.",
    })

    const csrfRoutes = [
      ["post", "/api/auth/sign-out"],
      ["post", "/api/auth/invitations"],
      ["post", "/api/auth/invitations/{invitationId}/revoke"],
      ["post", "/api/syncs/{syncId}/runs"],
      ["post", "/api/pipelines/{pipelineId}/runs"],
      ["post", "/api/workflows/{workflowId}/runs"],
      ["post", "/api/workflow-interventions/{interventionId}/submit"],
      ["post", "/api/workflow-interventions/{interventionId}/cancel"],
      ["post", "/api/actions/{actionId}"],
      ["post", "/api/objects/query"],
      ["post", "/api/objects/query/count"],
      ["post", "/api/objects/query/exists"],
      ["post", "/api/objects/query/facets"],
      ["put", "/api/objects/{objectTypeId}/{objectId}"],
      ["put", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["delete", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["post", "/api/objects/{objectTypeId}/{objectId}/telemetry/{propertyId}"],
      ["post", "/api/telemetry/history"],
    ] as const

    for (const [method, path] of csrfRoutes) {
      expect(spec.paths?.[path]?.[method]?.security).toEqual([{ sixbCsrf: [] }])
    }

    expect(spec.paths?.["/api/auth/invitations"]?.get?.security).toBeUndefined()
  })
})
