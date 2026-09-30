import { FullEnrichApiError } from "./errors"
import type { FullEnrichApiKeyResolver } from "./types"

export function assertApiKeyResolver(apiKey: FullEnrichApiKeyResolver): void {
  if (typeof apiKey === "function") return
  if (typeof apiKey !== "string") {
    throw new Error("[SixbFullEnrich] apiKey must be a string or a function.")
  }
  assertApiKey(apiKey, Error)
}

/** Resolve the key for one request or webhook verification. */
export async function resolveApiKey(apiKey: FullEnrichApiKeyResolver): Promise<string> {
  let value: unknown
  try {
    value = typeof apiKey === "function" ? await apiKey() : apiKey
  } catch (error) {
    throw new FullEnrichApiError("[SixbFullEnrich] Could not resolve apiKey.", { cause: error })
  }
  return assertApiKey(value, FullEnrichApiError)
}

function assertApiKey(value: unknown, ErrorType: new (message: string) => Error): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new ErrorType("[SixbFullEnrich] apiKey must be a non-empty single-line string.")
  }
  // Headers trim surrounding whitespace; signing with the same trimmed value keeps webhook
  // verification consistent with the key the API saw.
  return value.trim()
}
