import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import type { ParioServerRuntime } from "../runtime"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ObjectListResponseSchema,
  ObjectParamsSchema,
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

export function registerObjectRoutes(app: Elysia, pario: ParioServerRuntime) {
  return app
    .get(
      "/api/objects",
      async ({ query, set }) => {
        try {
          const parsed = ObjectsQuerySchema.parse(query)
          const result = await pario.list({
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
    .get(
      "/api/objects/:objectTypeId/:objectId",
      async ({ params, set }) => {
        const row = await pario.storage.objects.getByPrimaryId({
          projectId: pario.id,
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
          const primaryPropertyId = pario.getPrimaryPropertyId(params.objectTypeId)
          const properties = { ...parsedBody.properties, [primaryPropertyId]: params.objectId }
          const object = await pario.upsertObject(params.objectTypeId, properties)
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
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
