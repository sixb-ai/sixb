import { randomUUID } from "node:crypto"
import { assertModelAccess } from "../../authorization"
import type { BlobStorage } from "../../blob-storage/types"
import type { ExecutionContext } from "../../execution"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ModelCatalog } from "../catalog"
import type { ModelCallEndEvent } from "../events"
import type { AiModelCallRecorder } from "../execution/model-call-recorder"
import type { ModelExecutionSession } from "../execution/session"
import { estimateModelCall, type ModelMoney } from "../pricing"
import { assertSpeechModel } from "./catalog"
import { SpeechModelResponseError } from "./errors"
import type {
  AudioModelsRuntime,
  AudioSpeakInput,
  SpeechModel,
  SpeechModelRequest,
  SpeechModelResponseMetadata,
  SpeechModelResult,
  SpeechReservationInput,
} from "./types"

type PreparedRequest = Omit<SpeechModelRequest, "signal">

export function createSpeak(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined,
  session: ModelExecutionSession,
  blobs: BlobStorage | undefined
): AudioModelsRuntime["speak"] {
  return async (input) => {
    assertModelAccess(runtime, execution, "models.audio.speak")

    const prepared = prepareRequest(input)
    if (!blobs) {
      throw new Error("[SixbModels] Speech generation requires blob storage.")
    }

    const signal = session.signal(input.signal)
    signal.throwIfAborted()

    const binding = selectModel(catalog, input.model)
    assertSpeechModel(binding)
    assertRequestSupport(binding, withVoice(binding, prepared))

    const accounting = await session.accounting()
    accounting.assertHealthy()

    const model = binding.resolve ? await binding.resolve() : binding
    assertSpeechModel(model)
    if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
      throw new TypeError(
        "[SixbModels] Resolved speech model identity does not match the selected model."
      )
    }
    const request = withVoice(model, prepared)
    assertRequestSupport(model, request)
    signal.throwIfAborted()

    const callId = `call_${randomUUID()}`
    await accounting.admitCall({
      callId,
      providerId: model.providerId,
      modelId: model.modelId,
      modelKind: "speech",
      inputTokens: {
        status: "estimated",
        tokens: Math.ceil(new TextEncoder().encode(request.text).byteLength / 4),
        method: "utf8BytesDividedByFour",
      },
      outputTokenAllowance: 0,
      reservationCost: estimateReservationCost(model, {
        text: request.text,
        ...(request.voice === undefined ? {} : { voice: request.voice }),
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      }),
    })

    let result: SpeechModelResult
    try {
      signal.throwIfAborted()
      result = await model.speak({ ...request, signal })
    } catch (error) {
      await recordSpeech(
        accounting,
        model,
        callId,
        error instanceof SpeechModelResponseError ? error.metadata : {}
      )
      throw error
    }

    // A completed, billable reply must survive cancellation and audio validation failures.
    const event = await recordSpeech(accounting, model, callId, result ?? {})
    signal.throwIfAborted()
    const audio = result?.output?.audio
    if (
      !(audio?.data instanceof Uint8Array) ||
      audio.data.byteLength === 0 ||
      typeof audio.mediaType !== "string" ||
      !/^audio\/[a-z0-9.+-]+$/.test(audio.mediaType) ||
      (request.mediaType !== undefined && audio.mediaType !== request.mediaType) ||
      !isWarnings(result.warnings)
    ) {
      throw new SpeechModelResponseError(
        "[SixbModels] Invalid speech response.",
        model.providerId,
        model.modelId,
        result ?? {}
      )
    }

    const file = await blobs.put({
      body: audio.data,
      expectedSizeBytes: audio.data.byteLength,
      mediaType: audio.mediaType,
      signal,
    })
    await accounting.recordFiles(callId, [file])
    return {
      file,
      warnings: [...(result.warnings ?? [])],
      usage: event.usage,
      cost: event.cost,
      callId,
    }
  }
}

