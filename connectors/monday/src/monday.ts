import { rest } from "@sixb/connector-rest"
import { createMondayClient } from "./client"
import { retryDelay } from "./errors"
import { createMondayHttp } from "./http"
import type { MondayConnector, MondayConnectorOptions } from "./types"
import { integer, record } from "./validation"

const retryCodes = new Set([
  "ComplexityException",
  "COMPLEXITY_BUDGET_EXHAUSTED",
  "Rate Limit Exceeded",
  "IP_RATE_LIMIT_EXCEEDED",
  "maxConcurrencyExceeded",
])
export function monday(options: MondayConnectorOptions): MondayConnector {
  if (!options || typeof options !== "object") throw new Error("[SixbMonday] options are required.")
  if (typeof options.token !== "function") token(options.token)
  const timeoutMs = integer(options.timeoutMs ?? 30_000, "timeoutMs", 1, 2_147_483_647)
  const minDelayMs = integer(options.minDelayMs ?? 100, "minDelayMs", 0, 2_147_483_647)
  const maxRetries = integer(options.maxRetries ?? 2, "maxRetries", 0, 10)
  const endpoint = new URL(options.endpoint ?? "https://api.monday.com/v2")
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "[SixbMonday] endpoint must be HTTP(S), without credentials, query or fragment."
    )
  // Inspect cloned bodies inside the shared transport's retry hooks. The original remains
  // available for the final response/error and all attempts share pacing and cancellation.
  const metadata = new WeakMap<Response, { retry: boolean; delay: number | null }>()
  async function inspect(response: Response) {
    const cached = metadata.get(response)
    if (cached) return cached
    let body: unknown
    try {
      body = await response.clone().json()
    } catch {
      body = undefined
    }
    const errors = record(body) && Array.isArray(body.errors) ? body.errors : []
    const partial =
      record(body) && record(body.data) && Object.values(body.data).some((v) => v !== null)
    const graphQLRetry =
      errors.length > 0 &&
      errors.every(
        (e) =>
          record(e) &&
          record(e.extensions) &&
          typeof e.extensions.code === "string" &&
          retryCodes.has(e.extensions.code)
      )
    const legacyCode = record(body) ? body.error_code : undefined
    const transientStatus =
      response.status === 429 || [500, 502, 503, 504].includes(response.status)
    const result = {
      retry:
        !partial &&
        (errors.length > 0
          ? graphQLRetry
          : transientStatus && (legacyCode === undefined || retryCodes.has(String(legacyCode)))),
      delay: retryDelay(body, response.headers),
    }
    metadata.set(response, result)
    return result
  }
  const transport = rest({
    baseUrl: endpoint.toString(),
    timeoutMs,
    minDelayMs,
    headers: async () => ({
      Authorization: token(
        typeof options.token === "function" ? await options.token() : options.token
      ),
      "API-Version": "2026-07",
      Accept: "application/json",
    }),
    retry: {
      maxRetries,
      async shouldRetry({ response, idempotent }) {
        if (!idempotent || !response) return false
        const info = await inspect(response)
        // Do not shorten a provider delay or overflow the platform timer.
        return info.retry && (info.delay === null || info.delay <= 2_147_483_647)
      },
      async delayMs({ response, attempt }) {
        return (
          (response ? (await inspect(response)).delay : null) ??
          Math.min(1000 * 2 ** attempt, 30_000)
        )
      },
    },
  })
  return {
    type: "monday",
    async connect(context) {
      return createMondayClient(createMondayHttp(await transport.connect(context)))
    },
  }
}
function token(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
    throw new Error("[SixbMonday] token must be a non-empty single-line string.")
  return value.trim()
}
