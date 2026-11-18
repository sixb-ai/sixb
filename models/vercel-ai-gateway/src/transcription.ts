import {
  assertJsonObject,
  isJsonObject,
  type JsonObject,
  type ModelRateCard,
  type TranscriptionCostEstimator,
  type TranscriptionModel,
  type TranscriptionModelDefinition,
  type TranscriptionModelRequest,
  TranscriptionModelResponseError,
  type TranscriptionModelResponseMetadata,
  type TranscriptionWord,
} from "@sixb/core/models"
import { readGatewayJson } from "./json-response"

const PROVIDER_ID = "vercel-ai-gateway"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export interface VercelGatewayTranscriptionOptions {
  readonly providerOptions?: JsonObject
  /** Includes consuming the response body. Defaults to 120 seconds. */
  readonly timeoutMs?: number
  /** Client memory guard, not a promise of upstream support. Defaults to 25 MiB. */
  readonly maxInputBytes?: number
  /** Optional allowlist; upstream format restrictions still apply. */
  readonly mediaTypes?: readonly string[]
}

interface TranscriptionTransport {
  readonly url: string
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  headers(): Readonly<Record<string, string>>
  metadata(body: JsonObject, requestId?: string): TranscriptionModelResponseMetadata
  pricing(): Promise<GatewayTranscriptionPricing>
}

/** A resolved model's estimator, and the card it prices with when the price is known. */
export interface GatewayTranscriptionPricing {
  readonly estimator: TranscriptionCostEstimator
  readonly rateCard?: ModelRateCard
}

export function createGatewayTranscription(
  modelId: string,
  options: VercelGatewayTranscriptionOptions,
  transport: TranscriptionTransport,
  pricing?: GatewayTranscriptionPricing
): TranscriptionModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError(
      "[SixbVercelGateway] Transcription model id must be a nonempty trimmed string."
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  for (const [name, value] of Object.entries({ timeoutMs, maxInputBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `[SixbVercelGateway] Transcription ${name} must be a positive safe integer.`
      )
    }
  }

  const providerOptions =
    options.providerOptions === undefined ? undefined : structuredClone(options.providerOptions)
  if (providerOptions) assertJsonObject(providerOptions, "transcription providerOptions")

  const mediaTypes = options.mediaTypes && Object.freeze([...options.mediaTypes])
  if (
    mediaTypes &&
    (!mediaTypes.length || mediaTypes.some((type) => !/^audio\/[a-z0-9.+-]+$/.test(type)))
  ) {
    throw new TypeError(
      "[SixbVercelGateway] Transcription mediaTypes must be a nonempty list of audio MIME types."
    )
  }

  const definition: TranscriptionModelDefinition = Object.freeze({
    kind: "transcription",
    providerId: PROVIDER_ID,
    modelId,
    via: "Vercel AI Gateway",
    maxInputBytes,
    ...(mediaTypes ? { mediaTypes } : {}),
  })

  const resolve = async () =>
    createGatewayTranscription(
      modelId,
      { ...options, providerOptions, mediaTypes },
      transport,
      await transport.pricing()
    )

  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition,
    ...(pricing ? { costEstimator: pricing.estimator } : { resolve }),
    ...(pricing?.rateCard ? { rateCard: pricing.rateCard } : {}),

    async transcribe(input: TranscriptionModelRequest) {
      assertTranscriptionInput(input, definition)

      const signal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ])
      signal.throwIfAborted()

      // Gateway accepts JSON/base64 only. Core verifies and bounds the file before this allocation.
      const body = JSON.stringify({
        audio: Buffer.from(input.audio).toString("base64"),
        mediaType: input.mediaType,
        ...(providerOptions ? { providerOptions } : {}),
      })
      const response = await transport.fetch(transport.url, {
        method: "POST",
        signal,
        headers: {
          ...transport.headers(),
          "content-type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-transcription-model-specification-version": "4",
          "ai-model-id": modelId,
        },
        body,
      })

      const requestId = response.headers.get("x-request-id") ?? undefined
      const payload = await readGatewayJson(response, {
        modelId,
        operation: "Transcription",
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
      })
      const metadata = transport.metadata(payload, requestId)
      const audioDurationMs = milliseconds(payload.durationInSeconds)
      const responseMetadata = {
        ...metadata,
        usage: {
          ...metadata.usage,
          ...(audioDurationMs === undefined ? {} : { audioDurationMs }),
        },
      }

      if (typeof payload.text !== "string") {
        throw new TranscriptionModelResponseError(
          "[SixbVercelGateway] Transcription response is missing text.",
          PROVIDER_ID,
          modelId,
          responseMetadata
        )
      }

      const words = transcriptionWords(payload.providerMetadata)
      return {
        ...responseMetadata,
        output: { text: payload.text, ...(words ? { words } : {}) },
      }
    },
  })
}

