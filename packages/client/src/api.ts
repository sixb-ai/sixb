import type { SixbErrorCode } from "@sixb/core/errors"
import { type Auth, type Client, type Config, createClient, createConfig } from "./generated/client"

export const SIXB_CSRF_HEADER_NAME = "x-sixb-csrf"
export const SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME = "x-sixb-csrf-token"

export type SixbClient = Client

export type SixbClientAuth =
  | {
      readonly kind: "bearer"
      readonly token: string
    }
  | {
      readonly kind: "cookie"
      readonly csrfToken?: () => string | null | undefined
    }
  | {
      readonly kind: "none"
    }

export interface SixbClientOptions {
  readonly baseUrl?: string
  readonly auth?: SixbClientAuth
  readonly fetch?: typeof fetch
  readonly headers?: Config["headers"]
  readonly credentials?: RequestCredentials
}

export interface SixbApiErrorInit {
  readonly status: number
  readonly statusText?: string
  readonly url?: string
  readonly method?: string
  readonly body?: unknown
  readonly code?: SixbErrorCode
}

/**
 * A structured HTTP error thrown by the Sixb client. The raw generated client
 * throws the bare response body (a string, or parsed JSON) with no status code
 * or identity, which makes failures impossible to branch on and prints as
 * cryptic quoted text in dev tooling. `SixbApiError` carries the status, the
 * parsed `body`, and a readable `message`, so callers and error boundaries can
 * tell a `404` apart from a `500` instead of catching a stringy blob.
 */
export class SixbApiError extends Error {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly method: string
  readonly body: unknown
  /**
   * The failure's code, lifted out of the body.
   *
   * Absent only when the response did not come from Sixb — a proxy's own 502, a gateway timeout
   * page. Every error the API itself returns carries one, and it is finer than the status: two
   * conditions answer 409 and only the code says which.
   */
  readonly code?: SixbErrorCode

  constructor(message: string, init: SixbApiErrorInit) {
    super(message)
    this.name = "SixbApiError"
    this.status = init.status
    this.statusText = init.statusText ?? ""
    this.url = init.url ?? ""
    this.method = init.method ?? ""
    this.body = init.body
    this.code = init.code
  }
}

/**
 * Identifies a `SixbApiError` across bundle boundaries. The custom app and the
 * client are bundled separately, so a plain `instanceof` would miss errors that
 * crossed packages; the structural fallback recognizes them by shape.
 */
export function isSixbApiError(value: unknown): value is SixbApiError {
  if (value instanceof SixbApiError) {
    return true
  }
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "SixbApiError" &&
    typeof (value as { status?: unknown }).status === "number"
  )
}

export function createSixbClient(options: SixbClientOptions = {}): SixbClient {
  const client = createClient(createSixbClientConfig(options))
  installSixbErrorInterceptor(client)
  return client
}

export function configureSixbClient(
  client: SixbClient,
  options: SixbClientOptions = {}
): SixbClient {
  client.setConfig(createSixbClientConfig(options))
  installSixbErrorInterceptor(client)
  return client
}

export function createSixbClientConfig(options: SixbClientOptions = {}): Config {
  const auth = options.auth ?? { kind: "none" as const }
  if (auth.kind === "bearer" && !auth.token.trim()) {
    throw new Error("[SixbClient] Bearer token cannot be empty.")
  }

  return createConfig({
    ...(options.baseUrl === undefined ? {} : { baseUrl: normalizeSixbApiBaseUrl(options.baseUrl) }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    credentials: auth.kind === "cookie" ? "include" : options.credentials,
    auth: auth.kind === "none" ? undefined : createSixbAuthResolver(auth),
  })
}

export function normalizeSixbApiBaseUrl(value: string): string {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
  let url: URL

  try {
    url = new URL(value, absolute ? undefined : "http://sixb.local")
  } catch {
    throw new Error(`[SixbClient] Invalid API base URL '${value}'.`)
  }

  const pathname = stripTrailingApiPath(url.pathname)
  if (!absolute) {
    return pathname
  }

  return `${url.origin}${pathname === "/" ? "" : pathname}`
}

function createSixbAuthResolver(auth: SixbClientAuth): Config["auth"] {
  return (scheme: Auth) => {
    if (auth.kind === "bearer") {
      return isBearerAuth(scheme) ? auth.token : undefined
    }

    if (auth.kind === "cookie") {
      return isCsrfAuth(scheme) ? (auth.csrfToken?.() ?? undefined) : undefined
    }

    return undefined
  }
}

function isBearerAuth(auth: Auth): boolean {
  return auth.type === "http" && auth.scheme === "bearer"
}

function isCsrfAuth(auth: Auth): boolean {
  return auth.type === "apiKey" && auth.in !== "query" && auth.name === SIXB_CSRF_HEADER_NAME
}

function stripTrailingApiPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "")
  if (!trimmed || trimmed === "/api") {
    return ""
  }

  if (trimmed.endsWith("/api")) {
    return trimmed.slice(0, -4) || ""
  }

  return trimmed
}

/**
 * Maps the generated client's raw error (bare body) into a `SixbApiError`.
 * Runs for every failed response regardless of `throwOnError`, so both thrown
 * errors and the `{ error }` result field carry the structured type. Network
 * failures (no `response`) are already native `Error`s and pass through.
 */
function sixbErrorInterceptor(
  error: unknown,
  response: Response | undefined,
  request: Request | undefined
): unknown {
  if (isSixbApiError(error) || !response) {
    return error
  }

  const method = request?.method ?? ""
  const url = response.url || request?.url || ""
  const code = extractErrorCode(error)
  return new SixbApiError(buildSixbApiErrorMessage(method, url, response, error), {
    status: response.status,
    statusText: response.statusText,
    url,
    method,
    body: error,
    ...(code ? { code } : {}),
  })
}

/**
 * Read structurally rather than against `SIXB_ERROR_CODES`: a client older than a code would drop
 * it, which is worse than surfacing a string the caller's `switch` happens not to match.
 */
function extractErrorCode(body: unknown): SixbErrorCode | undefined {
  if (!body || typeof body !== "object" || !("code" in body)) {
    return undefined
  }
  const code = (body as { code: unknown }).code
  return typeof code === "string" && code.includes(".") ? (code as SixbErrorCode) : undefined
}

function buildSixbApiErrorMessage(
  method: string,
  url: string,
  response: Response,
  body: unknown
): string {
  const status = response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status)
  const target = [method, safeRequestPath(url)].filter(Boolean).join(" ")
  const head = target ? `[SixbClient] ${target} → ${status}` : `[SixbClient] request → ${status}`
  const detail = extractErrorDetail(body)
  return detail ? `${head}: ${detail}` : head
}

function extractErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body.trim() || undefined
  }
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error: unknown }).error
    if (typeof message === "string" && message.trim()) {
      return message
    }
  }
  return undefined
}

function safeRequestPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function installSixbErrorInterceptor(client: SixbClient): void {
  if (!client.interceptors.error.exists(sixbErrorInterceptor)) {
    client.interceptors.error.use(sixbErrorInterceptor)
  }
}
