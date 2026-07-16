import type { PennylaneConnectorOptions } from "../src"
import { pennylane } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "pennylane",
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

export async function createTestClient(options: Partial<PennylaneConnectorOptions> = {}) {
  return pennylane({
    accessToken: "pl-token",
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
