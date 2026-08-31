import type { StripeConnectorOptions } from "../src"
import { stripe } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "stripe",
  signal: new AbortController().signal,
}

export const API_KEY = "sk_test_sixb"

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body?: string
}

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      "request-id": "req_test",
      "stripe-version": "2026-03-25.dahlia",
      ...(init?.headers ?? {}),
    },
  })
}

export function recorder(
  responses: readonly Response[] | ((request: RecordedRequest) => Response)
): RecordedRequest[] {
  const calls: RecordedRequest[] = []
  let index = 0

  mockFetch(async (input, init) => {
    const call: RecordedRequest = {
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

export function createTestClient(options: Partial<StripeConnectorOptions> = {}) {
  return stripe({
    apiKey: API_KEY,
    maxNetworkRetries: 0,
    telemetry: false,
    ...options,
  }).connect(CONTEXT)
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) collected.push(item)
  return collected
}
