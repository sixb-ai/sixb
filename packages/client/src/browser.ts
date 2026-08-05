import type { AuthSessionAudience } from "@sixb/core"
import {
  configureSixbClient as configureGeneratedSixbClient,
  normalizeSixbApiBaseUrl,
  SIXB_CSRF_TOKEN_RESPONSE_HEADER_NAME,
} from "./api"
import { client } from "./generated/client.gen"

export type { SixbApiErrorCode, SixbApiErrorInit } from "./api"
export { isSixbApiError, SixbApiError } from "./api"

import { getAuthSession } from "./generated/sdk.gen"
import type { GetAuthSessionResponse } from "./generated/types.gen"

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
  const browserDocument = typeof document === "undefined" ? null : document
  let lastActivityAt = browserDocument?.visibilityState === "visible" ? Date.now() : null

  const recordVisibleActivity = () => {
    if (browserDocument?.visibilityState === "visible") {
      lastActivityAt = Date.now()
    }
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

  configureGeneratedSixbClient(client, {
    baseUrl: config.api.baseUrl,
    auth: {
      kind: "cookie",
      csrfToken: () => csrfToken,
    },
  })
  const activityInterceptorId = client.interceptors.request.use((request) => {
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
      lastActivityAt = null
      client.interceptors.request.eject(activityInterceptorId)
      client.interceptors.response.eject(authResponseInterceptorId)
      if (browserDocument) {
        for (const type of SESSION_ACTIVITY_EVENT_TYPES) {
          browserDocument.removeEventListener(
            type,
            recordVisibleActivity,
            SESSION_ACTIVITY_LISTENER_OPTIONS
          )
        }
        browserDocument.removeEventListener("visibilitychange", recordVisibleActivity)
      }
      if (activeBrowserController === controller) {
        activeBrowserController = null
        client.setConfig({ auth: undefined, credentials: undefined })
      }
    },
  }

  activeBrowserController = controller
  return controller
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
