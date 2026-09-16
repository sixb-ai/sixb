import type {
  QuickBooksListOptions,
  QuickBooksPage,
  QuickBooksPaginationOptions,
  QuickBooksTransactionListOptions,
} from "./types/query"
import { isRecord, nonEmpty } from "./validation"

export interface QuickBooksReadHttp {
  get(path: string): Promise<unknown>
}

export function pathId(id: string): string {
  nonEmpty(id, "entity ID")
  if (id === "." || id === "..") throw new Error("[SixbQuickBooks] Invalid entity ID.")
  return encodeURIComponent(id)
}

export async function readEntity<T>(
  http: QuickBooksReadHttp,
  entity: string,
  path: string,
  id?: string
): Promise<T> {
  const body = await http.get(path)
  const value = isRecord(body) ? body[entity] : undefined
  assertEntity(value, entity)
  if (id !== undefined && value.Id !== id)
    throw new Error(`[SixbQuickBooks] ${entity} response ID does not match the request.`)
  return value as T
}

function assertEntity(
  value: unknown,
  entity: string
): asserts value is Record<string, unknown> & { Id: string } {
  if (!isRecord(value) || typeof value.Id !== "string" || !value.Id.trim())
    throw new Error(`[SixbQuickBooks] Invalid ${entity} response.`)
}

function integer(value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`[SixbQuickBooks] ${name} must be an integer from ${min} to ${max}.`)
}

