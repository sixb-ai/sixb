import { randomUUID } from "node:crypto"
import { assertProviderAccess } from "../../authorization"
import type { BlobStorage } from "../../blob-storage/types"
import type { ExecutionContext } from "../../execution"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ModelCatalog } from "../catalog"
import type { ModelCallEndEvent } from "../events"
import type { AiModelCallRecorder } from "../execution/model-call-recorder"
import type { ModelExecutionSession } from "../execution/session"
import { estimateModelCall, type ModelMoney } from "../pricing"
import { assertTranscriptionModel } from "./catalog"
import { TranscriptionModelResponseError } from "./errors"
import { prepareTranscriptionFile, readTranscriptionFile } from "./file"
import type {
  AudioModelsRuntime,
  TranscriptionModel,
  TranscriptionModelResponseMetadata,
  TranscriptionModelResult,
} from "./types"

export function createAudioRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined,
  session: ModelExecutionSession,
  blobs: BlobStorage | undefined
): AudioModelsRuntime {
  return {
    async transcribe(input) {
      assertProviderAccess(runtime, execution, "models.audio.transcribe")

      const { audio, mediaType } = prepareTranscriptionFile(input.audio)
      if (!blobs) {
        throw new Error("[SixbModels] Transcription requires blob storage.")
      }

      const signal = session.signal(input.signal)
      signal.throwIfAborted()

      const binding = selectModel(catalog, input.model)
      assertTranscriptionModel(binding)
      assertFileSupport(binding, audio.sizeBytes, mediaType)

      const accounting = await session.accounting()
      accounting.assertHealthy()

      const model = binding.resolve ? await binding.resolve() : binding
      assertTranscriptionModel(model)
      if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
        throw new TypeError(
          "[SixbModels] Resolved transcription model identity does not match the selected model."
        )
      }
      assertFileSupport(model, audio.sizeBytes, mediaType)

      signal.throwIfAborted()
      const bytes = await readTranscriptionFile(blobs, audio, signal)
      accounting.assertHealthy()

      const reservationCost = estimateReservationCost(model, bytes.byteLength, mediaType)
      const callId = `call_${randomUUID()}`
      await accounting.admitCall({
        callId,
        providerId: model.providerId,
        modelId: model.modelId,
        inputTokens: { status: "unavailable", reason: "nonTextInput" },
        outputTokenAllowance: 0,
        reservationCost,
      })

      let result: TranscriptionModelResult
      try {
        signal.throwIfAborted()
        result = await model.transcribe({ audio: bytes, mediaType, signal })
      } catch (error) {
        await recordTranscription(
          accounting,
          model,
          callId,
          error instanceof TranscriptionModelResponseError ? error.metadata : {}
        )
        throw error
      }

      // A completed, billable reply must survive cancellation and transcript validation failures.
      const event = await recordTranscription(accounting, model, callId, result ?? {})
      signal.throwIfAborted()
      if (typeof result?.output?.text !== "string") {
        throw new TranscriptionModelResponseError(
          "[SixbModels] Invalid transcription response.",
          model.providerId,
          model.modelId,
          result ?? {}
        )
      }

      return {
        output: { text: result.output.text },
        usage: event.usage,
        cost: event.cost,
        callId,
      }
    },
  }
}

function selectModel(
  catalog: ModelCatalog | undefined,
  requested: TranscriptionModel | undefined
): TranscriptionModel {
  if (!catalog && requested) return requested

  const transcribers = catalog?.audio?.transcription
  const selected = requested
    ? transcribers?.getByRef({ provider: requested.providerId, modelId: requested.modelId })?.model
    : transcribers?.default.model

  if (!selected) {
    throw new Error(
      "[SixbModels] Configure the selected model in models.audio.transcription, or supply a model when no catalog is configured."
    )
  }

  return selected
}

function assertFileSupport(model: TranscriptionModel, sizeBytes: number, mediaType: string): void {
  if (sizeBytes > model.definition.maxInputBytes) {
    throw new RangeError(
      `[SixbModels] Audio exceeds the model's ${model.definition.maxInputBytes}-byte input limit.`
    )
  }
  if (model.definition.mediaTypes && !model.definition.mediaTypes.includes(mediaType)) {
    throw new TypeError(
      `[SixbModels] Audio media type '${mediaType}' is not supported by the selected model.`
    )
  }
}

function estimateReservationCost(
  model: TranscriptionModel,
  sizeBytes: number,
  mediaType: string
): ModelMoney | undefined {
  try {
    return model.costEstimator?.estimateReservation?.({ sizeBytes, mediaType })
  } catch {
    // Optional pricing cannot bypass an enforced budget: admission fails closed without it.
    return undefined
  }
}

async function recordTranscription(
  accounting: AiModelCallRecorder,
  model: TranscriptionModel,
  callId: string,
  metadata: TranscriptionModelResponseMetadata
): Promise<ModelCallEndEvent> {
  const usage = metadata.usage ?? {}
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
  })
  const event: ModelCallEndEvent = {
    callId,
    modelKind: "transcription",
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