function assertTranscriptionInput(
  input: TranscriptionModelRequest,
  definition: TranscriptionModelDefinition
): void {
  if (
    !(input.audio instanceof Uint8Array) ||
    input.audio.byteLength === 0 ||
    input.audio.byteLength > definition.maxInputBytes
  ) {
    throw new TypeError(
      "[SixbVercelGateway] Transcription audio must be nonempty bytes within maxInputBytes."
    )
  }

  if (
    !/^audio\/[a-z0-9.+-]+$/.test(input.mediaType) ||
    (definition.mediaTypes && !definition.mediaTypes.includes(input.mediaType))
  ) {
    throw new TypeError("[SixbVercelGateway] Unsupported transcription mediaType.")
  }
}

/**
 * The words the provider timed, which the Gateway forwards verbatim under the provider's own
 * key. ElevenLabs writes `elevenlabs.words`, `{ text, type, start, end, speaker_id }` in seconds;
 * Azure writes `azure.phrases`, in milliseconds with the speaker on the phrase. They are the
 * part of a transcript that text cannot be rebuilt into, who spoke and when, so they travel on.
 *
 * Spacing and audio-event entries are dropped: `text` already carries them, and a caller seeking
 * by word has no use for them. Words a provider sends without a type are taken as they are, and
 * one entry Sixb cannot place costs only itself.
 */
function transcriptionWords(providerMetadata: unknown): TranscriptionWord[] | undefined {
  const providers = object(providerMetadata)
  if (!providers) return undefined

  for (const [provider, metadata] of Object.entries(providers)) {
    const envelope = object(metadata)
    if (!envelope) continue
    const words = provider === "azure" ? phraseWords(envelope.phrases) : timedWords(envelope.words)
    if (words.length) return words
  }

  return undefined
}

/** ElevenLabs' token stream, and any provider that times its own words the same way. */
function timedWords(value: unknown): TranscriptionWord[] {
  if (!Array.isArray(value)) return []

  const words: TranscriptionWord[] = []
  for (const entry of value) {
    const word = object(entry)
    if (!word || word.type === "spacing" || word.type === "audio_event") continue

    const startMs = milliseconds(word.start)
    const endMs = milliseconds(word.end)
    if (typeof word.text !== "string" || !word.text || startMs === undefined) continue
    if (endMs === undefined || endMs < startMs) continue

    const speaker = speakerLabel(word.speaker_id)
    words.push({ text: word.text, startMs, endMs, ...(speaker === undefined ? {} : { speaker }) })
  }

  return words
}

/**
 * Azure's phrases, which carry the speaker and their own words. A phrase that times no usable
 * word, because the model was asked for phrases only, still says who spoke when: its text
 * becomes one entry, so a caller seeking by word lands inside it.
 */
function phraseWords(value: unknown): TranscriptionWord[] {
  if (!Array.isArray(value)) return []

  const words: TranscriptionWord[] = []
  for (const entry of value) {
    const phrase = object(entry)
    if (!phrase) continue

    const speaker = speakerLabel(phrase.speaker)
    const timed: TranscriptionWord[] = []
    for (const item of Array.isArray(phrase.words) ? phrase.words : []) {
      const word = offsetWord(item, speaker)
      if (word) timed.push(word)
    }

    if (timed.length) {
      words.push(...timed)
      continue
    }

    const whole = offsetWord(phrase, speaker)
    if (whole) words.push(whole)
  }

  return words
}

/** One entry timed by an offset and a duration, as Azure counts them in milliseconds. */
function offsetWord(value: unknown, speaker: string | undefined): TranscriptionWord | undefined {
  const entry = object(value)
  if (!entry || typeof entry.text !== "string" || !entry.text) return undefined

  const startMs = wholeMilliseconds(entry.offsetMilliseconds)
  const durationMs = wholeMilliseconds(entry.durationMilliseconds)
  if (startMs === undefined || durationMs === undefined) return undefined

  const endMs = startMs + durationMs
  if (!Number.isSafeInteger(endMs)) return undefined

  return { text: entry.text, startMs, endMs, ...(speaker === undefined ? {} : { speaker }) }
}

/** Azure counts speakers from zero; the label reads as ElevenLabs writes its own. */
function speakerLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined
  return `speaker_${value}`
}

/** Provider seconds as whole milliseconds, for durations and word timings alike. */
function milliseconds(seconds: unknown): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined
  return wholeMilliseconds(Math.round(seconds * 1000))
}

function wholeMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}
