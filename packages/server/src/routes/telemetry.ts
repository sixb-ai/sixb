import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import {
  AppendTelemetryBodySchema,
  TelemetryHistoryQuerySchema,
  TelemetryParamsSchema,
  TelemetryPointSchema,
} from "../schemas/telemetry"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

export function registerTelemetryRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .post(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId",
      async ({ params, body, set }) => {
        try {
          const parsedBody = AppendTelemetryBodySchema.parse(body)
          await pario.appendTelemetry(params.objectTypeId, [
            {
              id: params.objectId,
              properties: {
                [params.propertyId]: parsedBody.unit
                  ? { value: parsedBody.value, unit: parsedBody.unit }
                  : parsedBody.value,
              },
              at: parseDate(parsedBody.at),
            },
          ])

          return { success: true }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: TelemetryParamsSchema,
        body: AppendTelemetryBodySchema,
        response: {
          200: SuccessResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Append telemetry point",
          tags: ["Telemetry"],
          operationId: "appendTelemetry",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
      async ({ params, query, set }) => {
        try {
          const parsedQuery = TelemetryHistoryQuerySchema.parse(query)
          const history = await pario.storage.timeseries.getHistory({
            projectId: pario.id,
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            propertyId: params.propertyId,
            from: parseDate(parsedQuery.from),
            to: parseDate(parsedQuery.to),
            limit: parseOptionalInt(parsedQuery.limit),
            order: parsedQuery.order,
          })

          return history.map((point) => ({
            ...point,
            at: toIsoString(point.at),
          }))
        } catch (error) {
          set.status = 400
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        params: TelemetryParamsSchema,
        query: TelemetryHistoryQuerySchema,
        response: { 200: TelemetryPointSchema.array(), 400: ErrorResponseSchema },
        detail: {
          summary: "Get telemetry history",
          tags: ["Telemetry"],
          operationId: "getTelemetryHistory",
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
      async ({ params, set }) => {
        const latest = await pario.storage.timeseries.getLatest({
          projectId: pario.id,
          objectTypeId: params.objectTypeId,
          objectId: params.objectId,
          propertyId: params.propertyId,
        })

        if (!latest) {
          set.status = 404
          return { error: "Telemetry point not found" }
        }

        return {
          ...latest,
          at: toIsoString(latest.at),
        }
      },
      {
        params: TelemetryParamsSchema,
        response: { 200: TelemetryPointSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get latest telemetry point",
          tags: ["Telemetry"],
          operationId: "getLatestTelemetry",
        },
      }
    )
}
