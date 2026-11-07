import type { SixbHostView } from "@sixb/core"
import { getLakeRetentionRuntime } from "@sixb/core/internal/runtime"
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
        const { settings, maintenance } = getLakeRetentionRuntime(host)
        const cleanup = {
          enabled: settings.enabled,
          keepVersionsFor: settings.keepVersionsFor,
          deleteFilesAfter: settings.deleteFilesAfter,
          cleanupEvery: settings.cleanupEvery,
        }
        if (maintenance === null) return { available: false, cleanup, datasets: [] }

        // The datasets the caller may view, as `/api/datasets` lists them.
        const datasetIds = sixb.datasets.list().map((dataset) => dataset.id)
        const datasets = datasetIds.length > 0 ? await maintenance.describeStorage(datasetIds) : []

        return LakeHealthResponseSchema.parse({ available: true, cleanup, datasets })
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      response: { 200: LakeHealthResponseSchema, 400: ErrorResponseSchema },
      detail: {
        summary: "Describe how the lake stores each dataset, and its retention settings",
        tags: [OPENAPI_TAGS.datasets.name],
        operationId: "getLakeHealth",
        security: accessTokenSecurityRequirement("getLakeHealth"),
      },
    }
  )
}
