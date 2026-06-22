import { createSixbClient, normalizeSixbApiBaseUrl, type SixbClient } from "@sixb/client"

export interface SixbApiClientConfig {
  readonly apiUrl: string
  readonly apiUrlSource: string
  readonly token?: string
  readonly tokenSource?: string
}

export interface ResolveApiClientConfigOptions {
  readonly apiUrl?: string
  readonly token?: string
  readonly env?: Record<string, string | undefined>
}

export class SixbApiError extends Error {
  readonly status: number | undefined
  readonly responseBody: unknown

  constructor(message: string, status: number | undefined, responseBody: unknown) {
    super(message)
    this.name = "SixbApiError"
    this.status = status
    this.responseBody = responseBody
  }
}

export function resolveApiClientConfig(
  options: ResolveApiClientConfigOptions = {}
): SixbApiClientConfig {
  const env = options.env ?? process.env
  const apiUrlCandidate = firstConfigValue([
    ["--api-url", options.apiUrl],
    ["SIXB_API_URL", env.SIXB_API_URL],
    ["SIXB_API_PUBLIC_ORIGIN", env.SIXB_API_PUBLIC_ORIGIN],
  ]) ?? { source: "default", value: "http://localhost:3002" }
  const tokenCandidate = firstConfigValue([
    ["--token", options.token],
    ["SIXB_API_TOKEN", env.SIXB_API_TOKEN],
    ["SIXB_TOKEN", env.SIXB_TOKEN],
  ])
  const apiUrl = normalizeApiUrl(apiUrlCandidate.value)

  return {
    apiUrl,
    apiUrlSource: apiUrlCandidate.source,
    ...(tokenCandidate
      ? {
          token: tokenCandidate.value,
          tokenSource: tokenCandidate.source,
        }
      : {}),
  }
}

export function createCliSixbClient(config: SixbApiClientConfig): SixbClient {
  if (!config.token) {
    throw new Error("[SixbCLI] Missing API token. Set SIXB_API_TOKEN or pass --token.")
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

function firstConfigValue(
  entries: readonly (readonly [source: string, value: string | undefined])[]
): { readonly source: string; readonly value: string } | undefined {
  for (const [source, raw] of entries) {
    const value = nonEmpty(raw)
    if (value !== undefined) {
      return { source, value }
    }
  }

  return undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
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
