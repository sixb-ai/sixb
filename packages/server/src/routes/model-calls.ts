import type { SixbHostView } from "@sixb/core"
import type { ModelCallFiles } from "@sixb/core/models"
import type { Elysia } from "elysia"
import { z } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  handleFileContentQueryValidationError,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import { ModelCallFilesSchema, ModelCallParamsSchema } from "../schemas/models"
import { handleRouteError } from "../utils/http"

const ModelCallFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(/^\/files(?:\/|$)/, "Model call file content paths must start with /files/"),
})

function serializeModelCallFiles(call: ModelCallFiles) {
  return ModelCallFilesSchema.parse({
    callId: call.callId,
    files: call.files,
    recordedAt: call.recordedAt.toISOString(),
  })
}

async function modelCallFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly callId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const sixb = requireRequestSixb(context)
  return createContextualFileContentResponse({
    blobStorage: host.blobStorage,
    query: context.query,
    querySchema: ModelCallFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const call = await sixb.models.calls.files(context.params.callId)
      return call ? serializeModelCallFiles(call) : null
    },
  })
}

/** What a model call produced, as visible as the run that made it. */
export function registerModelCallRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/ai/model-calls/:callId/files",
      async (context) => {
        const { params, set } = context
        try {
          const call = await requireRequestSixb(context).models.calls.files(params.callId)
          if (!call) {
            set.status = 404
            return { error: "Model call not found" }
          }
          return serializeModelCallFiles(call)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ModelCallParamsSchema,
        response: { 200: ModelCallFilesSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get the files a model call produced",
          tags: [OPENAPI_TAGS.models.name],
          operationId: "getAiModelCallFiles",
          security: accessTokenSecurityRequirement("getAiModelCallFiles"),
        },
      }
    )
    .get(
      "/api/ai/model-calls/:callId/files/content",
      (context) => modelCallFileContentResponse(host, context),
      {
        params: ModelCallParamsSchema,
        query: ModelCallFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Get model call file content",
          tags: [OPENAPI_TAGS.models.name],
          operationId: "getAiModelCallFileContent",
          security: accessTokenSecurityRequirement("getAiModelCallFileContent"),
          responses: fileContentGetResponses(),
        },
      }
    )
    .head(
      "/api/ai/model-calls/:callId/files/content",
      (context) => modelCallFileContentResponse(host, context, { head: true }),
      {
        params: ModelCallParamsSchema,
        query: ModelCallFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Head model call file content",
          tags: [OPENAPI_TAGS.models.name],
          operationId: "headAiModelCallFileContent",
          security: accessTokenSecurityRequirement("headAiModelCallFileContent"),
          responses: fileContentHeadResponses(),
        },
      }
    )
}
