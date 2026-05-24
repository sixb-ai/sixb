import { client } from "./generated/client.gen"
import { getAuthSession } from "./generated/sdk.gen"
import type { GetAuthSessionResponse } from "./generated/types.gen"

const CSRF_HEADER_NAME = "x-pario-csrf"
const CSRF_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export interface ParioBrowserRuntimeConfig {
  readonly api: {
    readonly baseUrl: string
  }
  readonly auth: {
    readonly audience: string
    readonly enabled: boolean
  }
}

export interface ParioBrowserRuntimeDefaults {
  readonly apiBaseUrl?: string
  readonly audience: string
  readonly authEnabled?: boolean
}

export interface ParioBrowserClientController {
  setCsrfToken(token: string | null): void
  getCsrfToken(): string | null
  dispose(): void
}

declare global {
  interface Window {
    __PARIO_RUNTIME__?: Partial<ParioBrowserRuntimeConfig>
  }
}

export function renderParioBrowserRuntimeScript(config: ParioBrowserRuntimeConfig): string {
  const safeConfig = JSON.stringify(config).replaceAll("<", "\\u003c")
  return `<script>window.__PARIO_RUNTIME__ = ${safeConfig};</script>`
}

export function readParioBrowserRuntimeConfig(
  defaults: ParioBrowserRuntimeDefaults
): ParioBrowserRuntimeConfig {
  const runtime = window.__PARIO_RUNTIME__
  const runtimeAuthEnabled = runtime?.auth?.enabled
  return {
    api: {
      baseUrl: normalizeBaseUrl(
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

export function configureParioBrowserClient(
  config: ParioBrowserRuntimeConfig
): ParioBrowserClientController {
  let csrfToken: string | null = null

  client.setConfig({
    baseUrl: normalizeBaseUrl(config.api.baseUrl),
    credentials: "include",
  })

  const interceptorId = client.interceptors.request.use((request) => {
    if (CSRF_EXEMPT_METHODS.has(request.method.toUpperCase())) {
      return request
    }

    if (!csrfToken || request.headers.has(CSRF_HEADER_NAME)) {
      return request
    }

    const headers = new Headers(request.headers)
    headers.set(CSRF_HEADER_NAME, csrfToken)
    return new Request(request, { headers })
  })

  return {
    setCsrfToken(token) {
      csrfToken = token
    },
    getCsrfToken() {
      return csrfToken
    },
    dispose() {
      client.interceptors.request.eject(interceptorId)
    },
  }
}

export async function requireParioBrowserAuthSession(
  config: ParioBrowserRuntimeConfig,
  controller: ParioBrowserClientController,
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

  const returnTo = options.returnTo ?? window.location.href
  const redirect = options.redirect ?? ((url: string) => window.location.assign(url))
  redirect(createParioSignInUrl(config, returnTo))
  return data
}

export function createParioSignInUrl(config: ParioBrowserRuntimeConfig, returnTo: string): string {
  const url = new URL("/auth/sign-in", normalizeBaseUrl(config.api.baseUrl))
  url.searchParams.set("audience", config.auth.audience)
  url.searchParams.set("returnTo", returnTo)
  return url.toString()
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  return url.origin
}
