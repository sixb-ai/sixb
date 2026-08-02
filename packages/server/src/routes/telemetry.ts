import { isAllowed, type OntologySource, type Sixb } from "@sixb/core"
import { getTelemetryHistoryBatch } from "@sixb/core/internal/objects"
import type { TimeseriesPoint } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
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
import {
  errorResponse,
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
} from "../utils/http"

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

export function registerTelemetryRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .post(
      "/api/objects/:objectTypeId/:objectId/telemetry/:propertyId",
      async (context) => {
        const { params, body, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const parsedBody = AppendTelemetryBodySchema.parse(body)
          await (scoped ?? sixb).appendTelemetry(params.objectTypeId, [
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
        const { authz } = requestAuthState(context)
        try {
          const parsedBody = BulkTelemetryHistoryBodySchema.parse(body)
          const from = parseDate(parsedBody.from)
          const to = parseDate(parsedBody.to)
          const history = await getTelemetryHistoryBatch(
            {
              projectId: sixb.id,
              series: parsedBody.series,
              from,
              to,
              limitPerSeries: parsedBody.limitPerSeries,
              order: parsedBody.order,
            },
            { storage: sixb.storage.timeseries, authorization: authz }
          )

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
        const { authz } = requestAuthState(context)
        try {
          const parsedQuery = TelemetryHistoryQuerySchema.parse(query)
          if (!isAllowed(authz, { kind: "object.view", objectTypeId: params.objectTypeId })) {
            return errorResponse(set, "storage.object_not_found", "Object not found")
          }

          const history = await sixb.storage.timeseries.getHistory({
            projectId: sixb.id,
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
        const { authz } = requestAuthState(context)
        try {
          if (!isAllowed(authz, { kind: "object.view", objectTypeId: params.objectTypeId })) {
            return errorResponse(set, "storage.object_not_found", "Object not found")
          }

          const latest = await sixb.storage.timeseries.getLatest({
            projectId: sixb.id,
            objectTypeId: params.objectTypeId,
            objectId: params.objectId,
            propertyId: params.propertyId,
          })

          if (!latest) {
            return errorResponse(set, "telemetry.point_not_found", "Telemetry point not found")
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
