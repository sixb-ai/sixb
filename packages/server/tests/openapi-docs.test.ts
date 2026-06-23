import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  isCsrfExemptMethod,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import { ACCESS_TOKEN_ROUTES } from "../src/auth/access-token-boundary"
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
    expect(spec.components?.securitySchemes?.sixbBearer).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "Sixb access token",
      description:
        "Use a Sixb personal access token or service-account token. Bearer tokens are accepted only on routes that explicitly document this scheme.",
    })

    const csrfOnlyRoutes = [
      ["post", "/api/auth/sign-out"],
      ["post", "/api/auth/invitations"],
      ["post", "/api/auth/invitations/{invitationId}/revoke"],
      ["post", "/api/syncs/{syncId}/runs"],
      ["post", "/api/pipelines/{pipelineId}/runs"],
      ["post", "/api/workflow-interventions/{interventionId}/submit"],
      ["post", "/api/workflow-interventions/{interventionId}/cancel"],
      ["put", "/api/objects/{objectTypeId}/{objectId}"],
      ["put", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["delete", "/api/objects/{objectTypeId}/{objectId}/links/{linkId}"],
      ["post", "/api/objects/{objectTypeId}/{objectId}/telemetry/{propertyId}"],
      ["post", "/api/telemetry/history"],
    ] as const

    for (const [method, path] of csrfOnlyRoutes) {
      expect(spec.paths?.[path]?.[method]?.security).toEqual([{ sixbCsrf: [] }])
    }

    // The bearer boundary is the single source of truth. Every route in
    // ACCESS_TOKEN_ROUTES must document the matching scheme (bearer-only for
    // CSRF-exempt reads, CSRF-or-bearer for mutations), and no other operation
    // may advertise bearer auth. This fails loudly if the enforced boundary and
    // the documented contract ever drift apart.
    const toOpenApiPath = (path: string) => path.replace(/:([^/]+)/g, "{$1}")
    const expectedBearer = new Set<string>()
    for (const route of ACCESS_TOKEN_ROUTES) {
      const method = route.method.toLowerCase()
      const path = toOpenApiPath(route.path)
      expectedBearer.add(`${method} ${path}`)
      const expected = isCsrfExemptMethod(route.method)
        ? [{ sixbBearer: [] }]
        : [{ sixbCsrf: [] }, { sixbBearer: [] }]
      expect(spec.paths?.[path]?.[method]?.security, `${method} ${path}`).toEqual(expected)
    }

    const documentedBearer = new Set<string>()
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations)) {
        const requirements = (operation.security ?? []) as { readonly [scheme: string]: unknown }[]
        if (requirements.some((requirement) => "sixbBearer" in requirement)) {
          documentedBearer.add(`${method} ${path}`)
        }
      }
    }
    expect([...documentedBearer].sort()).toEqual([...expectedBearer].sort())

    expect(spec.paths?.["/api/auth/invitations"]?.get?.security).toBeUndefined()
  })
})
