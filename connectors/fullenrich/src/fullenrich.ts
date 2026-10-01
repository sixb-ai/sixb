import {
  parseRetryAfter,
  type RestRetryContext,
  rest,
  shouldRetryRestRequest,
} from "@sixb/connector-rest"
import { assertApiKeyResolver, resolveApiKey } from "./api-key"
import { createFullEnrichClient } from "./client"
import { createFullEnrichHttp } from "./http"
import type { FullEnrichConnector, FullEnrichConnectorOptions } from "./types"
import { assertInteger } from "./validation"
import { createFullEnrichWebhooks } from "./webhooks"

const DEFAULT_BASE_URL = "https://app.fullenrich.com/api/v2/"
const MAX_TIMER_MS = 2_147_483_647

/**
 * FullEnrich connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client grouped by resource (`enrichments`, `reverseEmailLookups`, `people`,
 * `companies`, `account`). Passing `onEnrichmentResult` or `onReverseEmailLookupResult` also
 * registers a signed inbound webhook for asynchronous job results.
 *
 * ```ts
 * export const fullenrichConnector = defineConnector("fullenrich", fullenrich({
 *   apiKey: process.env.FULLENRICH_API_KEY!,
 * }))
 * ```
 */
export function fullenrich(options: FullEnrichConnectorOptions): FullEnrichConnector {
  if (!options || typeof options !== "object") {
    throw new Error("[SixbFullEnrich] options must be an object.")
  }
  assertApiKeyResolver(options.apiKey)
  const timeoutMs = options.timeoutMs ?? 30_000
  assertInteger(timeoutMs, "timeoutMs", 1, MAX_TIMER_MS)
  const minDelayMs = options.minDelayMs ?? 0
  assertInteger(minDelayMs, "minDelayMs", 0, MAX_TIMER_MS)
  const maxRetries = options.maxRetries ?? 2
  assertInteger(maxRetries, "maxRetries", 0, 10)

  const transport = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({ Authorization: `Bearer ${await resolveApiKey(options.apiKey)}` }),
    timeoutMs,
    minDelayMs,
    retry: { maxRetries, shouldRetry: shouldRetryRestRequest, delayMs: retryDelayMs },
  })
  const webhooks = createFullEnrichWebhooks(options)

  return {
    type: "fullenrich",
    ...(webhooks.length > 0 ? { webhooks } : {}),
    async connect(context) {
      return createFullEnrichClient(
        createFullEnrichHttp(await transport.connect(context), context.signal)
      )
    },
  }
}

/**
 * FullEnrich limits each workspace per calendar minute, so a 429 without `Retry-After` waits for
 * the next window instead of backing off into the same exhausted one.
 */
function retryDelayMs(context: RestRetryContext): number {
  const retryAfter = parseRetryAfter(context.response?.headers.get("retry-after") ?? null)
  if (retryAfter !== null) return retryAfter
  if (context.response?.status === 429) return 60_000 - (Date.now() % 60_000) + 250
  return Math.min(1000 * 2 ** context.attempt, 30_000)
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[SixbFullEnrich] baseUrl must be an absolute HTTP(S) URL.")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "[SixbFullEnrich] baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment."
    )
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.toString()
}
