import { AuthorizationError, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { SIXB_BEARER_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import { EventsQuerySchema, EventsResponseSchema } from "../schemas/events"
import { parseOptionalInt } from "../utils/http"

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
        tags: ["Events"],
        operationId: "listEvents",
        security: SIXB_BEARER_SECURITY_REQUIREMENT,
      },
    }
  )
}
