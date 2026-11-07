import type { SixbHostView } from "@sixb/core"
import { getLakeRetentionRuntime } from "@sixb/core/internal/runtime"
import type { DatasetIngestSummary } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { LakeHealthResponseSchema } from "../schemas/lake"
import { handleRouteError } from "../utils/http"

export function registerLakeRoutes(app: Elysia, host: SixbHostView) {
  return app.get(
    "/api/lake/health",
    async (context) => {
      const { set } = context
      const sixb = requireRequestSixb(context)

      try {
        const retention = getLakeRetentionRuntime(host)
        const { settings, maintenance } = retention
        const cleanup = {
          ...(await retention.status()),
          keepVersionsFor: settings.keepVersionsFor,
          deleteFilesAfter: settings.deleteFilesAfter,
          cleanupEvery: settings.cleanupEvery,
        }
        if (maintenance === null) return { available: false, cleanup, datasets: [] }

        // The datasets the caller may view, as `/api/datasets` lists them.
        const datasetIds = sixb.datasets.list().map((dataset) => dataset.id)
        if (datasetIds.length === 0) {
          return LakeHealthResponseSchema.parse({ available: true, cleanup, datasets: [] })
        }

        const [storage, waiting] = await Promise.all([
          maintenance.describeStorage(datasetIds),
          host.storage.datasetIngest?.summarize({ projectId: host.id, datasetIds }) ?? [],
        ])
        const waitingById = new Map(waiting.map((summary) => [summary.datasetId, summary]))
        const datasets = storage.map((dataset) => ({
          ...dataset,
          ingest: ingestWaiting(waitingById.get(dataset.datasetId)),
        }))

        return LakeHealthResponseSchema.parse({ available: true, cleanup, datasets })
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      response: { 200: LakeHealthResponseSchema, 400: ErrorResponseSchema },
      detail: {
        summary: "Describe how the lake stores each dataset, and what its retention does",
        tags: [OPENAPI_TAGS.datasets.name],
        operationId: "getLakeHealth",
        security: accessTokenSecurityRequirement("getLakeHealth"),
      },
    }
  )
}

/** What waits for a flush, or null when nothing does. */
function ingestWaiting(summary: DatasetIngestSummary | undefined) {
  if (!summary?.oldestReceivedAt || summary.pendingDeliveries === 0) return null

  return {
    pendingDeliveries: summary.pendingDeliveries,
    pendingChanges: summary.pendingChanges,
    oldestReceivedAt: summary.oldestReceivedAt.toISOString(),
  }
}
