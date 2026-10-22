import type { SixbHostView } from "@sixb/core"
import type { FileRef } from "@sixb/core/blob-storage/server"
import {
  type ModelCallCost,
  ModelProviderError,
  ModelStreamError,
  type ModelUsage,
} from "@sixb/core/models"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { AiUsageLimitErrorResponseSchema, ErrorResponseSchema } from "../schemas/common"
import {
  FileGenerationSchema,
  ImageGenerationBodySchema,
  SpeechGenerationBodySchema,
  TextGenerationBodySchema,
  TextGenerationSchema,
  TranscriptionBodySchema,
  TranscriptionSchema,
} from "../schemas/models"
import { handleRouteError } from "../utils/http"

type ModelKind = "language" | "image" | "speech" | "transcription"

interface ModelRef {
  readonly provider: string
  readonly modelId: string
}

/** Thrown before the call when a request names a model the catalog does not have. */
class UnknownModelError extends Error {
  constructor(
    readonly kind: ModelKind,
    readonly ref: ModelRef | undefined
  ) {
    super(
      ref
        ? `[SixbServer] No ${kind} model '${ref.provider}/${ref.modelId}' is configured. GET /api/models lists them.`
        : `[SixbServer] No ${kind} models are configured.`
    )
  }
}

interface CatalogKind<TModel> {
  readonly default: ModelRef & { readonly model: TModel }
  getByRef(ref: ModelRef): (ModelRef & { readonly model: TModel }) | null
}

/** The catalog's binding: the requested one, or the kind's default. */
function selectBinding<TModel>(
  catalog: CatalogKind<TModel> | undefined,
  kind: ModelKind,
  ref: ModelRef | undefined
): ModelRef & { readonly model: TModel } {
  const entry = ref ? catalog?.getByRef(ref) : catalog?.default
  if (!entry) throw new UnknownModelError(kind, ref)
  return entry
}

function result(
  entry: ModelRef,
  call: { readonly callId: string; readonly usage: ModelUsage; readonly cost: ModelCallCost }
) {
  const { raw: _, ...usage } = call.usage
  const cost = call.cost
  return {
    callId: call.callId,
    model: { provider: entry.provider, modelId: entry.modelId },
    usage,
    cost: {
      status: cost.status,
      ...("money" in cost ? { money: cost.money } : {}),
      ...(cost.status === "unpriceable" ? { reason: cost.reason } : {}),
    },
  }
}

function generationError(error: unknown, set: { status?: number | string }) {
  if (error instanceof UnknownModelError) {
    set.status = error.ref ? 400 : 404
    return { error: error.message }
  }
  // The provider failed or answered with something unusable; the request itself was fine.
  if (error instanceof ModelProviderError || error instanceof ModelStreamError) {
    set.status = 502
    return { error: error.message }
  }
  return handleRouteError(error, set)
}

const responses = {
  400: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: AiUsageLimitErrorResponseSchema,
  502: ErrorResponseSchema,
}

function detail(operationId: string, summary: string) {
  return {
    summary,
    tags: [OPENAPI_TAGS.models.name],
    operationId,
    security: accessTokenSecurityRequirement(operationId),
  }
}

/**
 * Call the project's models directly. Each route makes the same runtime call project code does, in
 * the request's execution, so accounting, AI limits and the files record apply unchanged. Calls
 * need `can.run(project.models)`.
 */
export function registerModelGenerationRoutes(app: Elysia, host: SixbHostView) {
  const catalog = () => host.definitions.models

  return app
    .post(
      "/api/models/language/generations",
      async (context) => {
        const { body, request, set } = context
        try {
          const sixb = requireRequestSixb(context)
          const entry = selectBinding(catalog()?.language, "language", body.model)
          const call = await sixb.models.language.generate({
            model: entry.model,
            prompt: body.prompt,
            ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
            ...(body.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: body.maxOutputTokens }),
            ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
            signal: request.signal,
          })
          return TextGenerationSchema.parse({
            ...result(entry, call),
            text: call.output,
            finishReason: call.finishReason,
          })
        } catch (error) {
          return generationError(error, set)
        }
      },
      {
        body: TextGenerationBodySchema,
        response: { 200: TextGenerationSchema, ...responses },
        detail: detail("generateText", "Generate text with a language model"),
      }
    )
    .post(
      "/api/models/image/generations",
      async (context) => {
        const { body, request, set } = context
        try {
          const sixb = requireRequestSixb(context)
          const { model: ref, images, ...options } = body
          const entry = selectBinding(catalog()?.image, "image", ref)
          const call = await sixb.models.image.generate({
            ...options,
            ...(images === undefined ? {} : { images: images as readonly FileRef[] }),
            model: entry.model,
            signal: request.signal,
          })
          return FileGenerationSchema.parse({
            ...result(entry, call),
            files: call.files,
            warnings: call.warnings,
          })
        } catch (error) {
          return generationError(error, set)
        }
      },
      {
        body: ImageGenerationBodySchema,
        response: { 200: FileGenerationSchema, ...responses },
        detail: detail("generateImages", "Generate images with an image model"),
      }
    )
    .post(
      "/api/models/audio/speech",
      async (context) => {
        const { body, request, set } = context
        try {
          const sixb = requireRequestSixb(context)
          const { model: ref, ...options } = body
          const entry = selectBinding(catalog()?.audio?.speech, "speech", ref)
          const call = await sixb.models.audio.speak({
            ...options,
            model: entry.model,
            signal: request.signal,
          })
          return FileGenerationSchema.parse({
            ...result(entry, call),
            files: [call.file],
            warnings: call.warnings,
          })
        } catch (error) {
          return generationError(error, set)
        }
      },
      {
        body: SpeechGenerationBodySchema,
        response: { 200: FileGenerationSchema, ...responses },
        detail: detail("generateSpeech", "Generate speech with a speech model"),
      }
    )
    .post(
      "/api/models/audio/transcriptions",
      async (context) => {
        const { body, request, set } = context
        try {
          const sixb = requireRequestSixb(context)
          const entry = selectBinding(catalog()?.audio?.transcription, "transcription", body.model)
          const call = await sixb.models.audio.transcribe({
            audio: body.audio as FileRef,
            model: entry.model,
            signal: request.signal,
          })
          return TranscriptionSchema.parse({ ...result(entry, call), text: call.output.text })
        } catch (error) {
          return generationError(error, set)
        }
      },
      {
        body: TranscriptionBodySchema,
        response: { 200: TranscriptionSchema, ...responses },
        detail: detail("transcribeAudio", "Transcribe audio with a transcription model"),
      }
    )
}
