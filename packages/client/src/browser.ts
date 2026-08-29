import type { AuthSessionAudience } from "@sixb/core"
import {
  configureSixbClient as configureGeneratedSixbClient,
  normalizeSixbApiBaseUrl,
  SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME,
} from "./api"
import {
  assertSharedAccessGrantId,
  hasClientSharedAuthority,
  markClientSharedAuthority,
} from "./client-authority"
import { client } from "./generated/client.gen"

export type { SixbApiErrorCode, SixbApiErrorInit } from "./api"
export { isSixbApiError, SixbApiError } from "./api"

import {
  exchangeSharedAccess,
  getAuthSession,
  getSharedAccessSession,
  signOutSharedAccess,
} from "./generated/sdk.gen"
import type {
  ExchangeSharedAccessResponse,
  GetAuthSessionResponse,
  SignOutSharedAccessResponse,
} from "./generated/types.gen"

const SESSION_ACTIVITY_HEADER_NAME = "x-sixb-session-activity"
const SESSION_ACTIVITY_HEADER_VALUE = "1"
const SESSION_ACTIVITY_WINDOW_MS = 5 * 60_000
const SESSION_ACTIVITY_EVENT_TYPES = ["pointerdown", "keydown", "touchstart"] as const
const SESSION_ACTIVITY_LISTENER_OPTIONS = { capture: true, passive: true } as const

export interface SixbBrowserRuntimeConfig {
  readonly api: {
    readonly baseUrl: string
  }
  readonly auth: {
    readonly audience: AuthSessionAudience
    readonly enabled: boolean
  }
}

export interface SixbBrowserRuntimeDefaults {
  readonly apiBaseUrl?: string
  readonly audience: AuthSessionAudience
  readonly authEnabled?: boolean
}

export interface SixbBrowserClientController {
  setCsrfToken(token: string | null): void
  getCsrfToken(): string | null
  dispose(): void
}

export interface SixbBrowserClientOptions {
  readonly getCurrentUrl?: () => string | null
  readonly redirect?: (url: string) => void
}

export interface SixbSharedBrowserClientOptions {
  readonly grantId: string
  readonly fetch?: typeof fetch
}

export type SixbSharedAccessSession = ExchangeSharedAccessResponse

export interface SixbSharedBrowserClientController extends SixbBrowserClientController {
  readonly grantId: string
  exchange(secret: string): Promise<SixbSharedAccessSession>
  getSession(): Promise<SixbSharedAccessSession>
  establish(secret: string | null): Promise<SixbSharedAccessSession>
  signOut(): Promise<SignOutSharedAccessResponse>
}

let activeBrowserController: SixbBrowserClientController | null = null

declare global {
  interface Window {
    __SIXB_RUNTIME__?: Partial<SixbBrowserRuntimeConfig>
  }
}

export function renderSixbBrowserRuntimeScript(config: SixbBrowserRuntimeConfig): string {
  const safeConfig = JSON.stringify(config).replaceAll("<", "\\u003c")
  return `<script>window.__SIXB_RUNTIME__ = ${safeConfig};</script>`
}

export function readSixbBrowserRuntimeConfig(
  defaults: SixbBrowserRuntimeDefaults
): SixbBrowserRuntimeConfig {
  const runtime = window.__SIXB_RUNTIME__
  const runtimeAuthEnabled = runtime?.auth?.enabled
  return {
    api: {
      baseUrl: normalizeSixbApiBaseUrl(
        runtime?.api?.baseUrl ?? defaults.apiBaseUrl ?? window.location.origin
      ),
    },
    auth: {
      audience: runtime?.auth?.audience ?? defaults.audience,
      enabled:
        typeof runtimeAuthEnabled === "boolean"
          ? runtimeAuthEnabled
          : (defaults.authEnabled ?? true),
    },
  }
}

