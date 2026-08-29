import type { SixbErrorCode } from "@sixb/core"
import { assertSharedAccessGrantId, markClientSharedAuthority } from "./client-authority"
import { type Auth, type Client, type Config, createClient, createConfig } from "./generated/client"
import { client as sharedClient } from "./generated/client.gen"

export const SIXB_CSRF_HEADER_NAME = "x-sixb-csrf"
export const SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME = "x-sixb-csrf-token"
export const SIXB_SHARED_ACCESS_GRANT_HEADER_NAME = "x-sixb-share-grant"

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
      readonly kind: "shared"
      readonly grantId: string
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
}

/** Known Sixb codes with a forward-compatible escape hatch for newer servers. */
export type SixbApiErrorCode = SixbErrorCode | (string & Record<never, never>)

/**
 * A structured HTTP error thrown by the Sixb client. The raw generated client
 * throws the bare response body (a string, or parsed JSON) with no status code
 * or identity, which makes failures impossible to branch on and prints as
 * cryptic quoted text in dev tooling. `SixbApiError` carries the status, the
 * parsed `body`, an optional stable `code`, and a readable `message`, so callers
 * and error boundaries can branch without parsing prose.
 */
export class SixbApiError extends Error {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly method: string
  readonly body: unknown
  readonly code?: SixbApiErrorCode

  constructor(message: string, init: SixbApiErrorInit) {
    super(message)
    this.name = "SixbApiError"
    this.status = init.status
    this.statusText = init.statusText ?? ""
    this.url = init.url ?? ""
    this.method = init.method ?? ""
    this.body = init.body
    this.code = extractErrorCode(init.body)
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
  markClientSharedAuthority(client, options.auth?.kind === "shared")
  installSixbErrorInterceptor(client)
  return client
}

export function configureSixbClient(
  client: SixbClient,
  options: SixbClientOptions = {}
): SixbClient {
  client.setConfig(createSixbClientConfig(options))
  markClientSharedAuthority(client, options.auth?.kind === "shared")
  installSixbErrorInterceptor(client)
  return client
}

export function createSixbClientConfig(options: SixbClientOptions = {}): Config {
  const auth = options.auth ?? { kind: "none" as const }
  if (auth.kind === "bearer" && !auth.token.trim()) {
    throw new Error("[SixbClient] Bearer token cannot be empty.")
  }
  if (auth.kind === "shared") {
    assertSharedAccessGrantId(auth.grantId)
  }

  const baseUrl =
    options.baseUrl === undefined ? undefined : normalizeSixbApiBaseUrl(options.baseUrl)
  const configuredFetch =
    auth.kind === "shared"
      ? createSharedAuthorityFetch({
          baseUrl,
          grantId: auth.grantId,
          fetch: options.fetch ?? globalThis.fetch,
        })
      : options.fetch

  return createConfig({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(configuredFetch === undefined ? {} : { fetch: configuredFetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    credentials: auth.kind === "cookie" || auth.kind === "shared" ? "include" : options.credentials,
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

    if (auth.kind === "shared") {
      if (isSharedGrantAuth(scheme)) return auth.grantId
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

function isSharedGrantAuth(auth: Auth): boolean {
  return (
    auth.type === "apiKey" &&
    auth.in !== "query" &&
    auth.name === SIXB_SHARED_ACCESS_GRANT_HEADER_NAME
  )
}

function createSharedAuthorityFetch(input: {
  readonly baseUrl?: string
  readonly grantId: string
  readonly fetch: typeof fetch
}): typeof fetch {
  const apiOrigin = resolveSharedApiOrigin(input.baseUrl)
  const terminalFetch = async (
    requestInput: Parameters<typeof fetch>[0],
    requestInit?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const request =
      requestInput instanceof Request && requestInit === undefined
        ? requestInput
        : new Request(requestInput, requestInit)
    if (new URL(request.url).origin !== apiOrigin) {
      throw new Error("[SixbClient] Shared access requests cannot leave the configured API origin.")
    }

    // This is the terminal transport boundary: hey-api request interceptors have all run before
    // the configured fetch is invoked, so none can merge ambient bearer authority into the Share.
    const headers = new Headers(request.headers)
    headers.delete("authorization")
    headers.set(SIXB_SHARED_ACCESS_GRANT_HEADER_NAME, input.grantId)
    const boundedRequest = new Request(request, {
      credentials: "include",
      headers,
      redirect: "error",
    })
    return await input.fetch.call(globalThis, boundedRequest)
  }

  return Object.assign(terminalFetch, { preconnect: input.fetch.preconnect })
}

function resolveSharedApiOrigin(baseUrl: string | undefined): string {
  const browserOrigin =
    typeof globalThis.location === "object" && typeof globalThis.location.origin === "string"
      ? globalThis.location.origin
      : undefined
  const resolvedBaseUrl = baseUrl || browserOrigin
  if (resolvedBaseUrl === undefined) {
    throw new Error(
      "[SixbClient] Shared access requires an absolute API base URL outside the browser."
    )
  }

  try {
    return new URL(resolvedBaseUrl, browserOrigin).origin
  } catch {
    throw new Error("[SixbClient] Shared access API base URL is invalid.")
  }
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
  return new SixbApiError(buildSixbApiErrorMessage(method, url, response, error), {
    status: response.status,
    statusText: response.statusText,
    url,
    method,
    body: error,
  })
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

function extractErrorCode(body: unknown): SixbApiErrorCode | undefined {
  if (!body || typeof body !== "object") {
    return undefined
  }

  try {
    const code = Reflect.get(body, "code")
    return typeof code === "string" && code.trim() === code && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
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

// Package-level SDK functions use the generated singleton. Initialize it once at the transport
// boundary so the shared client and `createSixbClient()` expose the same HTTP error contract.
installSixbErrorInterceptor(sharedClient)
