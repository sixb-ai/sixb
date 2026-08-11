import type { SixbHostRuntime } from "@sixb/core"
import type { TimeseriesPoint } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import {
  AppendTelemetryBodySchema,
  BulkTelemetryHistoryBodySchema,
  BulkTelemetryHistoryResponseSchema,
  TelemetryHistoryQuerySchema,
  TelemetryParamsSchema,
  TelemetryPointSchema,
} from "../schemas/telemetry"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

function serializeTelemetryPoint(point: TimeseriesPoint) {
  return {
    projectId: point.projectId,
    objectTypeId: point.objectTypeId,
    objectId: point.objectId,
    propertyId: point.propertyId,
    value: point.value,
    ...(point.unit === undefined ? {} : { unit: point.unit }),
    at: toIsoString(point.at),
  }
}

export function registerTelemetryRoutes(app: Elysia, _host: SixbHostRuntime) {
  return app
    .post(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId",
      async (context) => {
        const { params, body, set } = context
        try {
          const parsedBody = AppendTelemetryBodySchema.parse(body)
          await requireRequestSixb(context).objects.appendTelemetry(params.objectTypeId, [
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
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Append telemetry point",
          tags: [OPENAPI_TAGS.telemetry.name],
          operationId: "appendTelemetry",
          security: bearerSecurityRequirement("appendTelemetry"),
        },
      }
    )
    .post(
      "/api/telemetry/history",
      async (context) => {
        const { body, set } = context
        try {
          const parsedBody = BulkTelemetryHistoryBodySchema.parse(body)
          const from = parseDate(parsedBody.from)
          const to = parseDate(parsedBody.to)
          const history = await requireRequestSixb(context).objects.getTelemetryHistoryBatch({
            series: parsedBody.series,
            from,
            to,
            limitPerSeries: parsedBody.limitPerSeries,
            order: parsedBody.order,
          })

          return {
            series: history.map((series) => ({
              ...series,
              points: series.points.map(serializeTelemetryPoint),
            })),
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        body: BulkTelemetryHistoryBodySchema,
        response: {
          200: BulkTelemetryHistoryResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
        detail: {
          summary: "Get bulk telemetry history",
          tags: [OPENAPI_TAGS.telemetry.name],
          operationId: "getBulkTelemetryHistory",
          security: bearerSecurityRequirement("getBulkTelemetryHistory"),
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/history",
      async (context) => {
        const { params, query, set } = context
        try {
          const sixb = requireRequestSixb(context)
          if (!sixb.objects.getTypeById(params.objectTypeId)) {
            set.status = 404
            return { error: "Object not found" }
          }
          const parsedQuery = TelemetryHistoryQuerySchema.parse(query)
          const history = await sixb.objects.getTelemetryHistory({
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            propertyId: params.propertyId,
            from: parseDate(parsedQuery.from),
            to: parseDate(parsedQuery.to),
            limit: parseOptionalInt(parsedQuery.limit),
            order: parsedQuery.order,
          })

          return history.map(serializeTelemetryPoint)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: TelemetryParamsSchema,
        query: TelemetryHistoryQuerySchema,
        response: {
          200: TelemetryPointSchema.array(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get telemetry history",
          tags: [OPENAPI_TAGS.telemetry.name],
          operationId: "getTelemetryHistory",
          security: bearerSecurityRequirement("getTelemetryHistory"),
        },
      }
    )
    .get(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId/latest",
      async (context) => {
        const { params, set } = context
        try {
          const sixb = requireRequestSixb(context)
          if (!sixb.objects.getTypeById(params.objectTypeId)) {
            set.status = 404
            return { error: "Object not found" }
          }
          const latest = await sixb.objects.getLatestTelemetry({
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            propertyId: params.propertyId,
          })

          if (!latest) {
            set.status = 404
            return { error: "Telemetry point not found" }
          }

          return serializeTelemetryPoint(latest)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: TelemetryParamsSchema,
        response: {
          200: TelemetryPointSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get latest telemetry point",
          tags: [OPENAPI_TAGS.telemetry.name],
          operationId: "getLatestTelemetry",
          security: bearerSecurityRequirement("getLatestTelemetry"),
        },
      }
    )
}
