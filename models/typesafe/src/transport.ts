import {
  type DecisionModelRequest,
  type DecisionModelResult,
  ModelProviderError,
} from "@sixb/core/models"
import { typesafeQuestions } from "./request"
import { typesafeResponse } from "./response"

export interface TypesafeTransport {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly apiKey: () => string | undefined
}

export async function evaluateTypesafe(
  transport: TypesafeTransport,
  modelId: string,
  request: DecisionModelRequest
): Promise<DecisionModelResult> {
  const apiKey = transport.apiKey()
  if (!apiKey?.trim()) {
    throw new ModelProviderError(
      "[SixbTypeSafe] Set TYPESAFE_API_KEY or configure apiKey.",
      "typesafe",
      modelId,
      { code: "missing_api_key" }
    )
  }

  const signal = AbortSignal.any([
    ...(request.signal ? [request.signal] : []),
    AbortSignal.timeout(transport.timeoutMs),
  ])
  signal.throwIfAborted()

  const response = await transport.fetch(transport.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      state: request.input,
      questions: typesafeQuestions(request.questions),
    }),
    signal,
  })

  const requestId = response.headers.get("x-request-id") ?? undefined
  if (!response.ok) {
    // Never persist upstream bodies: they may contain prompts or credentials.
    await response.body?.cancel().catch(() => undefined)
    throw httpError(response, modelId, requestId)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new ModelProviderError("[SixbTypeSafe] Jev returned invalid JSON.", "typesafe", modelId, {
      code: "invalid_json",
      requestId,
      cause,
    })
  }

  return typesafeResponse(body, request.questions, modelId, requestId)
}

function httpError(response: Response, modelId: string, requestId: string | undefined) {
  const { status } = response
  const hint = status === 422 ? " Check question configuration and model context limits." : ""
  const retryAfter = response.headers.get("retry-after")
  const delay = retryAfter ? Number(retryAfter) : Number.NaN

  return new ModelProviderError(
    `[SixbTypeSafe] Jev returned HTTP ${status}.${hint}`,
    "typesafe",
    modelId,
    {
      status,
      requestId,
      code: status === 422 ? "invalid_request" : "provider_rejection",
      retryable: [429, 529, 502, 503, 504].includes(status),
      ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: delay * 1000 } : {}),
    }
  )
}
