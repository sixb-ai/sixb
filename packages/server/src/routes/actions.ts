import type { ActionDefinition, SixbHostView } from "@sixb/core"
import { schemaFieldsToJsonSchema } from "@sixb/core/internal/ontology"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ActionCatalogItemSchema,
  ActionDetailSchema,
  ActionIdParamsSchema,
  RequestActionBodySchema,
  RequestActionResponseSchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

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

function serializeActionDetail(
  action: ActionDefinition,
  host: SixbHostView
): ReturnType<typeof ActionDetailSchema.parse> {
  return ActionDetailSchema.parse({
    ...serializeAction(action),
    inputSchema: schemaFieldsToJsonSchema({
      fields: action.params,
      valueTypesById: host.definitions.ontology.getValueTypesById(),
    }),
  })
}

export function registerActionRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/actions",
      async (context) => {
        const actions = requireRequestSixb(context).actions.list()
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
        const action = requireRequestSixb(context).actions.getById(params.actionId)
        if (!action) {
          set.status = 404
          return { error: "Action not found" }
        }

        return serializeActionDetail(action, host)
      },
      {
        params: ActionIdParamsSchema,
        response: { 200: ActionDetailSchema, 404: ErrorResponseSchema },
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
        const sixb = requireRequestSixb(context)
        try {
          const parsedBody = RequestActionBodySchema.parse(body)
          const input = {
            actionId: params.actionId,
            subject: parsedBody.subject,
            params: parsedBody.params,
            runId: parsedBody.runId,
          }
          const result = await sixb.actions.request(input)

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
