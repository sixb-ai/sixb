import type { AudioData, LanguageModelCatalog, LanguageModelTier, SixbHostView } from "@sixb/core"
import type { FileRef } from "@sixb/core/blob-storage/server"
import { selectLanguageModel } from "@sixb/core/internal/model-execution"
import {
  type LanguageModel,
  type ModelCallCost,
  ModelProviderError,
  ModelStreamError,
  type ModelUsage,
} from "@sixb/core/models"
import type { Elysia } from "elysia"
import type { z } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { jsonRequestBody } from "../openapi/components"
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
import { readRequestBodyWithLimit } from "../utils/request-body"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES } from "./files"

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

/** The requested binding, or a tier's model as `generate({ model: tier })` selects it. */
function selectLanguageBinding(
  catalog: LanguageModelCatalog | undefined,
  model: ModelRef | LanguageModelTier | undefined
): LanguageModel {
  if (typeof model !== "string") return selectBinding(catalog, "language", model).model

  const selected = selectLanguageModel(catalog, model)
  if (!selected) throw new UnknownModelError("language", undefined)
  return selected
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

/** Allows what a file upload may carry, so minutes of base64 dictation pass the 1 MB default. */
async function readTranscriptionBody(request: Request): Promise<TranscriptionBody> {
  const bytes = await readRequestBodyWithLimit(request, DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES)

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new TypeError("[SixbServer] Transcription request body must be JSON.")
  }

  const parsed = TranscriptionBodySchema.safeParse(json)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    throw new TypeError(
      `[SixbServer] Invalid transcription request: ${issue?.path.join(".") || "body"}: ${issue?.message}`
    )
  }

  return parsed.data
}

/** Inline audio reaches the model as bytes and is never stored; a FileRef is read from storage. */
function transcriptionAudio(audio: TranscriptionBody["audio"]): FileRef | AudioData {
  if ("data" in audio) {
    return { data: Buffer.from(audio.data, "base64"), mediaType: audio.mediaType }
  }

  return audio as FileRef
}

type TranscriptionBody = z.infer<typeof TranscriptionBodySchema>

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
          const model = selectLanguageBinding(catalog()?.language, body.model)
          const call = await sixb.models.language.generate({
            model,
            prompt: body.prompt,
            ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
            ...(body.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: body.maxOutputTokens }),
            ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
            signal: request.signal,
          })
          return TextGenerationSchema.parse({
            ...result({ provider: model.providerId, modelId: model.modelId }, call),
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
        const { request, set } = context
        try {
          const sixb = requireRequestSixb(context)
          // Refuse before reading what may be minutes of audio, not after.
          if (!sixb.models.canRun()) {
            set.status = 403
            return { error: "[SixbServer] Transcribing audio requires can.run(project.models)." }
          }

          const body = await readTranscriptionBody(request)
          const entry = selectBinding(catalog()?.audio?.transcription, "transcription", body.model)
          const call = await sixb.models.audio.transcribe({
            audio: transcriptionAudio(body.audio),
            model: entry.model,
            signal: request.signal,
          })
          return TranscriptionSchema.parse({ ...result(entry, call), text: call.output.text })
        } catch (error) {
          return generationError(error, set)
        }
      },
      {
        // Inline audio passes the server's default body cap, so the handler reads the body itself,
        // once the caller is known.
        parse: "none",
        response: { 200: TranscriptionSchema, 413: ErrorResponseSchema, ...responses },
        detail: {
          ...detail("transcribeAudio", "Transcribe audio with a transcription model"),
          requestBody: jsonRequestBody(TranscriptionBodySchema),
        },
      }
    )
}
