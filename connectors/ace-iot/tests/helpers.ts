import type { AceIotConnectorOptions } from "../src"
import { aceIot } from "../src"

export const CONTEXT = {
  projectId: "demo",
  connectorId: "ace-iot",
  signal: new AbortController().signal,
}

export const API_KEY = "ace-test-key"

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}

/** Records every request URL and returns the same body, for asserting query serialization. */
export function captureFetch(
  body: unknown,
  init?: ResponseInit
): { urls: URL[]; inits: RequestInit[] } {
  const urls: URL[] = []
  const inits: RequestInit[] = []
  mockFetch((input, requestInit) => {
    urls.push(new URL(String(input)))
    inits.push(requestInit ?? {})
    return Promise.resolve(json(body, init))
  })

  return { urls, inits }
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

export async function createTestClient(options: Partial<AceIotConnectorOptions> = {}) {
  return aceIot({ apiKey: API_KEY, ...options }).connect(CONTEXT)
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) {
    collected.push(item)
  }
  return collected
}

/** ACE's page envelope, so tests do not restate it on every list fixture. */
export function page<T>(items: readonly T[], overrides: Partial<Record<string, unknown>> = {}) {
  return {
    items,
    page: 1,
    pages: 1,
    per_page: 1000,
    total: items.length,
    ...overrides,
  }
}

export interface FakeSample {
  readonly name: string
  readonly value: string
  readonly time: string
}

/** Build samples laid out in 5-minute buckets, as ACE returns them: `[[timestamp, count], …]`. */
export function buildSamples(buckets: readonly (readonly [string, number])[]): FakeSample[] {
  const samples: FakeSample[] = []
  for (const [time, count] of buckets) {
    for (let index = 0; index < count; index++) {
      samples.push({ name: `point/${index}`, value: String(index), time })
    }
  }

  return samples
}

/**
 * ACE's paginated timeseries endpoint, reproduced including the cursor defect.
 *
 * The server honors an incoming `{offset, timestamp}` correctly, but computes the outgoing offset
 * as the number of rows it drew from the page's final bucket, without adding the offset it was
 * given. Verified against the live API on 2026-08-07: at `page_size=50` over a 3,222-sample window
 * the second page returns the same cursor it was handed, and the walk stops advancing.
 */
export function aceTimeseriesServer(samples: readonly FakeSample[]) {
  return (url: URL) => {
    const pageSize = Number(url.searchParams.get("page_size") ?? 10_000)
    const cursor = url.searchParams.get("cursor")

    let start = 0
    if (cursor) {
      const { offset, timestamp } = JSON.parse(atob(cursor)) as {
        offset: number
        timestamp: string
      }
      const bucketStart = samples.findIndex((sample) => sample.time === timestamp)
      start = (bucketStart < 0 ? 0 : bucketStart) + offset
    }

    const pageSamples = samples.slice(start, start + pageSize)
    const hasMore = start + pageSamples.length < samples.length

    let nextCursor: string | null = null
    if (hasMore && pageSamples.length > 0) {
      const lastTimestamp = pageSamples[pageSamples.length - 1].time
      let rowsFromLastBucket = 0
      for (
        let index = pageSamples.length - 1;
        index >= 0 && pageSamples[index].time === lastTimestamp;
        index--
      ) {
        rowsFromLastBucket += 1
      }
      nextCursor = btoa(JSON.stringify({ offset: rowsFromLastBucket, timestamp: lastTimestamp }))
    }

    return { point_samples: pageSamples, next_cursor: nextCursor, has_more: hasMore }
  }
}

export const sampleKey = (sample: FakeSample) => `${sample.name}@${sample.time}`
