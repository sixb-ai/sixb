import { logLevelsAtOrAbove, type SixbHostRuntime } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { DEFAULT_LOGS_PAGE_LIMIT, LogsQuerySchema, LogsResponseSchema } from "../schemas/logs"
import { handleRouteError } from "../utils/http"

export function registerLogRoutes(app: Elysia, _host: SixbHostRuntime) {
  return app.get(
    "/api/logs",
    async (context) => {
      const { query, set } = context
      const sixb = requireRequestSixb(context)

      try {
        const parsed = LogsQuerySchema.parse(query)
        const run =
          parsed.kind !== undefined && parsed.runId !== undefined
            ? { kind: parsed.kind, id: parsed.runId }
            : undefined
        const levels = parsed.level ? logLevelsAtOrAbove(parsed.level) : undefined
        const input = {
          kinds: parsed.kind ? [parsed.kind] : undefined,
          limit: parsed.limit ?? DEFAULT_LOGS_PAGE_LIMIT,
          levels,
          run,
        }
        const page =
          parsed.direction === "backward"
            ? await sixb.logs.tail({ ...input, beforeCursor: parsed.beforeCursor })
            : await sixb.logs.read({ ...input, afterCursor: parsed.afterCursor })

        return {
          count: page.lines.length,
          lines: [...page.lines],
          cursor: page.cursor,
          hasMore: page.hasMore,
        }
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: LogsQuerySchema,
      response: {
        200: LogsResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
      detail: {
        summary: "Read run logs",
        tags: [OPENAPI_TAGS.logs.name],
        operationId: "listLogs",
        security: bearerSecurityRequirement("listLogs"),
      },
    }
  )
}
