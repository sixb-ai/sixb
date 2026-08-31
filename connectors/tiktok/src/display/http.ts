import { type RestClient, rest } from "@sixb/connector-rest"
import type { ConnectorContext, ConnectorTokenSource } from "@sixb/core"
import { assertNonEmpty, assertNonNegativeInteger, TiktokApiError } from "../http"
import type { TiktokResponseMetadata } from "../types/common"
import type { TiktokDisplayConnectorOptions } from "../types/options"

export const TIKTOK_DISPLAY_API_BASE_URL = "https://open.tiktokapis.com/v2/"

export interface TiktokDisplayApiResult<T> {
  readonly data: T
  readonly logId?: string
}

interface TiktokDisplayEnvelope<T> {
  readonly data: T
  readonly error: {
    readonly code: string
    readonly message: string
    readonly log_id?: string
  }
}

export class TiktokDisplayHttp {
  constructor(
    private readonly http: RestClient,
    private readonly tokenSource: ConnectorTokenSource,
    private readonly onResponse?: (metadata: TiktokResponseMetadata) => Promise<void> | void
  ) {}

  get<T>(path: string, fields: readonly string[]): Promise<TiktokDisplayApiResult<T>> {
    return this.request<T>("GET", withFields(path, fields))
  }

  post<T>(
    path: string,
    fields: readonly string[],
    body: unknown
  ): Promise<TiktokDisplayApiResult<T>> {
    return this.request<T>("POST", withFields(path, fields), body)
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<TiktokDisplayApiResult<T>> {
    for (let authorizationAttempt = 0; ; authorizationAttempt += 1) {
      const token = await this.tokenSource.get()
      const headers = { Authorization: `Bearer ${token.accessToken}` }
      const response =
        method === "GET"
          ? await this.http.get(path, { headers })
          : await this.http.post(path, body, { headers }, { idempotent: true })

      const parsed = await readDisplayResponse<T>(response)
      await this.onResponse?.(responseMetadata(response, path, method, parsed.logId))

      if (parsed.error && authorizationAttempt === 0 && isTokenFailure(parsed.error)) {
        token.invalidate()
        continue
      }
      if (parsed.error) throw parsed.error
      return { data: parsed.data as T, logId: parsed.logId }
    }
  }
}

export async function createTiktokDisplayHttp(
  context: ConnectorContext,
  options: TiktokDisplayConnectorOptions,
  tokenSource: ConnectorTokenSource
): Promise<TiktokDisplayHttp> {
  const maxRetries = options.retry?.maxRetries ?? 2
  assertNonNegativeInteger(maxRetries, "retry.maxRetries")

  const connector = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? TIKTOK_DISPLAY_API_BASE_URL),
    headers: { Accept: "application/json" },
    retry: { maxRetries },
    timeoutMs: options.timeoutMs,
  })

  return new TiktokDisplayHttp(await connector.connect(context), tokenSource, options.onResponse)
}

function withFields(path: string, fields: readonly string[]): string {
  if (fields.length === 0) {
    throw new Error("[SixbTikTok] fields must contain at least one field.")
  }
  const url = new URL(path, "https://sixb.invalid/")
  url.searchParams.set("fields", fields.join(","))
  return `${url.pathname.replace(/^\//, "")}${url.search}`
}

async function readDisplayResponse<T>(response: Response): Promise<{
  readonly data?: T
  readonly logId?: string
  readonly error?: TiktokApiError
}> {
  const rawBody = response.status === 204 ? "" : await response.text()
  const envelope = parseEnvelope<T>(rawBody)
  const logId = envelope?.error.log_id

  if (!response.ok || !envelope || envelope.error.code !== "ok") {
    return {
      logId,
      error: new TiktokApiError(
        response.status,
        envelope?.error.code,
        envelope?.error.message,
        logId,
        rawBody,
        response.headers
      ),
    }
  }

  return { data: envelope.data, logId }
}

function parseEnvelope<T>(rawBody: string): TiktokDisplayEnvelope<T> | undefined {
  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !("data" in value) || !isRecord(value.error)) return undefined
  if (typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    return undefined
  }
  return {
    data: value.data as T,
    error: {
      code: value.error.code,
      message: value.error.message,
      log_id: typeof value.error.log_id === "string" ? value.error.log_id : undefined,
    },
  }
}

function responseMetadata(
  response: Response,
  path: string,
  method: "GET" | "POST",
  logId: string | undefined
): TiktokResponseMetadata {
  return {
    path: new URL(path, "https://sixb.invalid/").pathname,
    method,
    status: response.status,
    logId: logId ?? response.headers.get("x-tt-logid") ?? undefined,
  }
}

function isTokenFailure(error: TiktokApiError): boolean {
  return (
    error.status === 401 ||
    /access[ _-]?token.*(?:invalid|expired)|(?:invalid|expired).*access[ _-]?token/i.test(
      `${error.code ?? ""} ${error.providerMessage ?? ""}`
    )
  )
}

function normalizeBaseUrl(value: string): string {
  assertNonEmpty(value, "baseUrl")
  return value.endsWith("/") ? value : `${value}/`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
