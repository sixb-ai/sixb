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

export function assertEntity(
  value: unknown,
  entity: string
): asserts value is Record<string, unknown> & { Id: string } {
  if (!isRecord(value) || typeof value.Id !== "string" || !value.Id.trim())
    throw new Error(`[SixbQuickBooks] Invalid ${entity} response.`)
}

export function integer(value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`[SixbQuickBooks] ${name} must be an integer from ${min} to ${max}.`)
}

export function quoted(value: string): string {
  nonEmpty(value, "query value")
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

/** Name-list query. `nameField` enables `name`; `active: false` marks entities without Active. */
export async function listEntities<T>(
  http: QuickBooksReadHttp,
  entity: string,
  nameField: string | undefined,
  options: QuickBooksListOptions<string> = {},
  config: { readonly active?: boolean } = {}
): Promise<QuickBooksPage<T>> {
  const hasActive = config.active ?? true
  allowedOptions(options, "list", [
    ...PAGE_OPTIONS,
    "ids",
    "updatedSince",
    "orderBy",
    ...(hasActive ? ["active"] : []),
    ...(nameField ? ["name"] : []),
  ])
  const { start, count } = page(options)
  const clauses: string[] = []
  if (hasActive) {
    const active = options.active ?? true
    if (active !== true && active !== false && active !== "all")
      throw new Error("[SixbQuickBooks] active must be true, false, or all.")
    clauses.push(active === "all" ? "Active IN (true, false)" : `Active = ${active}`)
  }
  if (options.ids !== undefined) clauses.push(inList("Id", options.ids, "ids"))
  if (options.name !== undefined) clauses.push(`${nameField} = ${quoted(options.name)}`)
  if (options.updatedSince !== undefined) clauses.push(updatedSince(options.updatedSince))
  const orderBy = sort(options.orderBy, nameField ? ["Id", nameField] : ["Id"])
  return readQueryPage(
    http,
    entity,
    `SELECT * FROM ${entity}${where(clauses)} ORDERBY ${orderBy} STARTPOSITION ${start} MAXRESULTS ${count}`,
    start,
    count
  )
}

/** Provider-verified predicates for one transaction entity. */
export interface QuickBooksTransactionQuery {
  /** TxnDate predicates and sorting. Defaults to true. */
  readonly txnDate?: boolean
  /** DocNumber equality. Defaults to true. */
  readonly docNumber?: boolean
  /** Party reference filter: `customerIds` (CustomerRef) or `vendorIds` (VendorRef). */
  readonly party?: "customer" | "vendor"
}

export interface QuickBooksQueryExtras {
  /** Response array name when it differs from the queried entity. */
  readonly key?: string
  /** Resource-specific predicates, already validated and quoted by the caller. */
  readonly clauses?: readonly string[]
  readonly params?: Readonly<Record<string, string>>
  readonly validate?: (item: unknown) => void
}

type TransactionOptions = QuickBooksTransactionListOptions & {
  readonly customerIds?: readonly string[]
  readonly vendorIds?: readonly string[]
}

export async function listTransactions<T>(
  http: QuickBooksReadHttp,
  entity: string,
  options: TransactionOptions = {},
  query: QuickBooksTransactionQuery = {},
  extras: QuickBooksQueryExtras = {}
): Promise<QuickBooksPage<T>> {
  const txnDate = query.txnDate ?? true
  const partyOption =
    query.party === "customer" ? "customerIds" : query.party === "vendor" ? "vendorIds" : undefined
  allowedOptions(options, "transaction list", [
    ...PAGE_OPTIONS,
    "ids",
    "updatedSince",
    "orderBy",
    ...(txnDate ? ["txnDateFrom", "txnDateTo"] : []),
    ...((query.docNumber ?? true) ? ["docNumber"] : []),
    ...(partyOption ? [partyOption] : []),
  ])
  const { start, count } = page(options)
  const clauses: string[] = []
  if (options.ids !== undefined) clauses.push(inList("Id", options.ids, "ids"))
  if (options.txnDateFrom !== undefined)
    clauses.push(`TxnDate >= ${dateLiteral(options.txnDateFrom)}`)
  if (options.txnDateTo !== undefined) clauses.push(`TxnDate <= ${dateLiteral(options.txnDateTo)}`)
  if (
    options.txnDateFrom !== undefined &&
    options.txnDateTo !== undefined &&
    options.txnDateFrom > options.txnDateTo
  )
    throw new Error("[SixbQuickBooks] txnDateFrom must not follow txnDateTo.")
  if (options.docNumber !== undefined) clauses.push(`DocNumber = ${quoted(options.docNumber)}`)
  if (options.customerIds !== undefined)
    clauses.push(inList("CustomerRef", options.customerIds, "customerIds"))
  if (options.vendorIds !== undefined)
    clauses.push(inList("VendorRef", options.vendorIds, "vendorIds"))
  if (options.updatedSince !== undefined) clauses.push(updatedSince(options.updatedSince))
  clauses.push(...(extras.clauses ?? []))
  const orderBy = sort(options.orderBy, txnDate ? ["Id", "TxnDate"] : ["Id"], "transaction")
  return readQueryPage(
    http,
    entity,
    `SELECT * FROM ${entity}${where(clauses)} ORDERBY ${orderBy} STARTPOSITION ${start} MAXRESULTS ${count}`,
    start,
    count,
    { key: extras.key, params: extras.params, validate: extras.validate }
  )
}

const PAGE_OPTIONS = ["startPosition", "maxResults"]

export function allowedOptions(options: object, kind: string, allowed: readonly string[]) {
  if (typeof options !== "object" || options === null)
    throw new Error(`[SixbQuickBooks] ${kind} options must be an object.`)
  for (const key of Object.keys(options))
    if (!allowed.includes(key))
      throw new Error(`[SixbQuickBooks] Unsupported ${kind} option: ${key}.`)
}

export function page(options: { startPosition?: number; maxResults?: number }) {
  const start = options.startPosition ?? 1
  const count = options.maxResults ?? 100
  integer(start, "startPosition", 1)
  integer(count, "maxResults", 1, 1000)
  return { start, count }
}

export function inList(field: string, values: readonly string[] | undefined, name: string) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error(`[SixbQuickBooks] ${name} must be a non-empty array.`)
  return `${field} IN (${values.map(quoted).join(", ")})`
}

