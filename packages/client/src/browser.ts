import { configureSixbClient as configureGeneratedSixbClient, normalizeSixbApiBaseUrl } from "./api"
import { client } from "./generated/client.gen"

export type { SixbApiErrorInit } from "./api"
export { isSixbApiError, SixbApiError } from "./api"

import { getAuthSession } from "./generated/sdk.gen"
import type { GetAuthSessionResponse } from "./generated/types.gen"

export interface SixbBrowserRuntimeConfig {
  readonly api: {
    readonly baseUrl: string
  }
  readonly auth: {
    readonly audience: string
    readonly enabled: boolean
  }
}

export interface SixbBrowserRuntimeDefaults {
  readonly apiBaseUrl?: string
  readonly audience: string
  readonly authEnabled?: boolean
}

export interface SixbBrowserClientController {
  setCsrfToken(token: string | null): void
  getCsrfToken(): string | null
  dispose(): void
}

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
  config: SixbBrowserRuntimeConfig
): SixbBrowserClientController {
  let csrfToken: string | null = null

  configureGeneratedSixbClient(client, {
    baseUrl: config.api.baseUrl,
    auth: {
      kind: "cookie",
      csrfToken: () => csrfToken,
    },
  })

  return {
    setCsrfToken(token) {
      csrfToken = token
    },
    getCsrfToken() {
      return csrfToken
    },
    dispose() {
      csrfToken = null
      client.setConfig({ auth: undefined, credentials: undefined })
    },
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
