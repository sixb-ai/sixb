import type { CtmConnectorOptions } from "../src"
import { ctm } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "ctm",
  signal: new AbortController().signal,
}

export const ACCOUNT_ID = 12345

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

/** A page-numbered list response, as CTM's routes other than calls answer. */
export function page(
  key: string,
  records: readonly unknown[],
  overrides: Record<string, unknown> = {}
): Response {
  return json({
    page: 1,
    per_page: 10,
    total_entries: records.length,
    total_pages: 1,
    next_page: null,
    previous_page: null,
    [key]: records,
    ...overrides,
  })
}

/** A page of the call log, which pages with an `after` cursor. */
export function callPage(records: readonly unknown[], after: string | null = null): Response {
  return json({
    calls: records,
    sort: [{ unix_time: { order: "desc", missing: "_last" } }],
    total_entries: records.length,
    total_pages: 1,
    per_page: 10,
    stats: {},
    after,
    next_page: after
      ? `https://api.calltrackingmetrics.com/api/v1/accounts/1/calls?after=${after}`
      : null,
  })
}

/** Unpaced, so tests do not wait out the 100 ms the connector keeps between requests. */
export async function createTestClient(options: Partial<CtmConnectorOptions> = {}) {
  return ctm({
    accessKey: "key",
    secretKey: "secret",
    accountId: ACCOUNT_ID,
    minDelayMs: 0,
    ...options,
  }).connect(CONTEXT)
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

/** `METHOD /path?query` with brackets readable, for route assertions. */
export function route(call: RecordedCall): string {
  return `${call.method} ${call.url.pathname}${decodeURIComponent(call.url.search)}`
}

/** A call record as CTM's docs show it, trimmed to the fields the tests read. */
export function callRecord(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sid: `CA${id}`,
    account_id: ACCOUNT_ID,
    direction: "inbound",
    called_at: "2026-11-12 09:30 AM -05:00",
    unix_time: 1_794_501_000 + id,
    duration: 45,
    talk_time: 38,
    source: "Google Ads",
    tracking_number: "+13330004444",
    caller_number: "+12512862740",
    audio: `https://api.calltrackingmetrics.com/api/v1/accounts/${ACCOUNT_ID}/calls/CA${id}/recording`,
    ...overrides,
  }
}
