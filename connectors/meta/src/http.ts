import {
  parseRetryAfter,
  type RestClient,
  type RestRequestInit,
  type RestRequestOptions,
  readResponseBody,
} from "@sixb/connector-rest"
import type {
  InsightsQuery,
  MetaAppUsage,
  MetaBusinessUseCaseUsage,
  MetaBusinessUseCaseUsageEntry,
  MetaGraphError,
  MetaHeader,
  MetaInsight,
  MetaPage,
  MetaResponseMetadata,
  MetaRetryContext,
  MetaRetryPolicy,
  MetaUsage,
} from "./types/common"

const THROTTLING_ERROR_CODES = new Set([4, 17, 32, 613])

export interface MetaHttpContext {
  readonly http: RestClient
  readonly retry: MetaRetryController
  readonly observe: MetaResponseObserver
  readonly signal: AbortSignal
}

/** Raised when the Graph API returns a non-2xx response. The raw error body is preserved. */
export class MetaApiError extends Error {
  readonly name = "MetaApiError"
  readonly headers: readonly MetaHeader[]
  readonly usage: MetaUsage
  readonly graphError?: MetaGraphError
  readonly rawBody: string

  constructor(
    readonly status: number,
    readonly body: unknown,
    headers: HeadersInit = {},
    rawBody?: string
  ) {
    const graphError = parseMetaGraphError(body)
    super(formatMetaApiError(status, body, graphError))
    const responseHeaders = new Headers(headers)
    this.headers = toMetaHeaders(responseHeaders)
    this.usage = parseMetaUsage(responseHeaders)
    this.graphError = graphError
    this.rawBody = rawBody ?? serializeBody(body)
  }
}

export interface MetaRetryController {
  readonly maxRetries: number
  shouldRetry(context: MetaRetryContext): Promise<boolean>
  delayMs(context: MetaRetryContext): Promise<number>
}

export interface MetaResponseObserver {
  observeHttp(response: Response, path: string, method: "GET" | "POST"): Promise<void>
  observeBatch(
    path: string,
    status: number,
    headers: readonly MetaHeader[],
    batchIndex: number
  ): Promise<void>
}

export function createMetaRetryController(
  policy: MetaRetryPolicy | undefined,
  legacyMaxRetries: number | undefined
): MetaRetryController {
  const maxRetries = policy?.maxRetries ?? legacyMaxRetries ?? 2
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbMeta] retry.maxRetries must be a non-negative integer.")
  }

  return {
    maxRetries,
    async shouldRetry(context) {
      if (policy?.shouldRetry) return policy.shouldRetry(context)
      if (isAbortError(context.error)) return false
      if (context.error) return true
      if (context.graphError?.code && THROTTLING_ERROR_CODES.has(context.graphError.code)) {
        return true
      }
      const status = context.response?.status
      return status === 429 || (status !== undefined && status >= 500)
    },
    async delayMs(context) {
      if (policy?.delayMs) return policy.delayMs(context)
      return (
        parseRetryAfter(context.response?.headers.get("retry-after") ?? null) ??
        Math.min(1000 * 2 ** context.attempt, 30_000)
      )
    },
  }
}

export async function createMetaRetryContext(
  response: Response | null,
  error: unknown,
  attempt: number,
  request: {
    readonly path: string
    readonly method: "GET" | "POST"
    readonly batchIndex?: number
  }
): Promise<MetaRetryContext> {
  const body = response && !response.ok ? await readResponseBody(response.clone()) : undefined
  return {
    attempt,
    path: request.path,
    method: request.method,
    response,
    error,
    graphError: parseMetaGraphError(body),
    usage: response ? parseMetaUsage(response.headers) : {},
    batchIndex: request.batchIndex,
  }
}

export function createMetaResponseObserver(
  handler: ((metadata: MetaResponseMetadata) => Promise<void> | void) | undefined
): MetaResponseObserver {
  const observed = new WeakSet<Response>()

  return {
    async observeHttp(response, path, method) {
      if (!handler || observed.has(response)) return
      observed.add(response)
      const headers = toMetaHeaders(response.headers)
      await handler({
        path,
        method,
        status: response.status,
        headers,
        usage: parseMetaUsage(response.headers),
      })
    },
    async observeBatch(path, status, headers, batchIndex) {
      if (!handler) return
      await handler({
        path,
        method: "GET",
        status,
        headers,
        usage: parseMetaUsage(headers),
        batchIndex,
      })
    },
  }
}

