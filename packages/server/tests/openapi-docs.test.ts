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
  SixbHost,
} from "@sixb/core"
import { isCsrfExemptMethod } from "@sixb/core/internal/auth"
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
  readonly parameters?: readonly {
    readonly in?: string
    readonly name?: string
    readonly schema?: { readonly pattern?: string }
  }[]
  readonly responses?: Record<string, unknown>
  readonly security?: unknown
  readonly tags?: readonly string[]
}

interface OpenApiDocument {
  readonly components?: {
    readonly securitySchemes?: Record<string, unknown>
  }
  readonly paths?: Record<string, Record<string, OpenApiOperation>>
  readonly tags?: readonly { readonly name?: string; readonly description?: string }[]
}

function createDocsApi() {
  const sixb = new SixbHost<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })

  return createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
}

async function fetchDocsJsonWithoutWarnings(app: ReturnType<typeof createDocsApi>) {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }

  try {
    const response = await app.fetch(new Request("http://localhost/docs/json"))
    expect(response.status).toBe(200)
    const spec = (await response.json()) as OpenApiDocument
    expect(warnings.filter((warning) => warning.includes("Recursive reference detected"))).toEqual(
      []
    )
    return spec
  } finally {
    console.warn = originalWarn
  }
}

describe("OpenAPI docs", () => {
  test("documents CSRF auth for protected mutating API routes", async () => {
    const app = createDocsApi()
    const spec = await fetchDocsJsonWithoutWarnings(app)

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

    const declaredTags = new Set((spec.tags ?? []).map((tag) => tag.name).filter(Boolean))
    const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"])
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!httpMethods.has(method)) continue
        expect(operation.tags, `${method} ${path}`).toHaveLength(1)
        expect(declaredTags.has(operation.tags?.[0] ?? ""), `${method} ${path}`).toBe(true)
      }
    }
    expect(spec.paths?.["/api/auth/session"]?.get?.tags).toEqual(["Auth Sessions"])
    expect(spec.paths?.["/api/auth/members"]?.get?.tags).toEqual(["Auth Members"])
    expect(spec.paths?.["/api/auth/invitations"]?.post?.tags).toEqual(["Auth Invitations"])
    expect(spec.paths?.["/api/auth/access-tokens"]?.get?.tags).toEqual(["Auth Access Tokens"])
    expect(spec.paths?.["/api/auth/service-accounts"]?.get?.tags).toEqual(["Auth Service Accounts"])
    expect(spec.paths?.["/api/workflow-runs"]?.get?.tags).toEqual(["Workflow Runs"])
    expect(spec.paths?.["/api/workflow-interventions"]?.get?.tags).toEqual([
      "Workflow Interventions",
    ])
    expect(spec.paths?.["/api/agent-threads"]?.get?.tags).toEqual(["Agent Threads"])
    expect(spec.paths?.["/api/connectors/{connectorId}/connections"]?.get?.tags).toEqual([
      "Connector Connections",
    ])
    expect(spec.paths?.["/api/connectors/{connectorId}/connection-runs"]?.post?.tags).toEqual([
      "Connector Connection Runs",
    ])

    const csrfOnlyRoutes = [
      ["post", "/api/auth/sign-out"],
      ["post", "/api/auth/invitations"],
      ["post", "/api/auth/invitations/{invitationId}/revoke"],
      ["patch", "/api/auth/members/{userId}/groups"],
      ["post", "/api/auth/members/{userId}/suspend"],
      ["post", "/api/auth/members/{userId}/reactivate"],
      ["post", "/api/files/uploads"],
      ["put", "/api/files/uploads/{uploadId}/content"],
      ["post", "/api/files/uploads/{uploadId}/parts/{partNumber}"],
      ["post", "/api/files/uploads/{uploadId}/complete"],
      ["post", "/api/files/uploads/{uploadId}/abort"],
      ["post", "/api/syncs/{syncId}/runs"],
      ["post", "/api/pipelines/{pipelineId}/runs"],
      ["post", "/api/workflow-interventions/{interventionId}/submit"],
      ["post", "/api/workflow-interventions/{interventionId}/cancel"],
      ["post", "/api/agent-threads"],
      ["post", "/api/agent-threads/{threadId}/messages"],
      ["post", "/api/connectors/{connectorId}/connection-runs"],
      ["post", "/api/connectors/{connectorId}/connection-runs/{runId}/selection"],
      ["post", "/api/connectors/{connectorId}/connections/{connectionId}/reauthorize"],
      ["delete", "/api/connectors/{connectorId}/connections/{connectionId}"],
      ["post", "/api/connectors/{connectorId}/connections/{connectionId}/revoke"],
      // The simple file upload and object, link, and telemetry writes are CSRF-*or*-bearer now.
      // The derived ACCESS_TOKEN_ROUTES loop below covers them.
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

  test("documents contextual file content responses", async () => {
    const app = createDocsApi()
    const spec = await fetchDocsJsonWithoutWarnings(app)
    const paths = [
      "/api/objects/{objectTypeId}/{objectId}/files/content",
      "/api/action-runs/{runId}/files/content",
      "/api/agent-threads/{threadId}/messages/{messageId}/files/content",
      "/api/workflow-runs/{runId}/files/content",
      "/api/workflow-runs/{runId}/nodes/{nodeKey}/files/content",
    ]

    for (const path of paths) {
      const operations = spec.paths?.[path]
      for (const method of ["get", "head"] as const) {
        const responses = operations?.[method]?.responses as
          | Record<string, { content?: Record<string, { schema?: unknown }> }>
          | undefined
        expect(responses, `${method.toUpperCase()} ${path}`).toBeDefined()
        for (const status of ["200", "206", "400", "404", "416"]) {
          expect(responses, `${method.toUpperCase()} ${path}`).toHaveProperty(status)
        }
      }

      // The success bodies must be documented as binary octet-stream, not JSON.
      const getResponses = operations?.get?.responses as Record<
        string,
        { content?: Record<string, { schema?: { type?: string; format?: string } }> }
      >
      for (const status of ["200", "206"]) {
        const schema = getResponses[status]?.content?.["application/octet-stream"]?.schema
        expect(schema, `GET ${path} ${status}`).toEqual({ type: "string", format: "binary" })
      }
    }

    const expectedPathPatterns = new Map([
      ["/api/action-runs/{runId}/files/content", "^\\/(?:params|writeback\\/result)(?:\\/|$)"],
      ["/api/workflow-runs/{runId}/files/content", "^\\/(?:input|output)(?:\\/|$)"],
      ["/api/workflow-runs/{runId}/nodes/{nodeKey}/files/content", "^\\/(?:input|output)(?:\\/|$)"],
    ])

    for (const [path, expectedPattern] of expectedPathPatterns) {
      const operations = spec.paths?.[path]
      for (const method of ["get", "head"] as const) {
        const pathParameter = operations?.[method]?.parameters?.find(
          (parameter) => parameter.in === "query" && parameter.name === "path"
        )
        expect(pathParameter?.schema?.pattern, `${method.toUpperCase()} ${path}`).toBe(
          expectedPattern
        )
      }
    }
  })

  test("keeps bounded read request bodies in the generated contract", async () => {
    const app = createDocsApi()
    const spec = await fetchDocsJsonWithoutWarnings(app)
    const operation = spec.paths?.["/api/telemetry/history"]?.post as
      | {
          requestBody?: {
            content?: {
              "application/json"?: {
                schema?: {
                  required?: readonly string[]
                  properties?: { series?: { maxItems?: number } }
                }
              }
            }
          }
          responses?: Record<string, unknown>
        }
      | undefined

    const bodySchema = operation?.requestBody?.content?.["application/json"]?.schema
    expect(bodySchema?.required).toContain("series")
    expect(bodySchema?.properties?.series?.maxItems).toBe(4_096)
    expect(operation?.responses).toHaveProperty("413")

    for (const path of [
      "/api/objects/query",
      "/api/objects/query/count",
      "/api/objects/query/exists",
      "/api/objects/query/facets",
    ]) {
      expect(spec.paths?.[path]?.post?.responses, path).toHaveProperty("413")
    }
  })

  test("documents normalized action parameters and bounded identity reads", async () => {
    const app = createDocsApi()
    const spec = await fetchDocsJsonWithoutWarnings(app)
    const actionResponse = spec.paths?.["/api/actions"]?.get?.responses?.["200"] as
      | {
          content?: {
            "application/json"?: {
              schema?: {
                items?: {
                  properties?: {
                    params?: {
                      items?: { required?: readonly string[] }
                    }
                  }
                }
              }
            }
          }
        }
      | undefined
    const actionParamRequired =
      actionResponse?.content?.["application/json"]?.schema?.items?.properties?.params?.items
        ?.required

    expect(actionParamRequired).toContain("schema")
    expect(actionParamRequired).toContain("required")
    expect(spec.paths?.["/api/objects/{objectTypeId}/{objectId}"]?.get?.responses).toHaveProperty(
      "400"
    )
  })
})
