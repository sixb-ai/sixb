import {
  defineModelRateCard,
  type ModelCostEstimate,
  ModelProviderError,
  type ModelRateCard,
  type ModelUsage,
  rateModelCall,
  type TranscriptionCostEstimator,
  type TranscriptionModel,
  type TranscriptionModelDefinition,
  type TranscriptionModelRequest,
  TranscriptionModelResponseError,
  type TranscriptionModelResult,
} from "@sixb/core/models"
import {
  type AzureAIFoundryDeployment,
  deploymentMetadata,
  type FoundryDeployments,
  type ResolvedDeployment,
} from "./discovery"
import { assertDeploymentKind } from "./kinds"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { azurePublisher } from "./publisher"
import { abortable, type FoundryTransport, readJson, requestId } from "./transport"
import { counter, object, PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundryTranscriptionOptions {
  /** The spoken language as an ISO-639 code, such as `en`. Default: detected by the model. */
  readonly language?: string
  /** Deadline for one transcription, upload and response included. Default: 120,000 ms. */
  readonly timeoutMs?: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: TranscriptionCostEstimator
}

export interface AzureAIFoundryTranscriptionModel extends TranscriptionModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryTranscriptionModel>
}

/** Azure's upload limit for one file. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024

/** Azure picks the decoder from the file name's extension; the bytes are never transcoded. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
}
const MEDIA_TYPES = Object.freeze(Object.keys(EXTENSIONS))

/** A transcript of 25 MiB of audio is far smaller; Whisper's segments add a few times the text. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Azure Retail Prices (verified 2026-11-13), by deployment SKU. Token prices are per million audio
 * input and text output tokens; the binding sends no prompt, so every input token is audio.
 * Hourly prices are per second of audio. gpt-4o-transcribe-diarize has no retail meter.
 */
const PUBLISHED: readonly {
  readonly model: string
  readonly versions: readonly string[]
  readonly skus: Readonly<Record<string, ModelRateCard>>
}[] = [
  {
    // gpt-4o-transcribe-{aud-inp,txt-out}-{glbl,dz,rgnl}
    model: "gpt-4o-transcribe",
    versions: ["2025-03-20"],
    skus: {
      GlobalStandard: { currency: "USD", input: "6", output: "10" },
      DataZoneStandard: { currency: "USD", input: "6.6", output: "11" },
      Standard: { currency: "USD", input: "6.6", output: "11" },
    },
  },
  {
    // gpt-4o-mini-transcribe-{aud-inp,txt-out}-{glbl,dz,rgnl}
    model: "gpt-4o-mini-transcribe",
    versions: ["2025-03-20", "2025-12-15"],
    skus: {
      GlobalStandard: { currency: "USD", input: "3", output: "5" },
      DataZoneStandard: { currency: "USD", input: "3.3", output: "5.5" },
      Standard: { currency: "USD", input: "3.3", output: "5.5" },
    },
  },
  {
    // "gpt-transcribe Gl/Dz Unit": USD 0.27 and 0.297 per hour.
    model: "gpt-transcribe",
    versions: ["2026-07-28"],
    skus: {
      GlobalStandard: { currency: "USD", audioInputSeconds: "0.000075" },
      DataZoneStandard: { currency: "USD", audioInputSeconds: "0.0000825" },
    },
  },
  {
    // "Speech-to-Text-Batch-Whisper-glbl/regnl": USD 0.36 and 0.396 per hour.
    model: "whisper",
    versions: ["001"],
    skus: {
      GlobalStandard: { currency: "USD", audioInputSeconds: "0.0001" },
      Standard: { currency: "USD", audioInputSeconds: "0.00011" },
    },
  },
]

interface TranscriptionSettings {
  readonly language?: string
  readonly timeoutMs: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: TranscriptionCostEstimator
}

interface TranscriptionResolution extends ResolvedDeployment {
  readonly costEstimator?: TranscriptionCostEstimator
  readonly rateCard?: ModelRateCard
  /** Whisper reports no usage in JSON; its verbose format carries the audio duration. */
  readonly verbose: boolean
  /** gpt-4o-transcribe-diarize needs a chunking strategy for audio over 30 seconds. */
  readonly chunking: boolean
}

