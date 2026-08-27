import type { ConnectorTokenSource } from "@sixb/core"
import type { LinkedinConnectorOptions } from "../src"
import { linkedin } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "linkedin",
  signal: new AbortController().signal,
}

export const TOKEN = "linkedin-test-token"

export const DEFAULT_OPTIONS = {
  clientId: "linkedin-client-id",
  clientSecret: "linkedin-client-secret",
  scopes: ["r_ads"],
  accountType: "ad-account",
} as const satisfies LinkedinConnectorOptions

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

export function empty(status = 204, headers?: HeadersInit): Response {
  return new Response(null, { status, headers })
}

export async function createTestClient(
  options: Partial<LinkedinConnectorOptions> = {},
  tokenSource: ConnectorTokenSource = testTokenSource(() => TOKEN)
) {
  return linkedin({ ...DEFAULT_OPTIONS, ...options }).connect({
    ...CONTEXT,
    connectionId: "connection-1",
    account: {
      id: "urn:li:sponsoredAccount:123",
      label: "Acme Ads",
      description: "LinkedIn ad account",
    },
    tokenSource,
  })
}

export function testTokenSource(
  resolve: () => string | Promise<string>,
  invalidate: () => void = () => undefined
): ConnectorTokenSource {
  return {
    async get() {
      return { accessToken: await resolve(), tokenType: "Bearer", invalidate }
    },
  }
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) collected.push(item)
  return collected
}

export interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body?: string
}

export function recorder(responses: readonly Response[] | ((call: RecordedCall) => Response)) {
  const calls: RecordedCall[] = []
  let index = 0

  mockFetch(async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    if (typeof responses === "function") return responses(call)

    const response = responses[index++]
    if (!response) throw new Error(`Unexpected request: ${call.method} ${call.url}`)
    return response
  })

  return calls
}
