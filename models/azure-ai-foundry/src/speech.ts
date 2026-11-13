import {
  defineModelRateCard,
  type JsonObject,
  type ModelRateCard,
  type ModelUsage,
  rateModelCall,
  type SpeechCostEstimator,
  type SpeechModel,
  type SpeechModelDefinition,
  type SpeechModelRequest,
  SpeechModelResponseError,
  type SpeechModelResponseMetadata,
  type SpeechModelResult,
  UnsupportedModelFeatureError,
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
import { abortable, type FoundryTransport, requestId } from "./transport"
import { counter, object, PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundrySpeechOptions {
  /** The voice used when a request names none. Default: `alloy`. */
  readonly voice?: string
  /** Deadline for one generation, response included. Default: 120,000 ms. */
  readonly timeoutMs?: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: SpeechCostEstimator
}

export interface AzureAIFoundrySpeechModel extends SpeechModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundrySpeechModel>
}

/** The `response_format` for each media type a request may ask for; PCM is not a file. */
const FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/ogg": "opus",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/wav": "wav",
}
const OUTPUT_MEDIA_TYPES = Object.freeze(Object.keys(FORMATS))

/** Azure rejects longer input. */
const MAX_INPUT_CHARACTERS = 4096

/** 4,096 characters at speed 0.25 make about 20 minutes, 60 MiB of WAV. */
const MAX_AUDIO_BYTES = 128 * 1024 * 1024

/** One event carries a chunk of base64 audio; a longer one is not Azure's. */
const MAX_EVENT_BYTES = 16 * 1024 * 1024

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Azure Retail Prices (verified 2026-11-13), by deployment SKU, USD per million text input and
 * audio output tokens: meters gpt-4o-mini-tts-{txt-inp,aud-out}-{glbl,dz,rgnl} and, for the
 * 2025-12-15 version, "gpt4o mn tts {txt in,aud out} {gl,dz} 1215".
 */
const PUBLISHED: Readonly<Record<string, Readonly<Record<string, ModelRateCard>>>> = {
  "2025-03-20": {
    GlobalStandard: { currency: "USD", input: "0.6", output: "12" },
    DataZoneStandard: { currency: "USD", input: "0.66", output: "13.2" },
    Standard: { currency: "USD", input: "0.66", output: "13.2" },
  },
  "2025-12-15": {
    GlobalStandard: { currency: "USD", input: "0.6", output: "12" },
    DataZoneStandard: { currency: "USD", input: "0.66", output: "13.2" },
  },
}

interface SpeechSettings {
  readonly voice: string
  readonly timeoutMs: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: SpeechCostEstimator
}

interface SpeechResolution extends ResolvedDeployment {
  readonly costEstimator?: SpeechCostEstimator
  readonly rateCard?: ModelRateCard
}

