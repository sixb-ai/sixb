import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { ErrorResponseSchema } from "../schemas/common"
import { EventsQuerySchema, EventsResponseSchema } from "../schemas/events"
import { parseOptionalInt } from "../utils/http"

export function registerEventRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app.get(
    "/api/events",
    async ({ query, set }) => {
      try {
        const parsed = EventsQuerySchema.parse(query)
        const events = await sixb.events.read({
          topics: parsed.topic ? [parsed.topic] : undefined,
          types: parsed.type ? [parsed.type] : undefined,
          afterCursor: parsed.afterCursor,
          limit: parseOptionalInt(parsed.limit),
        })

        return {
          count: events.length,
          events: [...events],
        }
      } catch (error) {
        set.status = 400
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      query: EventsQuerySchema,
      response: { 200: EventsResponseSchema, 400: ErrorResponseSchema },
      detail: {
        summary: "Read domain events",
        tags: ["Events"],
        operationId: "listEvents",
      },
    }
  )
}
