import type { RestClient } from "@sixb/connector-rest"
import { connectorCodeForStatus, SixbProviderError } from "@sixb/core/errors"
import type { InsightsQuery, MetaInsight, MetaPage } from "./types/common"

export interface MetaHttpContext {
  readonly http: RestClient
}

/** Raised when the Graph API returns a non-2xx response. The raw error body is preserved. */
export class MetaApiError extends SixbProviderError {
  override readonly name = "MetaApiError"

  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(
      connectorCodeForStatus(status),
      `[SixbMeta] Graph API request failed with ${status}: ${body || "(empty body)"}`,
      { details: { status } }
    )
  }
}

/** The standard Graph API list envelope with cursor pagination. */
interface MetaListResponse<T> {
  readonly data?: readonly T[]
  readonly paging?: {
    readonly cursors?: { readonly before?: string; readonly after?: string }
    readonly next?: string
    readonly previous?: string
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new MetaApiError(response.status, await response.text().catch(() => ""))
  }
  return (await response.json()) as T
}

/** Read a Graph list envelope into a `MetaPage`, mapping each raw item to a domain type. */
export async function readPage<TRaw, TItem>(
  response: Response,
  map: (raw: TRaw) => TItem
): Promise<MetaPage<TItem>> {
  const body = await readJson<MetaListResponse<TRaw>>(response)
  const items = (body.data ?? []).map(map)
  const hasMore = body.paging?.next !== undefined
  return { items, hasMore, nextCursor: hasMore ? body.paging?.cursors?.after : undefined }
}

/** Read a single Graph node, mapping the raw object to a domain type. */
export async function readObject<TRaw, TItem>(
  response: Response,
  map: (raw: TRaw) => TItem
): Promise<TItem> {
  return map(await readJson<TRaw>(response))
}

/** Read a Graph list envelope of insights, returned in API order. */
export async function readInsights(response: Response): Promise<readonly MetaInsight[]> {
  const body = await readJson<MetaListResponse<RawInsight>>(response)
  return (body.data ?? []).map(toInsight)
}

/**
 * Drive an edge to exhaustion by following its `after` cursor.
 *
 * Re-requests against the relative path with `after=<cursor>` rather than blindly
 * following the absolute `paging.next` URL, keeping every request on the configured base.
 */
export async function* paginate<TItem>(
  fetchPage: (after: string | undefined) => Promise<MetaPage<TItem>>
): AsyncIterable<TItem> {
  let after: string | undefined
  for (;;) {
    const page = await fetchPage(after)
    for (const item of page.items) {
      yield item
    }
    if (!page.hasMore || !page.nextCursor) {
      break
    }
    after = page.nextCursor
  }
}

/** Build a relative path with a query string, skipping `undefined` values. */
export function withQuery(
  path: string,
  params: Record<string, string | number | undefined>
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value))
    }
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

/** Build an `/insights` request path from a metric-agnostic query. */
export function insightsPath(path: string, query: InsightsQuery): string {
  return withQuery(path, {
    metric: query.metrics.join(","),
    period: query.period,
    metric_type: query.metricType,
    since: query.since ? toUnixSeconds(query.since) : undefined,
    until: query.until ? toUnixSeconds(query.until) : undefined,
    breakdown: query.breakdown?.length ? query.breakdown.join(",") : undefined,
  })
}

/** Bearer-token header override for a single request, or `undefined` to use the default token. */
export function authInit(accessToken: string | undefined): RequestInit | undefined {
  return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined
}

export function toUnixSeconds(date: Date): number {
  return Math.trunc(date.getTime() / 1000)
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbMeta] ${field} must not be empty.`)
  }
}

/** Validate and encode a Graph node id for use as a path segment. */
export function nodePath(value: string, field: string): string {
  assertNonEmpty(value, field)
  return encodeURIComponent(value)
}

interface RawInsight {
  readonly name: string
  readonly period?: string
  readonly title?: string
  readonly description?: string
  readonly values?: readonly { readonly value?: unknown; readonly end_time?: string }[]
  readonly total_value?: unknown
  readonly id?: string
}

function toInsight(raw: RawInsight): MetaInsight {
  return {
    name: raw.name,
    period: raw.period,
    title: raw.title,
    description: raw.description,
    values: raw.values,
    total_value: raw.total_value,
    id: raw.id,
  }
}
