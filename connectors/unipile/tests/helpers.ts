import type { UnipileConnectorOptions } from "../src"
import { unipile } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "unipile",
  signal: new AbortController().signal,
}

export const DSN = "https://api123.unipile.com:13337"
export const TOKEN = "unipile_test_token"

export const originalFetch = globalThis.fetch

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

export async function createTestClient(options: Partial<UnipileConnectorOptions> = {}) {
  return unipile({ dsn: DSN, accessToken: TOKEN, ...options }).connect(CONTEXT)
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }
  return collected
}

export interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: BodyInit | null | undefined
}

export function recorder(responses: readonly Response[] | ((call: RecordedCall) => Response)) {
  const calls: RecordedCall[] = []
  let index = 0

  mockFetch(async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    }
    calls.push(call)

    if (typeof responses === "function") {
      return responses(call)
    }

    const response = responses[index++]
    if (!response) {
      throw new Error(`Unexpected request: ${call.method} ${call.url}`)
    }
    return response
  })

  return calls
}

export function query(url: string): URLSearchParams {
  return new URL(url).searchParams
}

export function jsonBody(call: RecordedCall): Record<string, unknown> {
  if (typeof call.body !== "string") {
    throw new Error("Expected a JSON string body")
  }
  return JSON.parse(call.body) as Record<string, unknown>
}
