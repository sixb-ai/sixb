import {
  assertJsonObject,
  isJsonObject,
  type JsonObject,
  type ModelRateCard,
  type SpeechCostEstimator,
  type SpeechModel,
  type SpeechModelDefinition,
  type SpeechModelRequest,
  SpeechModelResponseError,
  type SpeechModelResponseMetadata,
  type SpeechModelResult,
} from "@sixb/core/models"
import { readGatewayJson } from "./json-response"
import { audioMediaType } from "./media-type"

const PROVIDER_ID = "vercel-ai-gateway"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

// The formats the binding can request. A model may still ignore the request; Sixb then rejects
// the reply rather than return a format nobody asked for.
const OUTPUT_FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "opus",
  "audio/aac": "aac",
  "audio/flac": "flac",
}

export interface VercelGatewaySpeechOptions {
  /** When to pick this model, for people and the agent. Defaults to the catalog's description. */
  readonly description?: string
  /** The voice used when a request names none, such as `alloy` or `Kore`. */
  readonly voice?: string
  /** Voices requests may name. Omitted, any voice is passed through. */
  readonly voices?: readonly string[]
  /** Formats requests may ask for. Defaults to every format the binding can request. */
  readonly outputMediaTypes?: readonly string[]
  /** Passed through to the routed provider. */
  readonly providerOptions?: JsonObject
  /** Includes consuming the response body. Defaults to 120 seconds. */
  readonly timeoutMs?: number
  /** Client memory guard for the base64 reply. Defaults to 32 MiB. */
  readonly maxResponseBytes?: number
}

export interface GatewaySpeechResolution {
  readonly name?: string
  readonly description?: string
  readonly estimator?: SpeechCostEstimator
  readonly rateCard?: ModelRateCard
}

interface SpeechTransport {
  readonly url: string
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  headers(): Readonly<Record<string, string>>
  metadata(payload: JsonObject, requestId?: string): SpeechModelResponseMetadata
  resolution(): Promise<GatewaySpeechResolution>
}

export function createGatewaySpeech(
  modelId: string,
  options: VercelGatewaySpeechOptions,
  transport: SpeechTransport,
  resolution?: GatewaySpeechResolution
): SpeechModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError("[SixbVercelGateway] Speech model id must be a nonempty trimmed string.")
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  for (const [name, value] of Object.entries({ timeoutMs, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`[SixbVercelGateway] Speech ${name} must be a positive safe integer.`)
    }
  }
  const outputMediaTypes = Object.freeze([
    ...(options.outputMediaTypes ?? Object.keys(OUTPUT_FORMATS)),
  ])
  if (outputMediaTypes.some((type) => OUTPUT_FORMATS[type] === undefined)) {
    throw new TypeError(
      `[SixbVercelGateway] Speech outputMediaTypes must be among: ${Object.keys(OUTPUT_FORMATS).join(", ")}.`
    )
  }
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || !options.description.trim())
  ) {
    throw new TypeError("[SixbVercelGateway] Speech description must be a nonblank string.")
  }
  const providerOptions =
    options.providerOptions === undefined ? undefined : structuredClone(options.providerOptions)
  if (providerOptions) assertJsonObject(providerOptions, "speech providerOptions")
  const description = options.description ?? resolution?.description

  const definition: SpeechModelDefinition = Object.freeze({
    kind: "speech",
    providerId: PROVIDER_ID,
    modelId,
    via: "Vercel AI Gateway",
    ...(resolution?.name ? { name: resolution.name } : {}),
    ...(description ? { description } : {}),
    ...(options.voices ? { voices: Object.freeze([...options.voices]) } : {}),
    outputMediaTypes,
  })

  const resolve = async () =>
    createGatewaySpeech(
      modelId,
      { ...options, providerOptions },
      transport,
      await transport.resolution()
    )

  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition,
    ...(options.voice === undefined ? {} : { defaultVoice: options.voice }),
    ...(resolution?.estimator ? { costEstimator: resolution.estimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),
    ...(resolution ? {} : { resolve }),

    async speak(request: SpeechModelRequest): Promise<SpeechModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ])
      signal.throwIfAborted()

      const outputFormat =
        request.mediaType === undefined ? undefined : OUTPUT_FORMATS[request.mediaType]
      if (request.mediaType !== undefined && outputFormat === undefined) {
        throw new TypeError(
          `[SixbVercelGateway] Speech media type '${request.mediaType}' cannot be requested.`
        )
      }

      const response = await transport.fetch(transport.url, {
        method: "POST",
        signal,
        headers: {
          ...transport.headers(),
          "content-type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-speech-model-specification-version": "4",
          "ai-model-id": modelId,
        },
        body: JSON.stringify({
          text: request.text,
          ...(request.voice === undefined ? {} : { voice: request.voice }),
          ...(outputFormat === undefined ? {} : { outputFormat }),
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          ...(request.speed === undefined ? {} : { speed: request.speed }),
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(providerOptions ? { providerOptions } : {}),
        }),
      })
      const requestId = response.headers.get("x-request-id") ?? undefined
      const payload = await readGatewayJson(response, {
        modelId,
        operation: "Speech generation",
        maxBytes: maxResponseBytes,
        signal,
      })

      const transported = transport.metadata(payload, requestId)
      // The Gateway bills speech characters as UTF-16 code units: JavaScript string length.
      const metadata = {
        ...transported,
        usage: { ...transported.usage, inputCharacters: request.text.length },
      }
      const data =
        typeof payload.audio === "string" && payload.audio
          ? new Uint8Array(Buffer.from(payload.audio, "base64"))
          : undefined
      const mediaType = data && (audioMediaType(data) ?? reportedMediaType(payload))
      if (!data || !mediaType) {
        throw new SpeechModelResponseError(
          "[SixbVercelGateway] Speech generation returned no readable audio.",
          PROVIDER_ID,
          modelId,
          metadata
        )
      }

      const warnings = Array.isArray(payload.warnings) ? payload.warnings.flatMap(warning) : []
      return {
        ...metadata,
        output: { audio: { data, mediaType } },
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  })
}

function reportedMediaType(payload: JsonObject): string | undefined {
  const providers = isJsonObject(payload.providerMetadata) ? payload.providerMetadata : {}
  for (const metadata of Object.values(providers)) {
    const value = isJsonObject(metadata) ? metadata.mimeType : undefined
    if (typeof value === "string" && /^audio\/[a-z0-9.+-]+$/.test(value)) return value
  }
  return undefined
}

function warning(value: unknown): string[] {
  if (!isJsonObject(value)) return []
  const parts = [value.type, value.feature ?? value.setting, value.details ?? value.message]
  const text = parts.filter((part) => typeof part === "string" && part).join(": ")
  return text ? [text] : []
}
