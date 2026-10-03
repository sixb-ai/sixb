import {
  assertJsonObject,
  type JsonObject,
  ModelProviderError,
  type TranscriptionCostEstimator,
  type TranscriptionModel,
  type TranscriptionModelDefinition,
  type TranscriptionModelRequest,
  TranscriptionModelResponseError,
  type TranscriptionModelResponseMetadata,
} from "@sixb/core/models"

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
  estimator(): Promise<TranscriptionCostEstimator>
}

export function createGatewayTranscription(
  modelId: string,
  options: VercelGatewayTranscriptionOptions,
  transport: TranscriptionTransport,
  estimator?: TranscriptionCostEstimator
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
      await transport.estimator()
    )

  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition,
    costEstimator: estimator,
    ...(estimator ? {} : { resolve }),

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
      const payload = await readTranscriptionResponse(response, modelId, signal)
      const metadata = transport.metadata(payload, requestId)
      const audioDurationMs = durationInMilliseconds(payload.durationInSeconds)
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

      return { ...responseMetadata, output: { text: payload.text } }
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

function durationInMilliseconds(seconds: unknown): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return undefined
  }

  const milliseconds = Math.round(seconds * 1000)
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

async function readTranscriptionResponse(
  response: Response,
  modelId: string,
  signal: AbortSignal
): Promise<JsonObject> {
  const requestId = response.headers.get("x-request-id") ?? undefined

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    // A retry could repeat a billed inference; only the application can decide to try again.
    throw new ModelProviderError(
      `[SixbVercelGateway] Transcription returned HTTP ${response.status}.`,
      PROVIDER_ID,
      modelId,
      { status: response.status, requestId, retryable: false, code: "provider_rejection" }
    )
  }

  try {
    const payload: unknown = JSON.parse(await readResponseBody(response, signal))
    assertJsonObject(payload, "transcription response")
    return payload
  } catch {
    signal.throwIfAborted()
    throw new ModelProviderError(
      "[SixbVercelGateway] Transcription returned an invalid or oversized response.",
      PROVIDER_ID,
      modelId,
      { requestId, retryable: false, code: "invalid_response" }
    )
  }
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error("Oversized response")
  }
  if (!response.body) throw new Error("Empty response")

  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()

  const chunks: Uint8Array[] = []
  let sizeBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      // Do not discard a complete billable body if cancellation raced with its last chunk.
      if (done) break
      sizeBytes += value.byteLength
      if (sizeBytes > MAX_RESPONSE_BYTES) throw new Error("Oversized response")
      chunks.push(value)
    }

    return Buffer.concat(chunks, sizeBytes).toString("utf8")
  } finally {
    signal.removeEventListener("abort", cancel)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