function quoted(value: string): string {
  nonEmpty(value, "query value")
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export async function listEntities<T, TName extends string>(
  http: QuickBooksReadHttp,
  entity: string,
  nameField: TName,
  options: QuickBooksListOptions<TName> = {}
): Promise<QuickBooksPage<T>> {
  const start = options.startPosition ?? 1
  const count = options.maxResults ?? 100
  integer(start, "startPosition", 1)
  integer(count, "maxResults", 1, 1000)
  const active = options.active ?? true
  if (active !== true && active !== false && active !== "all")
    throw new Error("[SixbQuickBooks] active must be true, false, or all.")
  const clauses = [active === "all" ? "Active IN (true, false)" : `Active = ${active}`]
  if (options.ids !== undefined) {
    if (!Array.isArray(options.ids) || options.ids.length === 0)
      throw new Error("[SixbQuickBooks] ids must be a non-empty array.")
    clauses.push(`Id IN (${options.ids.map(quoted).join(", ")})`)
  }
  if (options.name !== undefined) clauses.push(`${nameField} = ${quoted(options.name)}`)
  const field = options.orderBy?.field ?? "Id"
  const direction = options.orderBy?.direction ?? "ASC"
  if ((field !== "Id" && field !== nameField) || (direction !== "ASC" && direction !== "DESC"))
    throw new Error("[SixbQuickBooks] Unsupported query sort.")
  const query = `SELECT * FROM ${entity} WHERE ${clauses.join(" AND ")} ORDERBY ${field} ${direction} STARTPOSITION ${start} MAXRESULTS ${count}`
  return readQueryPage(http, entity, query, start, count)
}

export async function listTransactions<T>(
  http: QuickBooksReadHttp,
  entity: string,
  options: QuickBooksTransactionListOptions = {}
): Promise<QuickBooksPage<T>> {
  for (const key of Object.keys(options)) {
    if (
      !["ids", "txnDateFrom", "txnDateTo", "orderBy", "startPosition", "maxResults"].includes(key)
    )
      throw new Error(`[SixbQuickBooks] Unsupported transaction list option: ${key}.`)
  }
  const start = options.startPosition ?? 1
  const count = options.maxResults ?? 100
  integer(start, "startPosition", 1)
  integer(count, "maxResults", 1, 1000)
  const clauses: string[] = []
  if (options.ids !== undefined) {
    if (!Array.isArray(options.ids) || options.ids.length === 0)
      throw new Error("[SixbQuickBooks] ids must be a non-empty array.")
    clauses.push(`Id IN (${options.ids.map(quoted).join(", ")})`)
  }
  if (options.txnDateFrom !== undefined)
    clauses.push(`TxnDate >= ${dateLiteral(options.txnDateFrom)}`)
  if (options.txnDateTo !== undefined) clauses.push(`TxnDate <= ${dateLiteral(options.txnDateTo)}`)
  if (
    options.txnDateFrom !== undefined &&
    options.txnDateTo !== undefined &&
    options.txnDateFrom > options.txnDateTo
  )
    throw new Error("[SixbQuickBooks] txnDateFrom must not follow txnDateTo.")
  const field = options.orderBy?.field ?? "Id"
  const direction = options.orderBy?.direction ?? "ASC"
  if ((field !== "Id" && field !== "TxnDate") || (direction !== "ASC" && direction !== "DESC"))
    throw new Error("[SixbQuickBooks] Unsupported transaction sort.")
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""
  return readQueryPage(
    http,
    entity,
    `SELECT * FROM ${entity}${where} ORDERBY ${field} ${direction} STARTPOSITION ${start} MAXRESULTS ${count}`,
    start,
    count
  )
}

function dateLiteral(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error("[SixbQuickBooks] Transaction dates must be valid YYYY-MM-DD calendar dates.")
  return quoted(value)
}

async function readQueryPage<T>(
  http: QuickBooksReadHttp,
  entity: string,
  query: string,
  start: number,
  count: number
): Promise<QuickBooksPage<T>> {
  const body = await http.get(`query?${new URLSearchParams({ query })}`)
  if (!isRecord(body) || !isRecord(body.QueryResponse))
    throw new Error("[SixbQuickBooks] Invalid QueryResponse envelope.")
  const response = body.QueryResponse
  const items: unknown = response[entity] === undefined ? [] : response[entity]
  if (!Array.isArray(items) || items.length > count)
    throw new Error(`[SixbQuickBooks] Invalid ${entity} query results.`)
  for (const item of items) assertEntity(item, entity)
  if (response[entity] === undefined && Object.values(response).some(Array.isArray))
    throw new Error("[SixbQuickBooks] Query returned an unexpected entity.")
  for (const key of ["startPosition", "maxResults", "totalCount"] as const) {
    const value = response[key]
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < (key === "startPosition" ? 1 : 0))
    )
      throw new Error(`[SixbQuickBooks] Invalid query ${key}.`)
  }
  if (response.startPosition !== undefined && response.startPosition !== start)
    throw new Error("[SixbQuickBooks] Query returned an unexpected startPosition.")
  // A missing array is valid only for empty results, never for a nonempty advertised page.
  if (items.length === 0 && typeof response.maxResults === "number" && response.maxResults > 0)
    throw new Error("[SixbQuickBooks] Query omitted its entity results.")
  return {
    items: items as T[],
    startPosition: response.startPosition as number | undefined,
    maxResults: response.maxResults as number | undefined,
    totalCount: response.totalCount as number | undefined,
    time: typeof body.time === "string" ? body.time : undefined,
  }
}

export async function* listAll<T, TOptions extends QuickBooksPaginationOptions>(
  list: (options: TOptions) => Promise<QuickBooksPage<T>>,
  options?: TOptions
): AsyncIterable<T> {
  let startPosition = options?.startPosition ?? 1
  const maxResults = options?.maxResults ?? 100
  let previousPage: string | undefined
  for (;;) {
    const page = await list({ ...options, startPosition, maxResults } as TOptions)
    const signature = JSON.stringify(page.items)
    if (page.items.length > 0 && signature === previousPage)
      throw new Error("[SixbQuickBooks] Query pagination repeated a page.")
    previousPage = signature
    for (const item of page.items) yield item
    if (page.items.length < maxResults) return
    startPosition += page.items.length
  }
}
