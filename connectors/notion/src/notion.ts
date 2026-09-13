import { rest } from "@sixb/connector-rest"
import { createPagesResource } from "./pages"
import type { NotionConnector, NotionConnectorOptions, NotionTokenResolver } from "./types"

/** Notion pages client using the 2026-03-11 API and Sixb's shared REST transport. */
export function notion(options: NotionConnectorOptions): NotionConnector {
  if (!options || typeof options !== "object") {
    throw new Error("[SixbNotion] options must be an object.")
  }
  if (typeof options.token !== "function") assertToken(options.token)
  const timeoutMs = options.timeoutMs ?? 30_000
  const minDelayMs = options.minDelayMs ?? 350
  const maxRetries = options.maxRetries ?? 2
  assertNumber(timeoutMs, "timeoutMs", 1)
  assertNumber(minDelayMs, "minDelayMs", 0)
  assertNumber(maxRetries, "maxRetries", 0)
  if (!Number.isInteger(maxRetries) || !Number.isInteger(timeoutMs)) {
    throw new Error("[SixbNotion] maxRetries and timeoutMs must be integers.")
  }
  const http = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? "https://api.notion.com/v1/"),
    headers: async () => ({
      Authorization: `Bearer ${await resolveToken(options.token)}`,
      "Notion-Version": "2026-03-11",
      Accept: "application/json",
    }),
    timeoutMs,
    minDelayMs,
    retry: {
      maxRetries,
      shouldRetry({ response, idempotent }) {
        const status = response?.status
        // Notion explicitly permits retrying rejected 429/529 writes. Ambiguous writes
        // (network failures or other 5xx responses) must never be replayed automatically.
        return (
          status === 429 ||
          status === 529 ||
          (idempotent && status !== undefined && [500, 502, 503, 504].includes(status))
        )
      },
    },
  })
  return {
    type: "notion",
    async connect(context) {
      return { pages: createPagesResource(await http.connect(context)) }
    },
  }
}

function assertToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error("[SixbNotion] token must be a non-empty single-line string.")
  }
}

async function resolveToken(resolver: NotionTokenResolver): Promise<string> {
  const value = typeof resolver === "function" ? await resolver() : resolver
  assertToken(value)
  return value.trim()
}

function assertNumber(value: number, field: string, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`[SixbNotion] ${field} must be a finite number >= ${min}.`)
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[SixbNotion] baseUrl must be an absolute HTTP(S) URL.")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("[SixbNotion] baseUrl must be HTTP(S) without credentials, query, or fragment.")
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.toString()
}
