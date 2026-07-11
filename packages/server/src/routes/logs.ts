import { isAllowed, type LogLevel, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { LogsQuerySchema, LogsResponseSchema } from "../schemas/logs"
import { parseOptionalInt } from "../utils/http"

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"]

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
          parsed.kind && parsed.runId ? { kind: parsed.kind, id: parsed.runId } : undefined
        const levels = parsed.level ? levelsAtOrAbove(parsed.level) : undefined
        const input = {
          kinds: parsed.kind ? [parsed.kind] : undefined,
          limit: parseOptionalInt(parsed.limit),
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

function levelsAtOrAbove(level: LogLevel): readonly LogLevel[] {
  return LOG_LEVELS.slice(LOG_LEVELS.indexOf(level))
}
