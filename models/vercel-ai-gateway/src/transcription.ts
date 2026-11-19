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
  type TranscriptionSegment,
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

      const timings = providerTimings(payload.providerMetadata)
      const words = timings.words
      // The Gateway's own segments name no speaker. A provider's phrases time the same speech and
      // say who spoke each, so they stand in for them: one list, as the two need not line up.
      const segments = timings.segments.length ? timings.segments : timedSegments(payload.segments)
      const language =
        typeof payload.language === "string" && payload.language ? payload.language : undefined
      return {
        ...responseMetadata,
        output: {
          text: payload.text,
          ...(words.length ? { words } : {}),
          ...(segments.length ? { segments } : {}),
          ...(language ? { language } : {}),
        },
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

/** What the provider timed itself: its words, and its phrases where it times those. */
interface ProviderTimings {
  readonly words: TranscriptionWord[]
  readonly segments: TranscriptionSegment[]
}

/**
 * The timings the provider sent, which the Gateway forwards verbatim under the provider's own
 * key. ElevenLabs writes `elevenlabs.words`, `{ text, type, start, end, speaker_id }` in seconds;
 * Azure writes `azure.phrases`, in milliseconds with the speaker on the phrase. They are the
 * part of a transcript that text cannot be rebuilt into, who spoke and when, so they travel on.
 *
 * Spacing and audio-event entries are dropped: `text` already carries them, and a caller seeking
 * by word has no use for them. Words a provider sends without a type are taken as they are, and
 * one entry Sixb cannot place costs only itself.
 */
function providerTimings(providerMetadata: unknown): ProviderTimings {
  const providers = object(providerMetadata)
  if (!providers) return { words: [], segments: [] }

  for (const [provider, metadata] of Object.entries(providers)) {
    const envelope = object(metadata)
    if (!envelope) continue

    const timings =
      provider === "azure"
        ? phraseTimings(envelope.phrases)
        : { words: timedWords(envelope.words), segments: [] }
    if (timings.words.length || timings.segments.length) return timings
  }

  return { words: [], segments: [] }
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
 * Azure's phrases, each with its speaker, and the words inside them. Each phrase Sixb can place
 * becomes a segment. A model asked for phrases only, such as `mai-transcribe-2` by default,
 * times no word: a phrase is never handed on as one, since a cut on its bounds falls mid-speech.
 * Words are kept only when every phrase timed its own, as a phrase without them would read as
 * silence between the words of the others.
 */
function phraseTimings(value: unknown): ProviderTimings {
  if (!Array.isArray(value)) return { words: [], segments: [] }

  const words: TranscriptionWord[] = []
  const segments: TranscriptionSegment[] = []
  let everyPhraseTimed = true

  for (const entry of value) {
    const phrase = object(entry)
    if (!phrase) continue

    const speaker = speakerLabel(phrase.speaker)
    const segment = offsetEntry(phrase, speaker)
    if (segment) segments.push(segment)

    const timed: TranscriptionWord[] = []
    for (const item of Array.isArray(phrase.words) ? phrase.words : []) {
      const word = offsetEntry(item, speaker)
      if (word) timed.push(word)
    }

    if (!timed.length) everyPhraseTimed = false
    words.push(...timed)
  }

  return { words: everyPhraseTimed ? words : [], segments }
}

/** One entry timed by an offset and a duration, as Azure counts them in milliseconds. */
function offsetEntry(value: unknown, speaker: string | undefined): TranscriptionWord | undefined {
  const entry = object(value)
  if (!entry || typeof entry.text !== "string" || !entry.text) return undefined

  const startMs = wholeMilliseconds(entry.offsetMilliseconds)
  const durationMs = wholeMilliseconds(entry.durationMilliseconds)
  if (startMs === undefined || durationMs === undefined) return undefined

  const endMs = startMs + durationMs
  if (!Number.isSafeInteger(endMs)) return undefined

  return { text: entry.text, startMs, endMs, ...(speaker === undefined ? {} : { speaker }) }
}

/**
 * The segments the Gateway times itself, `{ text, startSecond, endSecond }` in seconds: sentences
 * for most providers, and each word for some. One Sixb cannot place costs only itself.
 */
function timedSegments(value: unknown): TranscriptionSegment[] {
  if (!Array.isArray(value)) return []

  const segments: TranscriptionSegment[] = []
  for (const entry of value) {
    const segment = object(entry)
    if (!segment || typeof segment.text !== "string") continue

    const startMs = milliseconds(segment.startSecond)
    const endMs = milliseconds(segment.endSecond)
    if (startMs === undefined || endMs === undefined || endMs < startMs) continue

    segments.push({ text: segment.text, startMs, endMs })
  }

  return segments
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