export function updatedSince(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("[SixbQuickBooks] updatedSince must be a valid Date.")
  return `MetaData.LastUpdatedTime >= '${value.toISOString()}'`
}

export function where(clauses: readonly string[]) {
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""
}

export function sort(
  orderBy: { readonly field: string; readonly direction?: string } | undefined,
  fields: readonly string[],
  kind = "query"
) {
  const field = orderBy?.field ?? "Id"
  const direction = orderBy?.direction ?? "ASC"
  if (!fields.includes(field) || (direction !== "ASC" && direction !== "DESC"))
    throw new Error(`[SixbQuickBooks] Unsupported ${kind} sort.`)
  return `${field} ${direction}`
}

export function dateLiteral(value: string, name = "Transaction dates"): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error(`[SixbQuickBooks] ${name} must be valid YYYY-MM-DD calendar dates.`)
  return quoted(value)
}

export async function readQueryPage<T>(
  http: QuickBooksReadHttp,
  entity: string,
  query: string,
  start: number,
  count: number,
  options: {
    /** Response array name when it differs from the queried entity (e.g. ExchangeRate). */
    readonly key?: string
    readonly params?: Readonly<Record<string, string>>
    readonly validate?: (item: unknown) => void
  } = {}
): Promise<QuickBooksPage<T>> {
  const key = options.key ?? entity
  const body = await http.get(`query?${new URLSearchParams({ query, ...options.params })}`)
  if (!isRecord(body) || !isRecord(body.QueryResponse))
    throw new Error("[SixbQuickBooks] Invalid QueryResponse envelope.")
  const response = body.QueryResponse
  const items: unknown = response[key] === undefined ? [] : response[key]
  if (!Array.isArray(items) || items.length > count)
    throw new Error(`[SixbQuickBooks] Invalid ${entity} query results.`)
  for (const item of items) (options.validate ?? ((value) => assertEntity(value, entity)))(item)
  if (response[key] === undefined && Object.values(response).some(Array.isArray))
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
