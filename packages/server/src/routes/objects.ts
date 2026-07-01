import {
  AuthorizationError,
  countObjects,
  type ExpandedLinkValue,
  type ExpandedObjectRow,
  executeObjectQuery,
  existsObjects,
  facetObjects,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
  type ObjectRowLinks,
  type OntologySource,
  type Sixb,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { createFileContentResponse, resolveFileRefAtPath } from "../files/content"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import {
  ObjectListResponseSchema,
  ObjectParamsSchema,
  ObjectQueryCountRequestSchema,
  ObjectQueryExistsRequestSchema,
  ObjectQueryFacetsRequestSchema,
  ObjectQueryRequestSchema,
  ObjectsQuerySchema,
  TwinObjectSchema,
  UpsertObjectBodySchema,
} from "../schemas/objects"
import { parseDate, parseOptionalInt, toIsoString } from "../utils/http"

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

function serializePlan(plan: Awaited<ReturnType<typeof executeObjectQuery>>["plan"]) {
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
  sixb: Sixb<readonly OntologySource[]>,
  scoped: ReturnType<typeof requestAuthState>["scoped"],
  params: { objectTypeId: string; objectId: string }
) {
  if (scoped) {
    return scoped.getObject(params.objectTypeId, params.objectId)
  }

  return sixb.storage.objects.getByPrimaryId({
    projectId: sixb.id,
    objectTypeId: params.objectTypeId,
    primaryId: params.objectId,
  })
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
  const { scoped } = requestAuthState(context)

  try {
    const parsed = ObjectFileContentQuerySchema.parse(context.query)
    const row = await getObjectRow(sixb, scoped, context.params)
    if (!row) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const fileRef = resolveFileRefAtPath(serializeObject(row), parsed.path)
    if (!fileRef) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const response = await createFileContentResponse({
      blobStorage: sixb.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      rangeHeader: context.request.headers.get("range"),
    })
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }

    return response
  } catch (error) {
    if (error instanceof AuthorizationError) {
      context.set.status = 404
      return { error: "File not found" }
    }

    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }

    throw error
  }
}

export function registerObjectRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/objects",
      async (context) => {
        const { query, set } = context
        const { scoped } = requestAuthState(context)

        try {
          const parsed = ObjectsQuerySchema.parse(query)
          const params = {
            objectTypeIds: parsed.objectTypeId ? [parsed.objectTypeId] : undefined,
            idPrefix: parsed.idPrefix,
            idSuffix: parsed.idSuffix,
            updatedAfter: parseDate(parsed.updatedAfter),
            updatedBefore: parseDate(parsed.updatedBefore),
            createdAfter: parseDate(parsed.createdAfter),
            createdBefore: parseDate(parsed.createdBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            orderBy: parsed.orderBy,
            order: parsed.order,
          }
          const result = scoped ? await scoped.list(params) : await sixb.list(params)

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
        detail: {
          summary: "List objects",
          tags: ["Objects"],
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
          const result = await executeObjectQuery(
            {
              projectId: sixb.id,
              query: parsed.query,
              includeTotal: parsed.includeTotal,
            },
            {
              ontology: sixb.ontology,
              storage: sixb.storage.objects,
              authorization: requestAuthState(context).authz ?? undefined,
            }
          )

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
          tags: ["Objects"],
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
          const result = await countObjects(
            {
              projectId: sixb.id,
              query: parsed.query,
            },
            {
              ontology: sixb.ontology,
              storage: sixb.storage.objects,
              authorization: requestAuthState(context).authz ?? undefined,
            }
          )

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
          tags: ["Objects"],
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
          const result = await existsObjects(
            {
              projectId: sixb.id,
              query: parsed.query,
            },
            {
              ontology: sixb.ontology,
              storage: sixb.storage.objects,
              authorization: requestAuthState(context).authz ?? undefined,
            }
          )

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
          tags: ["Objects"],
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
          const result = await facetObjects(
            {
              projectId: sixb.id,
              query: parsed.query,
              facets: parsed.facets,
            },
            {
              ontology: sixb.ontology,
              storage: sixb.storage.objects,
              authorization: requestAuthState(context).authz ?? undefined,
            }
          )

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
          tags: ["Objects"],
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
          tags: ["Objects"],
          operationId: "getObjectFileContent",
          security: bearerSecurityRequirement("getObjectFileContent"),
          responses: {
            200: {
              description: "File content",
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            206: {
              description: "Partial file content",
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            404: {
              description: "Response for status 404",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            416: {
              description: "Requested byte range is not satisfiable",
            },
          },
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
          tags: ["Objects"],
          operationId: "headObjectFileContent",
          security: bearerSecurityRequirement("headObjectFileContent"),
          responses: {
            200: {
              description: "File content headers",
            },
            206: {
              description: "Partial file content headers",
            },
            400: {
              description: "Response for status 400",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            404: {
              description: "Response for status 404",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
            416: {
              description: "Requested byte range is not satisfiable",
            },
          },
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)

        try {
          const row = await getObjectRow(sixb, scoped, params)
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
          tags: ["Objects"],
          operationId: "getObject",
          security: bearerSecurityRequirement("getObject"),
        },
      }
    )
    .put(
      "/api/objects/:objectTypeId/:objectId",
      async ({ params, body, set }) => {
        try {
          const parsedBody = UpsertObjectBodySchema.parse(body)
          const primaryPropertyId = sixb.getPrimaryPropertyId(params.objectTypeId)
          const properties = { ...parsedBody.properties, [primaryPropertyId]: params.objectId }
          const object = await sixb.upsertObject(params.objectTypeId, properties)
          return serializeObject(object)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          set.status = message.includes("Unknown object type") ? 404 : 400
          return { error: message }
        }
      },
      {
        params: ObjectParamsSchema,
        body: UpsertObjectBodySchema,
        response: { 200: TwinObjectSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Create or update object",
          tags: ["Objects"],
          operationId: "upsertObject",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
