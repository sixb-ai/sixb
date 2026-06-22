import { type Auth, type Client, type Config, createClient, createConfig } from "./generated/client"

export const SIXB_CSRF_HEADER_NAME = "x-sixb-csrf"

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

export function createSixbClient(options: SixbClientOptions = {}): SixbClient {
  return createClient(createSixbClientConfig(options))
}

export function configureSixbClient(
  client: SixbClient,
  options: SixbClientOptions = {}
): SixbClient {
  client.setConfig(createSixbClientConfig(options))
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
