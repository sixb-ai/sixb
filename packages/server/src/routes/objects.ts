import {
  AuthorizationError,
  countObjects,
  executeObjectQuery,
  existsObjects,
  facetObjects,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
  type OntologySource,
  type Sixb,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { requestAuthState } from "../auth/scope"
import {
  SIXB_BEARER_SECURITY_REQUIREMENT,
  SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
  SIXB_CSRF_SECURITY_REQUIREMENT,
} from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
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
          security: SIXB_BEARER_SECURITY_REQUIREMENT,
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
            objects: result.objects.map(serializeObject),
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
          security: SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
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
          security: SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
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
          security: SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
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
          security: SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT,
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
          security: SIXB_BEARER_SECURITY_REQUIREMENT,
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
