import { isAllowed, logLevelsAtOrAbove, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { DEFAULT_LOGS_PAGE_LIMIT, LogsQuerySchema, LogsResponseSchema } from "../schemas/logs"

export function registerLogRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get(
    "/api/logs",
    async (context) => {
      const { query, set } = context
      const { authz } = requestAuthState(context)

      if (!isAllowed(authz, { kind: "logs.observe" })) {
        set.status = 403
        return { error: "Missing required capability 'observe:logs'." }
      }

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
        set.status = 400
        return { error: error instanceof Error ? error.message : String(error) }
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
