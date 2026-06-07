import {
  executeObjectQuery,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
  type OntologySource,
  type Sixb,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ObjectListResponseSchema,
  ObjectParamsSchema,
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

export function registerObjectRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/objects",
      async ({ query, set }) => {
        try {
          const parsed = ObjectsQuerySchema.parse(query)
          const result = await sixb.list({
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
          })

          return {
            objects: result.objects.map(serializeObject),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          set.status = 400
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        query: ObjectsQuerySchema,
        response: { 200: ObjectListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List objects",
          tags: ["Objects"],
          operationId: "listObjects",
        },
      }
    )
    .post(
      "/api/objects/query",
      async ({ body, set }) => {
        try {
          const parsed = ObjectQueryRequestSchema.parse(body) as { query: ObjectQuery }
          const result = await executeObjectQuery(
            {
              projectId: sixb.id,
              query: parsed.query,
            },
            {
              ontology: sixb.ontology,
              storage: sixb.storage.objects,
            }
          )

          return {
            objects: result.objects.map(serializeObject),
            hasMore: result.hasMore,
            total: result.total,
            nextPageToken: result.nextPageToken,
            plan: serializePlan(result.plan),
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
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
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
      async ({ params, set }) => {
        const row = await sixb.storage.objects.getByPrimaryId({
          projectId: sixb.id,
          objectTypeId: params.objectTypeId,
          primaryId: params.objectId,
        })

        if (!row) {
          set.status = 404
          return { error: "Object not found" }
        }

        return serializeObject(row)
      },
      {
        params: ObjectParamsSchema,
        response: { 200: TwinObjectSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get object by id",
          tags: ["Objects"],
          operationId: "getObject",
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