/** Validate and snapshot the caller's request before the first await. */
function prepareRequest(input: AudioSpeakInput): PreparedRequest {
  if (typeof input?.text !== "string" || !input.text.trim()) {
    throw new TypeError("[SixbModels] Speech generation requires nonblank text.")
  }
  for (const field of ["voice", "instructions", "language"] as const) {
    const value = input[field]
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new TypeError(`[SixbModels] Speech ${field} must be a nonblank string.`)
    }
  }
  const mediaType = input.mediaType?.split(";", 1)[0]?.trim().toLowerCase()
  if (input.mediaType !== undefined && !/^audio\/[a-z0-9.+-]+$/.test(mediaType ?? "")) {
    throw new TypeError("[SixbModels] Speech mediaType must be an audio media type.")
  }
  if (
    input.speed !== undefined &&
    (typeof input.speed !== "number" || !Number.isFinite(input.speed) || input.speed <= 0)
  ) {
    throw new TypeError("[SixbModels] Speech speed must be a positive number.")
  }

  return {
    text: input.text,
    ...(input.voice === undefined ? {} : { voice: input.voice }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(input.speed === undefined ? {} : { speed: input.speed }),
    ...(input.language === undefined ? {} : { language: input.language }),
  }
}

function withVoice(model: SpeechModel, request: PreparedRequest): PreparedRequest {
  const voice = request.voice ?? model.defaultVoice
  return voice === undefined ? request : { ...request, voice }
}

function selectModel(
  catalog: ModelCatalog | undefined,
  requested: SpeechModel | undefined
): SpeechModel {
  if (!catalog && requested) return requested

  // The catalog owns the binding, even when a caller supplies another object with the same ID.
  const models = catalog?.audio?.speech
  const selected = requested
    ? models?.getByRef({ provider: requested.providerId, modelId: requested.modelId })?.model
    : models?.default.model

  if (!selected) {
    throw new Error(
      "[SixbModels] Configure the selected model in models.audio.speech, or supply a model when no catalog is configured."
    )
  }

  return selected
}

function assertRequestSupport(model: SpeechModel, request: PreparedRequest): void {
  const definition = model.definition
  if (
    definition.maxInputCharacters !== undefined &&
    request.text.length > definition.maxInputCharacters
  ) {
    throw new RangeError(
      `[SixbModels] Text exceeds the model's ${definition.maxInputCharacters}-character input limit.`
    )
  }
  if (
    request.voice !== undefined &&
    definition.voices &&
    !definition.voices.includes(request.voice)
  ) {
    throw new TypeError(
      `[SixbModels] Voice '${request.voice}' is not supported by the selected model.`
    )
  }
  if (
    request.mediaType !== undefined &&
    definition.outputMediaTypes &&
    !definition.outputMediaTypes.includes(request.mediaType)
  ) {
    throw new TypeError(
      `[SixbModels] Speech media type '${request.mediaType}' is not supported by the selected model.`
    )
  }
  if (request.instructions !== undefined && definition.instructions === false) {
    throw new TypeError("[SixbModels] The selected model does not take speech instructions.")
  }
}

function estimateReservationCost(
  model: SpeechModel,
  input: SpeechReservationInput
): ModelMoney | undefined {
  try {
    return model.costEstimator?.estimateReservation?.(input)
  } catch {
    // Optional pricing cannot bypass an enforced budget: admission fails closed without it.
    return undefined
  }
}

async function recordSpeech(
  accounting: AiModelCallRecorder,
  model: SpeechModel,
  callId: string,
  metadata: SpeechModelResponseMetadata
): Promise<ModelCallEndEvent> {
  const usage = metadata.usage ?? {}
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
    ...(metadata.pricingDimensions === undefined ? {} : { dimensions: metadata.pricingDimensions }),
  })
  const event: ModelCallEndEvent = {
    callId,
    modelKind: "speech",
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? callId,
    providerIds: metadata.providerIds,
    responseModelId: metadata.responseModelId,
    usage,
    cost: metadata.reportedCost ? { status: "reported", ...metadata.reportedCost } : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  }

  await accounting.onModelCallEnd(event)
  return event
}

function isWarnings(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((w) => typeof w === "string"))
}