export function createFoundrySpeech(
  providerId: string,
  modelId: string,
  options: AzureAIFoundrySpeechOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundrySpeechModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (options.voice !== undefined && (typeof options.voice !== "string" || !options.voice.trim()))
    throw new TypeError(`${PREFIX} voice must be a nonblank string.`)
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: SpeechSettings = Object.freeze({
    voice: options.voice ?? "alloy",
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.rateCard ? { rateCard: defineModelRateCard(options.rateCard) } : {}),
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return speechBinding(providerId, modelId, settings, transport, deployments)
}

/** Discovery pins the deployed model for pricing; inference streams the audio as events. */
function speechBinding(
  providerId: string,
  modelId: string,
  settings: SpeechSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: SpeechResolution
): AzureAIFoundrySpeechModel {
  const deployment = resolution?.deployment
  const definition: SpeechModelDefinition = Object.freeze({
    kind: "speech",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
    maxInputCharacters: MAX_INPUT_CHARACTERS,
    outputMediaTypes: OUTPUT_MEDIA_TYPES,
    instructions: true,
  })

  let pending: Promise<AzureAIFoundrySpeechModel> | undefined
  const binding: AzureAIFoundrySpeechModel = Object.freeze({
    providerId,
    modelId,
    definition,
    defaultVoice: settings.voice,
    metadata: deploymentMetadata(resolution),
    ...(resolution?.costEstimator ? { costEstimator: resolution.costEstimator } : {}),
    ...(resolution?.rateCard ? { rateCard: resolution.rateCard } : {}),

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      assertDeploymentKind(resolved.deployment, modelId, "speech")
      // tts and tts-hd do not stream events, so they report no usage to price.
      if (!/^gpt-4o-mini-tts$/i.test(resolved.deployment.modelName))
        throw new UnsupportedModelFeatureError(
          `${PREFIX} ${resolved.deployment.modelName} is not supported: deploy gpt-4o-mini-tts, which reports its usage.`
        )
      const rateCard = settings.costEstimator
        ? undefined
        : (settings.rateCard ?? publishedRateCard(resolved.deployment))
      return speechBinding(providerId, modelId, settings, transport, deployments, {
        ...resolved,
        ...(rateCard ? { rateCard } : {}),
        ...(settings.costEstimator || rateCard
          ? { costEstimator: settings.costEstimator ?? speechEstimator(rateCard!) }
          : {}),
      })
    },

    async speak(request: SpeechModelRequest): Promise<SpeechModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      const mediaType = request.mediaType ?? "audio/mpeg"
      const format = FORMATS[mediaType]
      if (!format)
        throw new TypeError(`${PREFIX} Speech media type '${mediaType}' cannot be requested.`)
      if (
        typeof request.text !== "string" ||
        !request.text.trim() ||
        request.text.length > MAX_INPUT_CHARACTERS
      )
        throw new TypeError(
          `${PREFIX} Speech text must be 1 to ${MAX_INPUT_CHARACTERS} characters.`
        )
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.speak({ ...request, signal })
      }

      // Only the event stream reports usage; a plain audio reply carries no token counts.
      const response = await transport.post(
        JSON.stringify({
          model: modelId,
          input: request.text,
          voice: request.voice ?? settings.voice,
          response_format: format,
          stream_format: "sse",
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          ...(request.speed === undefined ? {} : { speed: request.speed }),
        }),
        signal,
        providerId,
        modelId,
        "speech"
      )
      const id = transport.redactText(response, requestId(response))
      const stream = await readSpeechStream(response, signal)
      const metadata: SpeechModelResponseMetadata = {
        usage: speechUsage(stream.usage),
        ...(id ? { providerIds: { requestId: id } } : {}),
      }
      // Azure billed the call whatever the stream holds: every failure keeps its metadata.
      const failure = (reason: string) =>
        new SpeechModelResponseError(`${PREFIX} ${reason}`, providerId, modelId, metadata)
      if (stream.error !== undefined)
        throw failure(
          `Speech generation failed: ${transport.redactText(response, stream.error) ?? stream.error}`
        )
      if (stream.problem) throw failure(`Speech generation ${stream.problem}.`)
      const audio = wavLengths(stream.audio, format)
      if (!hasSignature(audio, format))
        throw failure(`Speech generation returned no ${format} audio.`)
      // The API has no language setting: the model reads the text as written.
      const warnings =
        request.language === undefined
          ? []
          : ["language: not supported; the model reads the text in its own language"]
      return {
        ...metadata,
        output: { audio: { data: audio, mediaType } },
        ...(warnings.length ? { warnings } : {}),
      }
    },
  })
  return binding
}

interface SpeechStream {
  readonly audio: Uint8Array
  readonly usage?: JsonObject
  /** Azure's message from an `error` event. */
  readonly error?: string
  /** Why the stream cannot be trusted: cut off, oversized or malformed. */
  readonly problem?: string
}

/**
 * Read `speech.audio.delta` events as they arrive, decoding their base64 audio, until
 * `speech.audio.done` brings the usage. Only a stream that reached it is complete.
 */