export function createFoundryTranscription(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryTranscriptionOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundryTranscriptionModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (options.language !== undefined && !/^[a-z]{2,3}$/.test(options.language))
    throw new TypeError(`${PREFIX} language must be an ISO-639 code, such as 'en'.`)
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: TranscriptionSettings = Object.freeze({
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.language ? { language: options.language } : {}),
    ...(options.rateCard ? { rateCard: defineModelRateCard(options.rateCard) } : {}),
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return transcriptionBinding(providerId, modelId, settings, transport, deployments)
}

/** Discovery pins the deployed model for pricing; inference uploads the file to the resource. */
function transcriptionBinding(
  providerId: string,
  modelId: string,
  settings: TranscriptionSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: TranscriptionResolution
): AzureAIFoundryTranscriptionModel {
  const deployment = resolution?.deployment
  const definition: TranscriptionModelDefinition = Object.freeze({
    kind: "transcription",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
    maxInputBytes: MAX_INPUT_BYTES,
    mediaTypes: MEDIA_TYPES,
  })

  let pending: Promise<AzureAIFoundryTranscriptionModel> | undefined
  const binding: AzureAIFoundryTranscriptionModel = Object.freeze({
    providerId,
    modelId,
    definition,
    metadata: deploymentMetadata(resolution),
    ...(resolution?.costEstimator ? { costEstimator: resolution.costEstimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      const found = resolved.deployment
      assertDeploymentKind(found, modelId, "transcription")
      const rateCard = settings.costEstimator
        ? undefined
        : (settings.rateCard ?? publishedRateCard(found))
      return transcriptionBinding(providerId, modelId, settings, transport, deployments, {
        ...resolved,
        verbose: /^whisper$/i.test(found.modelName),
        chunking: /-diarize$/i.test(found.modelName),
        ...(rateCard ? { rateCard } : {}),
        ...(settings.costEstimator || rateCard
          ? { costEstimator: settings.costEstimator ?? transcriptionEstimator(rateCard!) }
          : {}),
      })
    },

    async transcribe(request: TranscriptionModelRequest): Promise<TranscriptionModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      const extension = EXTENSIONS[request.mediaType]
      if (
        !(request.audio instanceof Uint8Array) ||
        request.audio.byteLength === 0 ||
        request.audio.byteLength > MAX_INPUT_BYTES
      )
        throw new TypeError(`${PREFIX} Transcription audio must be 1 byte to 25 MiB.`)
      if (!extension)
        throw new TypeError(
          `${PREFIX} Transcription media type '${request.mediaType}' is not supported.`
        )
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.transcribe({ ...request, signal })
      }

      const form = new FormData()
      // Copied: the upload must not change if the caller reuses its buffer.
      const file = new Blob([new Uint8Array(request.audio)], { type: request.mediaType })
      form.set("file", file, `audio.${extension}`)
      form.set("response_format", resolution.verbose ? "verbose_json" : "json")
      if (resolution.chunking) form.set("chunking_strategy", "auto")
      if (settings.language) form.set("language", settings.language)
      const response = await transport.post(form, signal, providerId, modelId, "transcription")
      const id = transport.redactText(response, requestId(response))
      let body: unknown
      try {
        body = await readJson(response, signal, MAX_RESPONSE_BYTES)
      } catch {
        // The parse error can quote the body; only the status and request ID travel.
        if (signal.aborted) throw signal.reason
        throw new ModelProviderError(
          `${PREFIX} Transcription returned invalid JSON.`,
          providerId,
          modelId,
          { code: "invalid_json", requestId: id, status: response.status }
        )
      }
      const payload = object(body)
      const metadata = {
        usage: transcriptionUsage(payload),
        ...(id ? { providerIds: { requestId: id } } : {}),
      }
      if (typeof payload?.text !== "string")
        throw new TranscriptionModelResponseError(
          `${PREFIX} Transcription response is missing its text.`,
          providerId,
          modelId,
          metadata
        )
      return { ...metadata, output: { text: payload.text } }
    },
  })
  return binding
}

/**
 * Token models report `usage.type: "tokens"`, gpt-transcribe `usage.type: "duration"` in whole
 * seconds, and Whisper's verbose format a top-level `duration`. Anything else stays unknown.
 */
function transcriptionUsage(payload: Record<string, unknown> | undefined): ModelUsage {
  const usage = object(payload?.usage)
  if (usage?.type === "tokens") {
    const inputTokens = counter(usage.input_tokens)
    const outputTokens = counter(usage.output_tokens)
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      raw: usage,
    }
  }
  const seconds = usage?.type === "duration" ? usage.seconds : payload?.duration
  const audioDurationMs =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : undefined
  return {
    ...(audioDurationMs === undefined ? {} : { audioDurationMs }),
    ...(usage ? { raw: usage } : {}),
  }
}

/** The deployment's retail price, when Azure publishes one for its model, version and SKU. */
function publishedRateCard(deployment: AzureAIFoundryDeployment): ModelRateCard | undefined {
  const name = deployment.modelName.toLowerCase()
  const entry = PUBLISHED.find(
    (price) => price.model === name && price.versions.includes(deployment.modelVersion)
  )
  const card =
    entry && Object.hasOwn(entry.skus, deployment.sku.name) && entry.skus[deployment.sku.name]
  return card ? defineModelRateCard(card) : undefined
}

function transcriptionEstimator(rateCard: ModelRateCard): TranscriptionCostEstimator {
  return {
    // Neither tokens nor duration can be read from the file before Azure decodes it.
    estimate: ({ usage }): ModelCostEstimate => {
      // Text input tokens bill at another rate; they come only from a prompt, which is never sent.
      const details = object(usage.raw?.input_token_details)
      if (details?.text_tokens !== undefined && details.text_tokens !== 0)
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard })
    },
  }
}
