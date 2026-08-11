import {
  AuthorizationError,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
  type ObjectRef,
  type OntologySource,
  type Sixb,
} from "@sixb/core"
import type {
  ExpandedLinkValue,
  ExpandedObjectRow,
  ObjectRow,
  ObjectRowLinks,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSdk } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import {
  ObjectListResponseSchema,
  ObjectParamsSchema,
  ObjectQueryCountRequestSchema,
  ObjectQueryExistsRequestSchema,
  ObjectQueryFacetsRequestSchema,
  ObjectQueryRequestSchema,
  ObjectSearchQuerySchema,
  ObjectSearchResponseSchema,
  ObjectsQuerySchema,
  TwinObjectSchema,
  UpsertObjectBodySchema,
} from "../schemas/objects"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

const ObjectFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(/^\/properties(?:\/|$)/, "Object file content paths must start with /properties/"),
})

function serializeObject(row: {
  primaryId: string
  objectTypeId: string
  properties: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}) {
  return {
    primaryId: row.primaryId,
    objectTypeId: row.objectTypeId,
    properties: row.properties,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}

type SerializedObject = ReturnType<typeof serializeObject>
type SerializedLinkValue = SerializedExpandedObject | SerializedExpandedObject[] | null
type SerializedExpandedObject = SerializedObject & {
  links?: Record<string, SerializedLinkValue>
  linkProperties?: Record<string, unknown>
}

/**
 * Serialize a query row together with any `links` attached by an `expand` node.
 * Recurses through nested expansions; `linkProperties` carries edge metadata on
 * an expanded child. Only the query route hydrates links, so the plain list and
 * identity routes keep using `serializeObject`.
 */
function serializeExpandedObject(row: ExpandedObjectRow): SerializedExpandedObject {
  const serialized: SerializedExpandedObject = serializeObject(row)
  if (row.links) serialized.links = serializeLinks(row.links)
  if (row.linkProperties !== undefined) serialized.linkProperties = row.linkProperties
  return serialized
}

function serializeLinks(links: ObjectRowLinks): Record<string, SerializedLinkValue> {
  const result: Record<string, SerializedLinkValue> = {}
  for (const [linkId, value] of Object.entries(links)) {
    result[linkId] = serializeLinkValue(value)
  }
  return result
}

function serializeLinkValue(value: ExpandedLinkValue): SerializedLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(serializeExpandedObject)
  // Array.isArray does not narrow a readonly[] away, so assert the scalar case.
  return serializeExpandedObject(value as ExpandedObjectRow)
}

function serializePlan(plan: {
  readonly mode: string
  readonly providerIssues: readonly unknown[]
  readonly fallbackIssues: readonly unknown[]
  readonly issues: readonly unknown[]
  readonly fallback?: { readonly maxRows: number; readonly requiresExplicitBound: boolean }
}) {
  return {
    mode: plan.mode,
    providerIssues: plan.providerIssues,
    fallbackIssues: plan.fallbackIssues,
    issues: plan.issues,
    fallback: plan.fallback,
  }
}