export function observeMetaResponses(http: RestClient, observer: MetaResponseObserver): RestClient {
  async function observed(
    response: Promise<Response>,
    path: string,
    method: "GET" | "POST"
  ): Promise<Response> {
    const resolved = await response
    await observer.observeHttp(resolved, path, method)
    return resolved
  }

  return {
    request(path: string, init?: RestRequestInit, options?: RestRequestOptions) {
      const method = init?.method?.toUpperCase() === "POST" ? "POST" : "GET"
      return observed(http.request(path, init, options), path, method)
    },
    get(path: string, init?: RestRequestInit, options?: RestRequestOptions) {
      return observed(http.get(path, init, options), path, "GET")
    },
    post(path: string, body?: unknown, init?: RestRequestInit, options?: RestRequestOptions) {
      return observed(http.post(path, body, init, options), path, "POST")
    },
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
  const rawBody = response.status === 204 ? "" : await response.text()
  const body = parseMetaBody(rawBody)
  if (!response.ok) {
    throw new MetaApiError(response.status, body, response.headers, rawBody)
  }
  return body as T
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

export function parseMetaBody(body: string): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function parseMetaGraphError(body: unknown): MetaGraphError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined
  }

  const error = body.error
  const message = error.message
  if (typeof message !== "string") return undefined
  return {
    message,
    type: optionalString(error.type),
    code: optionalNumber(error.code),
    error_subcode: optionalNumber(error.error_subcode),
    is_transient: optionalBoolean(error.is_transient),
    error_user_title: optionalString(error.error_user_title),
    error_user_msg: optionalString(error.error_user_msg),
    error_data: error.error_data,
    fbtrace_id: optionalString(error.fbtrace_id),
  }
}

export function toMetaHeaders(headers: Headers): readonly MetaHeader[] {
  const result: MetaHeader[] = []
  for (const [name, value] of headers) {
    result.push({ name, value })
  }
  return result
}

export function parseMetaUsage(input: Headers | readonly MetaHeader[]): MetaUsage {
  const headers =
    input instanceof Headers
      ? input
      : new Headers(input.map(({ name, value }): [string, string] => [name, value]))
  const app = parseAppUsage(headers.get("x-app-usage"))
  const businessUseCase = parseBusinessUseCaseUsage(headers.get("x-business-use-case-usage"))
  return {
    app,
    businessUseCase,
  }
}

function parseAppUsage(value: string | null): MetaAppUsage | undefined {
  const parsed = parseHeaderJson(value)
  if (!isRecord(parsed)) return undefined
  return {
    call_count: optionalNumber(parsed.call_count),
    total_cputime: optionalNumber(parsed.total_cputime),
    total_time: optionalNumber(parsed.total_time),
  }
}

function parseBusinessUseCaseUsage(value: string | null): MetaBusinessUseCaseUsage | undefined {
  const parsed = parseHeaderJson(value)
  if (!isRecord(parsed)) return undefined

  const result: Record<string, readonly MetaBusinessUseCaseUsageEntry[]> = {}
  for (const [businessId, rawEntries] of Object.entries(parsed)) {
    if (!Array.isArray(rawEntries)) continue
    result[businessId] = rawEntries.filter(isRecord).map((entry) => ({
      type: optionalString(entry.type),
      call_count: optionalNumber(entry.call_count),
      total_cputime: optionalNumber(entry.total_cputime),
      total_time: optionalNumber(entry.total_time),
      estimated_time_to_regain_access: optionalNumber(entry.estimated_time_to_regain_access),
    }))
  }
  return result
}

function parseHeaderJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function formatMetaApiError(
  status: number,
  body: unknown,
  graphError: MetaGraphError | undefined
): string {
  const detail = graphError?.message ?? formatBody(body)
  return `[SixbMeta] Graph API request failed with ${status}: ${detail}`
}

function formatBody(body: unknown): string {
  if (typeof body === "string") return body || "(empty body)"
  if (body === undefined) return "(empty body)"
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

function serializeBody(body: unknown): string {
  if (body === undefined) return ""
  if (typeof body === "string") return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
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
