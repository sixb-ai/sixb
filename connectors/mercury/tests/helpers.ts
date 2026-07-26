import type { MercuryConnectorOptions } from "../src"
import { mercury } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "mercury",
  signal: new AbortController().signal,
}

export const TOKEN = "secret-token:mercury_production_test"

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

export async function createTestClient(options: Partial<MercuryConnectorOptions> = {}) {
  return mercury({ accessToken: TOKEN, ...options }).connect(CONTEXT)
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }
  return collected
}

/** Records the URL and init of every request so assertions can inspect the wire calls. */
export function recorder(responses: readonly Response[] | ((url: string) => Response)) {
  const calls: { url: string; method: string; body?: string }[] = []
  let index = 0

  mockFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
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

export function query(url: string): URLSearchParams {
  return new URL(url).searchParams
}
