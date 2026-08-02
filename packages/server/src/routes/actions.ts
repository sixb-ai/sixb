import type { ActionDefinition, OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ActionCatalogItemSchema,
  ActionIdParamsSchema,
  RequestActionBodySchema,
  RequestActionResponseSchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { errorResponse, handleRouteError } from "../utils/http"

function serializeAction(
  action: ActionDefinition
): ReturnType<typeof ActionCatalogItemSchema.parse> {
  return ActionCatalogItemSchema.parse({
    id: action.id,
    name: action.id,
    description: action.description,
    ...(action.binding.kind === "object" ? { objectTypeId: action.binding.objectType.id } : {}),
    params: Object.entries(action.params).map(([id, config]) => ({
      id,
      name: id,
      schema: config.schema,
      required: config.required ?? false,
      nullable: config.nullable,
      description: config.description,
      semanticType: config.semanticType,
    })),
    phases: {
      validate: action.phases.validate.length > 0,
      writeback: action.phases.writeback !== undefined,
      edits: action.phases.edits !== undefined,
      effects: action.phases.effects !== undefined,
    },
  })
}

export function registerActionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/actions",
      async (context) => {
        const { scoped } = requestAuthState(context)
        const actions = scoped ? scoped.listActions() : sixb.listActions()
        return actions.map(serializeAction)
      },
      {
        response: { 200: ActionCatalogItemSchema.array() },
        detail: {
          summary: "List registered actions",
          tags: [OPENAPI_TAGS.actions.name],
          operationId: "listActions",
          security: bearerSecurityRequirement("listActions"),
        },
      }
    )
    .get(
      "/api/actions/:actionId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        const action = scoped
          ? scoped.getActionById(params.actionId)
          : sixb.getActionById(params.actionId)
        if (!action) {
          return errorResponse(set, "action.not_found", "Action not found")
        }

        return serializeAction(action)
      },
      {
        params: ActionIdParamsSchema,
        response: { 200: ActionCatalogItemSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get action metadata",
          tags: [OPENAPI_TAGS.actions.name],
          operationId: "getAction",
          security: bearerSecurityRequirement("getAction"),
        },
      }
    )
    .post(
      "/api/actions/:actionId",
      async (context) => {
        const { params, body, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const parsedBody = RequestActionBodySchema.parse(body)
          const input = {
            actionId: params.actionId,
            subject: parsedBody.subject,
            params: parsedBody.params,
            runId: parsedBody.runId,
          }
          const result = scoped
            ? await scoped.requestAction(input)
            : await sixb.actions.request(input)

          set.status = 202
          return RequestActionResponseSchema.parse(result)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ActionIdParamsSchema,
        body: RequestActionBodySchema,
        response: {
          202: RequestActionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request an action",
          tags: [OPENAPI_TAGS.actions.name],
          operationId: "requestAction",
          security: bearerSecurityRequirement("requestAction"),
        },
      }
    )
}
