import type { ConnectorContext } from "@sixb/core"
import { type MicrosoftConnectorOptions, microsoft } from "../src"

export const CONTEXT: ConnectorContext = {
  projectId: "test",
  connectorId: "microsoft",
  signal: new AbortController().signal,
}
export const TENANT = "11111111-2222-3333-4444-555555555555"
export const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
export const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`
export const GRAPH = "https://graph.microsoft.com/v1.0/"

const originalFetch = globalThis.fetch
export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly init: RequestInit
}

export function mockFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>
): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  const replacement: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        init: init ?? {},
      }
      requests.push(request)
      return handler(request)
    },
    { preconnect: originalFetch.preconnect }
  )
  globalThis.fetch = replacement
  return requests
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch
}
export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  })
}
export function apiError(status: number, code = "accessDenied", headers?: HeadersInit): Response {
  return json(
    { error: { code, message: "Provider detail", innerError: { "request-id": "request-1" } } },
    status,
    headers
  )
}
export function connect(options: Partial<MicrosoftConnectorOptions> = {}, context = CONTEXT) {
  return microsoft({
    auth: { token: () => "graph-token" },
    retry: { maxRetries: 0 },
    ...options,
  }).connect(context)
}
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

/** Real MSAL performs discovery, builds credentials, exchanges and caches tokens in these tests. */
export function discovery(url: string): Response | undefined {
  if (url.includes("/discovery/instance"))
    return json({
      tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
      metadata: [
        {
          preferred_network: "login.microsoftonline.com",
          preferred_cache: "login.windows.net",
          aliases: ["login.microsoftonline.com", "login.windows.net", "sts.windows.net"],
        },
      ],
    })
  if (url.includes(".well-known/openid-configuration"))
    return json({
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: TOKEN_URL,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
    })
  return undefined
}

export function tokenResponse(accessToken = "msal-token", expiresIn = 3600): Response {
  return json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: expiresIn,
    ext_expires_in: expiresIn,
  })
}
