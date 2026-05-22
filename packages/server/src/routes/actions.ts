import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import type { ParioServerRuntime } from "../runtime"
import { ActionParamsSchema, RequestActionBodySchema } from "../schemas/actions"
import { ActionRequestedResponseSchema, ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

export function registerActionRoutes(app: Elysia, pario: ParioServerRuntime) {
  return app.post(
    "/api/objects/:objectTypeId/:objectId/actions/:actionId",
    async ({ params, body, set }) => {
      try {
        const parsedBody = RequestActionBodySchema.parse(body)
        const { runId } = await pario.requestAction(
          params.objectTypeId,
          params.objectId,
          params.actionId,
          parsedBody.params
        )

        return { success: true, runId }
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      params: ActionParamsSchema,
      body: RequestActionBodySchema,
      response: {
        200: ActionRequestedResponseSchema,
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
      detail: {
        summary: "Request an action on an object",
        tags: ["Actions"],
        operationId: "requestAction",
        security: PARIO_CSRF_SECURITY_REQUIREMENT,
      },
    }
  )
}
