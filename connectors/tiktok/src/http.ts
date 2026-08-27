import { type RestClient, rest } from "@sixb/connector-rest"
import type { ConnectorContext, ConnectorTokenSource } from "@sixb/core"
import type { TiktokResponseMetadata } from "./types/common"
import type { TiktokConnectorOptions } from "./types/options"

export const TIKTOK_API_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3/"

export interface TiktokApiResult<T> {
  readonly data: T
  readonly requestId?: string
}

interface TiktokEnvelope<T> {
  readonly code: number
  readonly message: string
  readonly request_id?: string
  readonly data: T
}

/** Raised for a valid TikTok response whose HTTP status or API envelope reports a failure. */
export class TiktokApiError extends Error {
  readonly name = "TiktokApiError"

  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly providerMessage: string | undefined,
    readonly requestId: string | undefined,
    readonly rawBody: string,
    readonly headers: Headers
  ) {
    super(formatApiError(status, code, providerMessage, requestId))
  }
}

export class TiktokHttp {
  constructor(
    private readonly http: RestClient,
    private readonly tokenSource: ConnectorTokenSource,
    private readonly onResponse?: (metadata: TiktokResponseMetadata) => Promise<void> | void
  ) {}

  get<T>(path: string, query: TiktokQuery = {}): Promise<TiktokApiResult<T>> {
    return this.request<T>("GET", withTiktokQuery(path, query), undefined, true)
  }

  post<T>(
    path: string,
    body: unknown,
    options: { readonly authenticated?: boolean } = {}
  ): Promise<TiktokApiResult<T>> {
    return this.request<T>("POST", path, body, options.authenticated ?? true)
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    authenticated: boolean
  ): Promise<TiktokApiResult<T>> {
    for (let authorizationAttempt = 0; ; authorizationAttempt += 1) {
      const token = authenticated ? await this.tokenSource.get() : undefined
      const response =
        method === "GET"
          ? await this.http.get(path, {
              headers: token ? { "Access-Token": token.accessToken } : undefined,
            })
          : await this.http.post(
              path,
              body,
              { headers: token ? { "Access-Token": token.accessToken } : undefined },
              { idempotent: true }
            )

      const parsed = await readTiktokResponse<T>(response)
      await this.onResponse?.(responseMetadata(response, path, method, parsed.requestId))

      if (parsed.error && token && authorizationAttempt === 0 && isTokenFailure(parsed.error)) {
        token.invalidate()
        continue
      }
      if (parsed.error) throw parsed.error
      return { data: parsed.data as T, requestId: parsed.requestId }
    }
  }
}

export async function createTiktokHttp(
  context: ConnectorContext,
  options: TiktokConnectorOptions,
  tokenSource: ConnectorTokenSource
): Promise<TiktokHttp> {
  const maxRetries = options.retry?.maxRetries ?? 2
  assertNonNegativeInteger(maxRetries, "retry.maxRetries")

  const connector = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? TIKTOK_API_BASE_URL),
    headers: { Accept: "application/json" },
    retry: { maxRetries },
    timeoutMs: options.timeoutMs,
  })

  return new TiktokHttp(await connector.connect(context), tokenSource, options.onResponse)
}

export type TiktokQueryValue =
  | string
  | number
  | boolean
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | null
  | undefined

export type TiktokQuery = Readonly<Record<string, TiktokQueryValue>>

export function withTiktokQuery(path: string, query: TiktokQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(
      key,
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value)
    )
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbTikTok] ${field} must not be empty.`)
  }
}

export function assertPositiveIntegerInRange(
  value: number | undefined,
  field: string,
  maximum: number
): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`[SixbTikTok] ${field} must be an integer between 1 and ${maximum}.`)
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[SixbTikTok] ${field} must be a non-negative integer.`)
  }
}

export function fixedTokenSource(accessToken: string): ConnectorTokenSource {
  assertNonEmpty(accessToken, "accessToken")
  return {
    async get() {
      return { accessToken, invalidate() {} }
    },
  }
}

function normalizeBaseUrl(value: string): string {
  assertNonEmpty(value, "baseUrl")
  return value.endsWith("/") ? value : `${value}/`
}

async function readTiktokResponse<T>(response: Response): Promise<{
  readonly data?: T
  readonly requestId?: string
  readonly error?: TiktokApiError
}> {
  const rawBody = response.status === 204 ? "" : await response.text()
  const body = parseJson(rawBody)
  const envelope = parseEnvelope<T>(body)
  const requestId = envelope?.request_id

  if (!response.ok || !envelope || envelope.code !== 0) {
    return {
      requestId,
      error: new TiktokApiError(
        response.status,
        envelope?.code,
        envelope?.message,
        requestId,
        rawBody,
        response.headers
      ),
    }
  }

  return { data: envelope.data, requestId }
}

function parseEnvelope<T>(value: unknown): TiktokEnvelope<T> | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.code !== "number" || typeof value.message !== "string" || !("data" in value)) {
    return undefined
  }
  return {
    code: value.code,
    message: value.message,
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
    data: value.data as T,
  }
}

function responseMetadata(
  response: Response,
  path: string,
  method: "GET" | "POST",
  requestId: string | undefined
): TiktokResponseMetadata {
  return {
    path: new URL(path, "https://sixb.invalid/").pathname,
    method,
    status: response.status,
    requestId,
    logId: response.headers.get("x-tt-logid") ?? undefined,
    adsThrottle: response.headers.get("x-tt-ads-throttle") ?? undefined,
  }
}

function isTokenFailure(error: TiktokApiError): boolean {
  return (
    error.status === 401 ||
    /access[ _-]?token.*(?:invalid|expired)|(?:invalid|expired).*access[ _-]?token/i.test(
      error.providerMessage ?? ""
    )
  )
}

function parseJson(rawBody: string): unknown {
  if (!rawBody) return undefined
  try {
    return JSON.parse(rawBody)
  } catch {
    return rawBody
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatApiError(
  status: number,
  code: number | undefined,
  providerMessage: string | undefined,
  requestId: string | undefined
): string {
  const details = [
    `HTTP ${status}`,
    code === undefined ? undefined : `code ${code}`,
    providerMessage || undefined,
    requestId ? `request ${requestId}` : undefined,
  ].filter(Boolean)
  return `[SixbTikTok] TikTok API request failed (${details.join(", ")}).`
}