export function configureSixbBrowserClient(
  config: SixbBrowserRuntimeConfig,
  options: SixbBrowserClientOptions = {}
): SixbBrowserClientController {
  activeBrowserController?.dispose()

  let csrfToken: string | null = null
  let disposed = false
  let redirectStarted = false

  configureGeneratedSixbClient(client, {
    baseUrl: config.api.baseUrl,
    auth: {
      kind: "cookie",
      csrfToken: () => csrfToken,
    },
  })
  const disposeActivity = installVisibleSessionActivity()
  const authResponseInterceptorId = client.interceptors.response.use((response, request) => {
    const responseCsrfToken = response.headers.get(SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME)
    if (responseCsrfToken) {
      csrfToken = responseCsrfToken
    }

    if (
      !config.auth.enabled ||
      response.status !== 401 ||
      isAuthRedirectExcludedRequest(config, request) ||
      request.headers.has("authorization")
    ) {
      return response
    }

    csrfToken = null
    if (redirectStarted) {
      return response
    }

    try {
      const currentUrl = options.getCurrentUrl
        ? options.getCurrentUrl()
        : typeof window === "undefined"
          ? null
          : window.location.href
      if (!currentUrl || isSixbAuthPage(config, currentUrl)) {
        return response
      }

      redirectStarted = true
      const redirect =
        options.redirect ??
        ((url: string) => {
          if (typeof window !== "undefined") window.location.assign(url)
        })
      redirect(createSixbSignInUrl(config, currentUrl))
    } catch {
      // Allow a later response to retry navigation without replacing the original API error.
      redirectStarted = false
    }
    return response
  })

  const controller: SixbBrowserClientController = {
    setCsrfToken(token) {
      csrfToken = token
    },
    getCsrfToken() {
      return csrfToken
    },
    dispose() {
      if (disposed) return
      disposed = true
      csrfToken = null
      disposeActivity()
      client.interceptors.response.eject(authResponseInterceptorId)
      if (activeBrowserController === controller) {
        activeBrowserController = null
        client.setConfig({ auth: undefined, credentials: undefined })
      }
    },
  }

  activeBrowserController = controller
  return controller
}

/**
 * Configures the package singleton for one Share authority. Once established, ordinary generated
 * SDK functions, object queries, and React hooks use the same client without a resource facade.
 */
export function configureSixbSharedBrowserClient(
  config: SixbBrowserRuntimeConfig,
  options: SixbSharedBrowserClientOptions
): SixbSharedBrowserClientController {
  activeBrowserController?.dispose()
  assertSharedAccessGrantId(options.grantId)

  const previousConfig = client.getConfig()
  const previousSharedAuthority = hasClientSharedAuthority(client)
  let csrfToken: string | null = null
  let disposed = false
  configureGeneratedSixbClient(client, {
    baseUrl: config.api.baseUrl,
    auth: {
      kind: "shared",
      grantId: options.grantId,
      csrfToken: () => csrfToken,
    },
    fetch: options.fetch,
  })

  const disposeActivity = installVisibleSessionActivity()
  const responseInterceptorId = client.interceptors.response.use((response) => {
    const responseCsrfToken = response.headers.get(SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME)
    if (responseCsrfToken) csrfToken = responseCsrfToken
    if (response.status === 401) csrfToken = null
    return response
  })

  const acceptSession = (session: SixbSharedAccessSession): SixbSharedAccessSession => {
    try {
      assertSharedAccessSession(session, options.grantId)
    } catch (error) {
      csrfToken = null
      throw error
    }
    csrfToken = session.csrfToken
    return session
  }

  const controller: SixbSharedBrowserClientController = {
    grantId: options.grantId,
    setCsrfToken(token) {
      csrfToken = token
    },
    getCsrfToken() {
      return csrfToken
    },
    async exchange(secret) {
      assertSharedSecret(secret)
      csrfToken = null
      return acceptSession(await exchangeSharedSession(options.grantId, secret))
    },
    async getSession() {
      csrfToken = null
      return acceptSession(await getSharedSession(options.grantId))
    },
    async establish(secret) {
      return secret === null ? await controller.getSession() : await controller.exchange(secret)
    },
    async signOut() {
      const result = await signOutSharedSession(options.grantId)
      csrfToken = null
      return result
    },
    dispose() {
      if (disposed) return
      disposed = true
      csrfToken = null
      disposeActivity()
      client.interceptors.response.eject(responseInterceptorId)
      if (activeBrowserController === controller) {
        activeBrowserController = null
        client.setConfig({
          auth: previousConfig.auth,
          baseUrl: previousConfig.baseUrl,
          credentials: previousConfig.credentials,
          fetch: previousConfig.fetch,
        })
        markClientSharedAuthority(client, previousSharedAuthority)
      }
    },
  }

  activeBrowserController = controller
  return controller
}

