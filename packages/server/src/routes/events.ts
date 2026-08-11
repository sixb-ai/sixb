import { AuthorizationError, type SixbHostRuntime } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { EventsQuerySchema, EventsResponseSchema } from "../schemas/events"
import { parseOptionalInt } from "../utils/http"
export function registerEventRoutes(app: Elysia, _host: SixbHostRuntime) {
  return app.get(
    "/api/events",
    async (context) => {
      const { query, set } = context
      const sixb = requireRequestSixb(context)

      try {
        const parsed = EventsQuerySchema.parse(query)
        const input = {
          topics: parsed.topic ? [parsed.topic] : undefined,
          types: parsed.type ? [parsed.type] : undefined,
          afterCursor: parsed.afterCursor,
          limit: parseOptionalInt(parsed.limit),
        }
        const events = await sixb.events.read(input)

        return {
          count: events.length,
          events: [...events],
        }
      } catch (error) {
        if (error instanceof AuthorizationError) {
          set.status = 403
          return { error: error.message }
        }

        set.status = 400
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      query: EventsQuerySchema,
      response: {
        200: EventsResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
      detail: {
        summary: "Read domain events",
        tags: [OPENAPI_TAGS.events.name],
        operationId: "listEvents",
        security: bearerSecurityRequirement("listEvents"),
      },
    }
  )
}
