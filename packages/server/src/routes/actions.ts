import type { ActionDefinition, OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import {
  ActionCatalogItemSchema,
  ActionIdParamsSchema,
  RequestActionBodySchema,
} from "../schemas/actions"
import { ActionRequestedResponseSchema, ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

function serializeAction(
  action: ActionDefinition
): ReturnType<typeof ActionCatalogItemSchema.parse> {
  return ActionCatalogItemSchema.parse({
    id: action.id,
    name: action.id,
    description: action.description,
    binding:
      action.binding.kind === "global"
        ? { kind: "global" }
        : { kind: "object", objectTypeId: action.binding.objectType.id },
    params: Object.entries(action.params).map(([id, config]) => ({
      id,
      name: id,
      schema: config.schema,
      required: config.required ?? false,
      description: config.description,
      semanticType: config.semanticType,
    })),
  })
}

export function registerActionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/actions",
      async () => {
        return sixb.getActionDefinitions().map(serializeAction)
      },
      {
        response: { 200: ActionCatalogItemSchema.array() },
        detail: {
          summary: "List registered actions",
          tags: ["Actions"],
          operationId: "listActions",
        },
      }
    )
    .get(
      "/api/actions/:actionId",
      async ({ params, set }) => {
        const action = sixb.getActionById(params.actionId)
        if (!action) {
          set.status = 404
          return { error: "Action not found" }
        }

        return serializeAction(action)
      },
      {
        params: ActionIdParamsSchema,
        response: { 200: ActionCatalogItemSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get action metadata",
          tags: ["Actions"],
          operationId: "getAction",
        },
      }
    )
    .post(
      "/api/actions/:actionId",
      async ({ params, body, set }) => {
        try {
          const parsedBody = RequestActionBodySchema.parse(body)
          const { runId } = await sixb.actions.request({
            actionId: params.actionId,
            subject: parsedBody.subject,
            params: parsedBody.params,
            runId: parsedBody.runId,
          })

          return { success: true, runId }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ActionIdParamsSchema,
        body: RequestActionBodySchema,
        response: {
          200: ActionRequestedResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request an action",
          tags: ["Actions"],
          operationId: "requestAction",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
