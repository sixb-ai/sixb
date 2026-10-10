import type { ActionDescriptor, SixbHostView } from "@sixb/core"
import { schemaFieldsToJsonSchema } from "@sixb/core/internal/ontology"
import type { Elysia } from "elysia"
import { serializeActionRunDetail } from "../actions/serialize"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ActionCatalogItemSchema,
  ActionDetailSchema,
  ActionIdParamsSchema,
  ActionRequestFailedResponseSchema,
  ActionRunDetailSchema,
  ActionRunInProgressResponseSchema,
  RequestActionBodySchema,
  RuntimeStoppingResponseSchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

function serializeAction(
  action: ActionDescriptor
): ReturnType<typeof ActionCatalogItemSchema.parse> {
  return ActionCatalogItemSchema.parse({
    id: action.id,
    name: action.id,
    description: action.description,
    ...(action.binding.kind === "object" ? { objectTypeId: action.binding.objectTypeId } : {}),
    params: Object.entries(action.params).map(([id, config]) => ({
      id,
      name: id,
      schema: config.schema,
      required: config.required ?? false,
      nullable: config.nullable,
      description: config.description,
      semanticType: config.semanticType,
    })),
    phases: action.phases,
  })
}

function serializeActionDetail(
  action: ActionDescriptor,
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
          security: accessTokenSecurityRequirement("listActions"),
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
          security: accessTokenSecurityRequirement("getAction"),
        },
      }
    )
    .post(
      "/api/actions/:actionId",
      async (context) => {
        const { params, body, set, request, server } = context
        // An Action can outlast Bun's 10-second idle timeout: it has 30 seconds to reach its
        // boundary, then edits that nothing interrupts, then up to 30 seconds of effects.
        server?.timeout(request, 0)

        const sixb = requireRequestSixb(context)
        try {
          const parsedBody = RequestActionBodySchema.parse(body)
          // No `request.signal`: a client that disconnects never cancels the run. Retrying with
          // the same `runId` returns its record once it is terminal.
          const run = await sixb.actions.request({
            actionId: params.actionId,
            subject: parsedBody.subject,
            params: parsedBody.params,
            runId: parsedBody.runId,
          })

          return serializeActionRunDetail(run)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ActionIdParamsSchema,
        body: RequestActionBodySchema,
        response: {
          200: ActionRunDetailSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ActionRunInProgressResponseSchema,
          500: ActionRequestFailedResponseSchema,
          503: RuntimeStoppingResponseSchema,
        },
        detail: {
          summary: "Request an action",
          description:
            "Runs the action and returns its terminal run. A run that fails is returned with " +
            "status `failed`. Its effects run after the response, which does not wait for them. " +
            "An error response usually means no run was requested, but a 500 can follow a run " +
            "that started: request again with the same `runId` to get its record if it was " +
            "written. A `runId` that was already recorded returns that run, and 409 while this " +
            "server still runs it. 503 means the server is stopping and started nothing.",
          tags: [OPENAPI_TAGS.actions.name],
          operationId: "requestAction",
          security: accessTokenSecurityRequirement("requestAction"),
        },
      }
    )
}