function handleObjectQueryError(error: unknown, set: { status?: number | string }) {
  if (error instanceof AuthorizationError) {
    set.status = 403
    return { error: error.message }
  }

  if (error instanceof ZodError) {
    set.status = 400
    return {
      error: "Invalid object query request",
      issues: error.issues.map((issue) => ({
        path: formatZodIssuePath(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    }
  }

  if (error instanceof ObjectQueryValidationError || error instanceof ObjectQueryPlanningError) {
    set.status = 400
    return {
      error: error.message,
      issues: error.issues,
    }
  }

  if (error instanceof ObjectQueryExecutionError) {
    set.status = 400
    return {
      error: error.message,
      issues: [
        {
          path: error.path ?? "$",
          code: error.code,
          message: error.message,
        },
      ],
    }
  }

  set.status = 500
  return { error: error instanceof Error ? error.message : String(error) }
}

function formatZodIssuePath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "$"
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${segment}]`
    return /^[A-Za-z_$][\w$]*$/.test(segment)
      ? `${formatted}.${segment}`
      : `${formatted}[${JSON.stringify(segment)}]`
  }, "$")
}

async function getObjectRow(
  sdk: ReturnType<typeof requireRequestSdk>,
  params: { objectTypeId: string; objectId: string }
) {
  return sdk.objects.get(params.objectTypeId, params.objectId)
}

interface ObjectSearchItem {
  readonly ref: ObjectRef
  readonly label: string
}

async function searchObjects(
  sixb: Sixb<readonly OntologySource[]>,
  sdk: ReturnType<typeof requireRequestSdk>,
  query: string,
  limit: number
): Promise<readonly ObjectSearchItem[]> {
  // Primary ids are available on every object store and form the reliable fallback. Scoped.list()
  // narrows broad searches to viewable types before storage, rather than filtering rows afterwards.
  const primaryMatches = await sdk.objects.list({ idPrefix: query, limit })

  const capabilities = sixb.storage.objects.queryCapabilities()
  const supportsTextSearch =
    capabilities.queryObjects === true &&
    capabilities.nodes?.start === true &&
    capabilities.nodes?.text === true &&
    capabilities.nodes?.limit === true &&
    typeof sixb.storage.objects.queryObjects === "function"

  const searchableTypes = supportsTextSearch
    ? sdk.objects
        .listTypes()
        .filter((objectType) => Boolean(objectType.search?.defaultText?.length))
    : []

  const textMatches = await Promise.all(
    searchableTypes.map(async (objectType) => {
      const objectQuery: ObjectQuery = {
        kind: "limit",
        limit,
        input: {
          kind: "text",
          query,
          input: { kind: "start", objectTypeId: objectType.id },
        },
      }
      const result = await sdk.objects.executeQuery({ query: objectQuery })
      return result.objects
    })
  )

  const items = new Map<string, ObjectSearchItem>()
  for (const row of [...primaryMatches.objects, ...textMatches.flat()]) {
    const ref = { objectTypeId: row.objectTypeId, primaryId: row.primaryId }
    const identity = objectRefIdentity(ref)
    if (items.has(identity)) continue
    items.set(identity, { ref, label: objectSearchLabel(sdk, row) })
    if (items.size === limit) break
  }
  return [...items.values()]
}

function objectSearchLabel(sdk: ReturnType<typeof requireRequestSdk>, row: ObjectRow): string {
  const objectType = sdk.objects.resolveType(row.objectTypeId)
  const titlePropertyId = objectType.search?.title
  const title = titlePropertyId ? row.properties[titlePropertyId] : undefined
  const displayTitle =
    typeof title === "string" || typeof title === "number" ? String(title).trim() : ""
  return displayTitle && displayTitle !== row.primaryId
    ? `${objectType.name}: ${displayTitle} (${row.primaryId})`
    : `${objectType.name} ${row.primaryId}`
}

function objectRefIdentity(ref: ObjectRef): string {
  return `${encodeURIComponent(ref.objectTypeId)}:${encodeURIComponent(ref.primaryId)}`
}

async function objectFileContentResponse(
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly objectTypeId: string; readonly objectId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const sdk = requireRequestSdk(context)

  return createContextualFileContentResponse({
    blobStorage: sixb.blobs,
    query: context.query,
    querySchema: ObjectFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    hideError: (error) => error instanceof AuthorizationError,
    resolveRoot: async () => {
      const row = await getObjectRow(sdk, context.params)
      if (!row) {
        return null
      }

      return serializeObject(row)
    },
  })
}

export function registerObjectRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/objects/search",
      async (context) => {
        const { query, set } = context
        try {
          const parsed = ObjectSearchQuerySchema.parse(query)
          const limit = Math.min(parseOptionalInt(parsed.limit) ?? 20, 50)
          if (limit < 1) {
            set.status = 400
            return { error: "Object search limit must be positive" }
          }
          const items = await searchObjects(sixb, requireRequestSdk(context), parsed.q, limit)
          return ObjectSearchResponseSchema.parse({ items })
        } catch (error) {
          return handleObjectQueryError(error, set)
        }
      },
      {
        query: ObjectSearchQuerySchema,
        response: {
          200: ObjectSearchResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "Search objects",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "searchObjects",
          security: bearerSecurityRequirement("searchObjects"),
        },
      }
    )
    .get(
      "/api/objects",
      async (context) => {
        const { query, set } = context
        const sdk = requireRequestSdk(context)

        try {
          const params = {
            objectTypeIds: query.objectTypeId === undefined ? undefined : [query.objectTypeId],
            idPrefix: query.idPrefix,
            idSuffix: query.idSuffix,
            updatedAfter: query.updatedAfter,
            updatedBefore: query.updatedBefore,
            createdAfter: query.createdAfter,
            createdBefore: query.createdBefore,
            limit: query.limit,
            offset: query.offset,
            orderBy: query.orderBy,
            order: query.order,
          }
          const result = await sdk.objects.list(params)

          return {
            objects: result.objects.map(serializeObject),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          if (error instanceof AuthorizationError) {
            set.status = 403
            return { error: error.message }
          }

          set.status = 400
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        query: ObjectsQuerySchema,
        response: {
          200: ObjectListResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
        error: ({ code, error, set }) => {
          if (code !== "VALIDATION" || error.type !== "query") return

          set.status = 400
          return { error: error.all[0]?.message ?? "Invalid object list query parameters." }
        },
        detail: {
          summary: "List objects",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "listObjects",
          security: bearerSecurityRequirement("listObjects"),
        },
      }
    )
    .post(
      "/api/objects/query",
      async (context) => {
        const { body, set } = context
        try {
          const parsed = ObjectQueryRequestSchema.parse(body) as {
            query: ObjectQuery
            includeTotal?: boolean
          }
          const result = await requireRequestSdk(context).objects.executeQuery({
            query: parsed.query,
            includeTotal: parsed.includeTotal,
          })

          return {
            objects: result.objects.map(serializeExpandedObject),
            hasMore: result.hasMore,
            nextPageToken: result.nextPageToken,
            plan: serializePlan(result.plan),
            ...(result.total === undefined ? {} : { total: result.total }),
          }
        } catch (error) {
          return handleObjectQueryError(error, set)
        }
      },
      {
        detail: {
          summary: "Query objects",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "queryObjects",
          security: bearerSecurityRequirement("queryObjects"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ObjectQueryRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Response for status 200",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryResponse" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryErrorResponse" },
                },
              },
            },
            403: {
              description: "Response for status 403",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            500: {
              description: "Response for status 500",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      }
    )
    .post(
      "/api/objects/query/count",
      async (context) => {
        const { body, set } = context
        try {
          const parsed = ObjectQueryCountRequestSchema.parse(body) as {
            query: ObjectQuery
          }
          const result = await requireRequestSdk(context).objects.count({ query: parsed.query })

          return {
            count: result.count,
            plan: serializePlan(result.plan),
          }
        } catch (error) {
          return handleObjectQueryError(error, set)
        }
      },
      {
        detail: {
          summary: "Count objects",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "countObjects",
          security: bearerSecurityRequirement("countObjects"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ObjectQueryCountRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Response for status 200",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryCountResponse" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryErrorResponse" },
                },
              },
            },
            403: {
              description: "Response for status 403",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            500: {
              description: "Response for status 500",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      }
    )
    .post(
      "/api/objects/query/exists",
      async (context) => {
        const { body, set } = context
        try {
          const parsed = ObjectQueryExistsRequestSchema.parse(body) as {
            query: ObjectQuery
          }
          const result = await requireRequestSdk(context).objects.exists({ query: parsed.query })

          return {
            exists: result.exists,
            plan: serializePlan(result.plan),
          }
        } catch (error) {
          return handleObjectQueryError(error, set)
        }
      },
      {
        detail: {
          summary: "Check object existence",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "existsObjects",
          security: bearerSecurityRequirement("existsObjects"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ObjectQueryExistsRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Response for status 200",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryExistsResponse" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryErrorResponse" },
                },
              },
            },
            403: {
              description: "Response for status 403",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            500: {
              description: "Response for status 500",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      }
    )
    .post(
      "/api/objects/query/facets",
      async (context) => {
        const { body, set } = context
        try {
          const parsed = ObjectQueryFacetsRequestSchema.parse(body) as {
            query: ObjectQuery
            facets: { propertyId: string; limit: number }[]
          }
          const result = await requireRequestSdk(context).objects.facet({
            query: parsed.query,
            facets: parsed.facets,
          })

          return {
            facets: result.facets,
            plan: serializePlan(result.plan),
          }
        } catch (error) {
          return handleObjectQueryError(error, set)
        }
      },
      {
        detail: {
          summary: "Facet objects",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "facetObjects",
          security: bearerSecurityRequirement("facetObjects"),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ObjectQueryFacetsRequest" },
              },
            },
          },
          responses: {
            200: {
              description: "Response for status 200",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryFacetsResponse" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ObjectQueryErrorResponse" },
                },
              },
            },
            403: {
              description: "Response for status 403",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            500: {
              description: "Response for status 500",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/files/content",
      (context) => objectFileContentResponse(sixb, context),
      {
        params: ObjectParamsSchema,
        // Register the loose query so framework validation only requires `path`;
        // the handler applies the stricter `^/properties` check and returns a
        // consistent `{ error }` 400. Registering the strict schema here would
        // make Elysia emit its own 422 validation body, breaking that contract.
        query: FileContentQuerySchema,
        // No top-level `response` map: Elysia's OpenAPI builder resets responses
        // to JSON-only whenever one is present, which would erase the binary
        // `application/octet-stream` bodies. Declaring every status in
        // `detail.responses` keeps the binary content in the spec.
        detail: {
          summary: "Get object file content",
          tags: [OPENAPI_TAGS.objectFiles.name],
          operationId: "getObjectFileContent",
          security: bearerSecurityRequirement("getObjectFileContent"),
          responses: fileContentGetResponses(),
        },
      }
    )
    .head(
      "/api/objects/:objectTypeId/:objectId/files/content",
      (context) => objectFileContentResponse(sixb, context, { head: true }),
      {
        params: ObjectParamsSchema,
        // See the GET route: register the loose query so the handler owns the
        // strict `^/properties` check and its consistent 400.
        query: FileContentQuerySchema,
        // See the GET route: no top-level `response` map, so the binary responses
        // declared in `detail.responses` survive into the spec.
        detail: {
          summary: "Head object file content",
          tags: [OPENAPI_TAGS.objectFiles.name],
          operationId: "headObjectFileContent",
          security: bearerSecurityRequirement("headObjectFileContent"),
          responses: fileContentHeadResponses(),
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId",
      async (context) => {
        const { params, set } = context
        const sdk = requireRequestSdk(context)

        try {
          const row = await getObjectRow(sdk, params)
          if (!row) {
            set.status = 404
            return { error: "Object not found" }
          }

          return serializeObject(row)
        } catch (error) {
          // Identity reads hide existence: forbidden and missing look the same.
          if (error instanceof AuthorizationError) {
            set.status = 404
            return { error: "Object not found" }
          }

          throw error
        }
      },
      {
        params: ObjectParamsSchema,
        response: { 200: TwinObjectSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get object by id",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "getObject",
          security: bearerSecurityRequirement("getObject"),
        },
      }
    )
    .put(
      "/api/objects/:objectTypeId/:objectId",
      async (context) => {
        const { params, body, set } = context
        const sdk = requireRequestSdk(context)
        try {
          const parsedBody = UpsertObjectBodySchema.parse(body)
          // Scoped when a principal is attached, privileged only when auth is off or the request is
          // public — the same fallback the read routes use. Scoped for the primary-property lookup
          // too: on the privileged runtime it answers 404 for an unregistered type before any grant
          // is checked, which told an ungranted principal apart from a registered type (403) and so
          // handed back the type universe that `listObjectTypes` filters out.
          const primaryPropertyId = sdk.objects.getPrimaryPropertyId(params.objectTypeId)
          const properties = { ...parsedBody.properties, [primaryPropertyId]: params.objectId }
          const object = await sdk.objects.upsert(params.objectTypeId, properties)
          return serializeObject(object)
        } catch (error) {
          // Was a local catch mapping every error to 404/400, which turned a missing grant into
          // "bad request". `handleRouteError` answers 403 for AuthorizationError, like the link and
          // telemetry writes already did.
          return handleRouteError(error, set)
        }
      },
      {
        params: ObjectParamsSchema,
        body: UpsertObjectBodySchema,
        response: {
          200: TwinObjectSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Create or update object",
          tags: [OPENAPI_TAGS.objects.name],
          operationId: "upsertObject",
          security: bearerSecurityRequirement("upsertObject"),
        },
      }
    )
}
