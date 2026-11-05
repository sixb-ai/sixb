import type { FleetioConnectorOptions } from "../src"
import { fleetio } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "fleetio",
  signal: new AbortController().signal,
}

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

/** A one-page list response, with `overrides` for the cursor fields a test cares about. */
export function page(records: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return json({
    start_cursor: null,
    next_cursor: null,
    per_page: 50,
    estimated_remaining_count: records.length,
    filtered_by: [],
    sorted_by: [],
    records,
    ...overrides,
  })
}

export async function createTestClient(options: Partial<FleetioConnectorOptions> = {}) {
  return fleetio({ apiKey: "key", accountToken: "account", ...options }).connect(CONTEXT)
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }
  return collected
}

export interface RecordedCall {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
}

/** Answers with `responses` in order and records each request. Extra requests are an error. */
export function recorder(responses: readonly Response[] | ((url: URL) => Response)) {
  const calls: RecordedCall[] = []
  let index = 0

  mockFetch(async (input, init) => {
    const url = new URL(String(input))
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    })

    if (typeof responses === "function") {
      return responses(url)
    }

    const response = responses[index++]
    if (!response) {
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`)
    }
    return response
  })

  return calls
}

/** `pathname?search` with the brackets of nested parameters readable, for route assertions. */
export function route(call: RecordedCall): string {
  return `${call.method} ${call.url.pathname}${decodeURIComponent(call.url.search)}`
}
