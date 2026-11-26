import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { RunScheduleResponseSchema, ScheduleParamsSchema } from "../schemas/schedules"
import { handleRouteError } from "../utils/http"

/**
 * Run a cron schedule now, as its next occurrence would. What it starts runs as the schedule, not
 * as the caller, so it takes `can.manage(project.source)` besides the run grant of every sync,
 * pipeline and workflow the schedule starts, and stays session-only as running those does. A
 * branch answers 409 for one that starts a sync.
 */
export function registerScheduleRoutes(app: Elysia, _host: SixbHostView) {
  return app.post(
    "/api/schedules/:scheduleId/runs",
    async (context) => {
      const { params, set } = context
      const sixb = requireRequestSixb(context)

      if (!sixb.schedules.getById(params.scheduleId)) {
        set.status = 404
        return { error: `Schedule '${params.scheduleId}' was not found.` }
      }

      try {
        const result = await sixb.schedules.run(params.scheduleId)

        set.status = 202
        return result
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      params: ScheduleParamsSchema,
      response: {
        202: RunScheduleResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
      detail: {
        summary: "Run a cron schedule now",
        tags: [OPENAPI_TAGS.schedules.name],
        operationId: "runSchedule",
        security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
      },
    }
  )
}
