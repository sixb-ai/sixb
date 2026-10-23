import { assertJsonObject, type JsonObject, ModelProviderError } from "@sixb/core/models"

const PROVIDER_ID = "vercel-ai-gateway"

/** Read one bounded JSON reply from a billed, non-retried Gateway call. */
export async function readGatewayJson(
  response: Response,
  input: {
    readonly modelId: string
    /** Names the call in errors, such as `Transcription`. */
    readonly operation: string
    readonly maxBytes: number
    readonly signal: AbortSignal
  }
): Promise<JsonObject> {
  const requestId = response.headers.get("x-request-id") ?? undefined

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    // A retry could repeat a billed inference; only the application can decide to try again.
    throw new ModelProviderError(
      `[SixbVercelGateway] ${input.operation} returned HTTP ${response.status}.`,
      PROVIDER_ID,
      input.modelId,
      { status: response.status, requestId, retryable: false, code: "provider_rejection" }
    )
  }

  try {
    const payload: unknown = JSON.parse(
      await readResponseBody(response, input.maxBytes, input.signal)
    )
    assertJsonObject(payload, `${input.operation.toLowerCase()} response`)
    return payload
  } catch {
    input.signal.throwIfAborted()
    throw new ModelProviderError(
      `[SixbVercelGateway] ${input.operation} returned an invalid or oversized response.`,
      PROVIDER_ID,
      input.modelId,
      { requestId, retryable: false, code: "invalid_response" }
    )
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
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
      if (sizeBytes > maxBytes) throw new Error("Oversized response")
      chunks.push(value)
    }

    return Buffer.concat(chunks, sizeBytes).toString("utf8")
  } finally {
    signal.removeEventListener("abort", cancel)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
