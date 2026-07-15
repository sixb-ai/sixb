import type { OntologySource, Sixb } from "@sixb/core"
import type { WebhookRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { WebhookRunListResponseSchema, WebhookRunsQuerySchema } from "../schemas/webhook-runs"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

function serializeWebhookRun(run: WebhookRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    connectorId: run.connectorId,
    webhookId: run.webhookId,
    status: run.status,
    method: run.method,
    route: run.route,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    requestBodyBytes: run.requestBodyBytes,
    responseStatus: run.responseStatus,
    idempotencyKey: run.idempotencyKey,
    deliveryClaimResult: run.deliveryClaimResult,
    error: run.error,
  }
}

export function registerWebhookRunRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get(
    "/api/webhook-runs",
    async ({ query, set }) => {
      try {
        const parsed = WebhookRunsQuerySchema.parse(query)
        const storage = sixb.storage.webhookRuns
        if (!storage) {
          return {
            runs: [],
            hasMore: false,
            total: 0,
          }
        }

        const result = await storage.list({
          projectId: sixb.id,
          connectorId: parsed.connectorId,
          webhookId: parsed.webhookId,
          statuses: parsed.status ? [parsed.status] : undefined,
          idempotencyKey: parsed.idempotencyKey,
          startedAfter: parseDate(parsed.startedAfter),
          startedBefore: parseDate(parsed.startedBefore),
          limit: parseOptionalInt(parsed.limit),
          offset: parseOptionalInt(parsed.offset),
          order: parsed.order,
        })

        return {
          runs: result.runs.map(serializeWebhookRun),
          hasMore: result.hasMore,
          total: result.total,
        }
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: WebhookRunsQuerySchema,
      response: { 200: WebhookRunListResponseSchema, 400: ErrorResponseSchema },
      detail: {
        summary: "List webhook run history",
        tags: [OPENAPI_TAGS.webhooks.name],
        operationId: "listWebhookRuns",
      },
    }
  )
}