function installVisibleSessionActivity(): () => void {
  const browserDocument = typeof document === "undefined" ? null : document
  let lastActivityAt = browserDocument?.visibilityState === "visible" ? Date.now() : null
  const recordVisibleActivity = () => {
    if (browserDocument?.visibilityState === "visible") lastActivityAt = Date.now()
  }

  if (browserDocument) {
    for (const type of SESSION_ACTIVITY_EVENT_TYPES) {
      browserDocument.addEventListener(
        type,
        recordVisibleActivity,
        SESSION_ACTIVITY_LISTENER_OPTIONS
      )
    }
    browserDocument.addEventListener("visibilitychange", recordVisibleActivity)
  }

  const interceptorId = client.interceptors.request.use((request) => {
    const activityAge =
      lastActivityAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastActivityAt
    const hasRecentVisibleActivity =
      browserDocument?.visibilityState === "visible" &&
      activityAge >= 0 &&
      activityAge < SESSION_ACTIVITY_WINDOW_MS

    if (hasRecentVisibleActivity) {
      request.headers.set(SESSION_ACTIVITY_HEADER_NAME, SESSION_ACTIVITY_HEADER_VALUE)
    } else {
      request.headers.delete(SESSION_ACTIVITY_HEADER_NAME)
    }
    return request
  })

  return () => {
    lastActivityAt = null
    client.interceptors.request.eject(interceptorId)
    if (!browserDocument) return
    for (const type of SESSION_ACTIVITY_EVENT_TYPES) {
      browserDocument.removeEventListener(
        type,
        recordVisibleActivity,
        SESSION_ACTIVITY_LISTENER_OPTIONS
      )
    }
    browserDocument.removeEventListener("visibilitychange", recordVisibleActivity)
  }
}

async function exchangeSharedSession(
  grantId: string,
  secret: string
): Promise<SixbSharedAccessSession> {
  const { data } = await exchangeSharedAccess({
    path: { grantId },
    body: { secret },
    throwOnError: true,
  })
  return data
}

async function getSharedSession(grantId: string): Promise<SixbSharedAccessSession> {
  const { data } = await getSharedAccessSession({
    path: { grantId },
    throwOnError: true,
  })
  return data
}

async function signOutSharedSession(grantId: string): Promise<SignOutSharedAccessResponse> {
  const { data } = await signOutSharedAccess({
    path: { grantId },
    throwOnError: true,
  })
  return data
}

function assertSharedSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("[SixbClient] Shared access secret is invalid.")
  }
}

function assertSharedAccessSession(
  session: unknown,
  expectedGrantId: string
): asserts session is SixbSharedAccessSession {
  if (
    !isRecord(session) ||
    session.grantId !== expectedGrantId ||
    !isSameOriginDestinationPath(session.destinationPath) ||
    typeof session.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    typeof session.absoluteExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(session.absoluteExpiresAt)) ||
    typeof session.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(session.csrfToken)
  ) {
    throw new Error("[SixbClient] Shared access session response is invalid.")
  }
}

function isSameOriginDestinationPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false
  }

  if (new URL(value, "https://sixb.invalid").pathname !== value) return false

  let decoded: string
  try {
    decoded = decodeURIComponent(value).replaceAll("\\", "/")
  } catch {
    return false
  }
  return decoded !== "/shared" && !decoded.startsWith("/shared/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAuthRedirectExcludedRequest(
  config: SixbBrowserRuntimeConfig,
  request: Request
): boolean {
  const requestUrl = new URL(request.url)
  const apiUrl = new URL(normalizeSixbApiBaseUrl(config.api.baseUrl), requestUrl)
  const apiPath = apiUrl.pathname.replace(/\/+$/, "")
  const method = request.method.toUpperCase()
  return (
    requestUrl.origin === apiUrl.origin &&
    ((method === "GET" && requestUrl.pathname === `${apiPath}/api/auth/session`) ||
      (method === "POST" && requestUrl.pathname === `${apiPath}/api/auth/sign-out`))
  )
}

function isSixbAuthPage(config: SixbBrowserRuntimeConfig, currentUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const api = new URL(normalizeSixbApiBaseUrl(config.api.baseUrl), current)
    return (
      current.origin === api.origin &&
      (current.pathname === "/auth" || current.pathname.startsWith("/auth/"))
    )
  } catch {
    return false
  }
}

export async function requireSixbBrowserAuthSession(
  config: SixbBrowserRuntimeConfig,
  controller: SixbBrowserClientController,
  options: {
    readonly returnTo?: string
    readonly redirect?: (url: string) => void
  } = {}
): Promise<GetAuthSessionResponse> {
  const { data } = await getAuthSession({ throwOnError: true })

  if (data.authenticated) {
    controller.setCsrfToken(data.csrfToken)
    return data
  }

  controller.setCsrfToken(null)
  const returnTo = options.returnTo ?? window.location.href
  const redirect = options.redirect ?? ((url: string) => window.location.assign(url))
  redirect(createSixbSignInUrl(config, returnTo))
  return data
}

export function createSixbSignInUrl(config: SixbBrowserRuntimeConfig, returnTo: string): string {
  const url = new URL("/auth/sign-in", normalizeSixbApiBaseUrl(config.api.baseUrl))
  url.searchParams.set("audience", config.auth.audience)
  url.searchParams.set("returnTo", returnTo)
  return url.toString()
}