async function readSpeechStream(response: Response, signal: AbortSignal): Promise<SpeechStream> {
  const parts: Buffer[] = []
  let bytes = 0
  let usage: JsonObject | undefined
  let done = false
  let error: string | undefined
  let problem: string | undefined
  let data: string[] = []
  let pending = ""

  // An event is its `data:` lines up to a blank line, joined by newlines.
  const dispatch = () => {
    const text = data.join("\n")
    data = []
    if (!text || text === "[DONE]") return
    let event: JsonObject | undefined
    try {
      event = object(JSON.parse(text))
    } catch {
      problem = "returned a malformed event"
      return
    }
    if (event?.type === "speech.audio.delta" && typeof event.audio === "string" && !done) {
      const chunk = Buffer.from(event.audio, "base64")
      bytes += chunk.length
      if (bytes > MAX_AUDIO_BYTES) problem = `exceeded ${MAX_AUDIO_BYTES} bytes of audio`
      else parts.push(chunk)
    } else if (event?.type === "speech.audio.done") {
      done = true
      usage = object(event.usage)
    } else if (event?.type === "error") {
      const detail = object(event.error)
      error = typeof detail?.message === "string" ? detail.message : "error event"
    }
  }

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  try {
    while (reader && !problem && error === undefined) {
      const chunk = await abortable(() => reader.read(), signal).catch(() => undefined)
      if (!chunk) {
        if (signal.aborted) throw signal.reason
        problem = "stream failed before it finished"
        break
      }
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      const lines = pending.split(/\r?\n/)
      pending = chunk.done ? "" : lines.pop()!
      if (pending.length > MAX_EVENT_BYTES) problem = "returned an oversized event"
      for (const line of lines) {
        if (line === "") dispatch()
        else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5))
        if (problem || error !== undefined) break
      }
      if (chunk.done) {
        dispatch()
        break
      }
    }
  } finally {
    void reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
  return {
    audio: new Uint8Array(Buffer.concat(parts)),
    ...(usage ? { usage } : {}),
    ...(error === undefined ? {} : { error }),
    ...(problem
      ? { problem }
      : error === undefined && !done
        ? { problem: "stream ended before speech.audio.done" }
        : {}),
  }
}

/** Input tokens are text and instructions; every output token is audio. */
function speechUsage(raw: JsonObject | undefined): ModelUsage {
  const inputTokens = counter(raw?.input_tokens)
  const outputTokens = counter(raw?.output_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(raw ? { raw } : {}),
  }
}

/**
 * A streamed WAV header leaves its RIFF and data sizes at 0xFFFFFFFF, unknown when it was sent.
 * The whole file is here, so write the real sizes: some players refuse the placeholder.
 */
function wavLengths(audio: Uint8Array, format: string): Uint8Array {
  if (format !== "wav" || audio.length < 44 || ascii(audio, 36) !== "data") return audio
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (view.getUint32(4, true) === 0xffffffff) view.setUint32(4, audio.length - 8, true)
  if (view.getUint32(40, true) === 0xffffffff) view.setUint32(40, audio.length - 44, true)
  return audio
}

/** The reply must be the format asked for: Sixb never transcodes. */
function hasSignature(audio: Uint8Array, format: string): boolean {
  if (format === "wav") return ascii(audio, 0) === "RIFF" && ascii(audio, 8) === "WAVE"
  if (format === "opus") return ascii(audio, 0) === "OggS"
  if (format === "flac") return ascii(audio, 0) === "fLaC"
  // MP3 starts with an ID3 tag or an MPEG frame sync; ADTS AAC is a sync with layer bits zero.
  const sync = audio.length >= 2 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0
  const layer = audio.length >= 2 ? audio[1]! & 0x06 : -1
  if (format === "aac") return sync && layer === 0
  return ascii(audio, 0).startsWith("ID3") || (sync && layer !== 0)
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

/** The deployment's retail price, when Azure publishes one for its version and SKU. */
function publishedRateCard(deployment: AzureAIFoundryDeployment): ModelRateCard | undefined {
  const skus =
    /^gpt-4o-mini-tts$/i.test(deployment.modelName) &&
    Object.hasOwn(PUBLISHED, deployment.modelVersion)
      ? PUBLISHED[deployment.modelVersion]
      : undefined
  const card =
    skus && Object.hasOwn(skus, deployment.sku.name) ? skus[deployment.sku.name] : undefined
  return card ? defineModelRateCard(card) : undefined
}

function speechEstimator(rateCard: ModelRateCard): SpeechCostEstimator {
  // The audio's length, so its output tokens, is unknown before the call: no reservation.
  return { estimate: ({ usage }) => rateModelCall({ usage, rateCard }) }
}
