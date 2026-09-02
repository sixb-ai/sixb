import { createSixbClient, normalizeSixbApiBaseUrl, type SixbClient } from "@sixb/client"
import { SixbApiError } from "./errors"

export interface SixbApiClientConfig {
  readonly apiUrl: string
  readonly apiUrlSource: string
  readonly token?: string
  readonly tokenSource?: string
}

export function createCliSixbClient(config: SixbApiClientConfig): SixbClient {
  if (!config.token) {
    throw new Error(
      "[SixbCLI] Missing API token. Run `sixb login <api-url>`, select a profile, or set SIXB_API_TOKEN."
    )
  }

  return createSixbClient({
    baseUrl: config.apiUrl,
    auth: { kind: "bearer", token: config.token },
  })
}

export function unwrapSixbApiResult<T>(result: {
  readonly data?: T
  readonly error?: unknown
  readonly response?: Response
}): T {
  if (result.error !== undefined) {
    throw new SixbApiError(
      formatApiError(result.response?.status, result.error),
      result.response?.status,
      result.error
    )
  }

  if (result.data === undefined) {
    throw new SixbApiError("[SixbCLI] API request returned no data.", result.response?.status, null)
  }

  return result.data
}

export function normalizeApiUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`)
  }

  try {
    return normalizeSixbApiBaseUrl(value)
  } catch {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`)
  }
}

function formatApiError(status: number | undefined, body: unknown): string {
  const statusLabel = status === undefined ? "network" : String(status)
  if (typeof body === "object" && body && "error" in body && typeof body.error === "string") {
    return `[SixbCLI] API request failed (${statusLabel}): ${body.error}`
  }

  if (typeof body === "string" && body.trim()) {
    return `[SixbCLI] API request failed (${statusLabel}): ${body}`
  }

  if (body instanceof Error) {
    return `[SixbCLI] API request failed (${statusLabel}): ${body.message}`
  }

  return `[SixbCLI] API request failed (${statusLabel}).`
}
