import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { EventsQuerySchema, EventsResponseSchema } from "../schemas/events"
import { handleRouteError, parseOptionalInt } from "../utils/http"
export function registerEventRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get(
    "/api/events",
    async (context) => {
      const { query, set } = context
      const { scoped } = requestAuthState(context)

      try {
        const parsed = EventsQuerySchema.parse(query)
        const input = {
          topics: parsed.topic ? [parsed.topic] : undefined,
          types: parsed.type ? [parsed.type] : undefined,
          afterCursor: parsed.afterCursor,
          limit: parseOptionalInt(parsed.limit),
        }
        const events = scoped ? await scoped.readEvents(input) : await sixb.events.read(input)

        return {
          count: events.length,
          events: [...events],
        }
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: EventsQuerySchema,
      response: {
        200: EventsResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        // Reading the log is a broker read, and both shipped brokers answer `broker.unavailable`.
        503: ErrorResponseSchema,
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
