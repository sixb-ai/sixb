import { integer, type QuickBooksReadHttp } from "../query"
import {
  REPORT_PARAMETERS,
  REPORT_RANGES,
  REPORTS,
  type ReportEntry,
  type ReportOption,
} from "../report-catalog"
import type {
  QuickBooksReport,
  QuickBooksReportMethod,
  QuickBooksReportOptionsFor,
} from "../types/reports"
import { isRecord, nonEmpty } from "../validation"

/** One method per report: GET /reports/{route}, accepting only the options its catalog entry lists. */
export type QuickBooksReportsResource = {
  readonly [M in QuickBooksReportMethod]: (
    options?: QuickBooksReportOptionsFor<M>
  ) => Promise<QuickBooksReport>
}

export function createReportsResource(http: QuickBooksReadHttp): QuickBooksReportsResource {
  const methods: Record<string, (options?: object) => Promise<QuickBooksReport>> = {}
  for (const [method, [route, entries]] of Object.entries(REPORTS)) {
    const kinds = new Map<string, Kind>()
    for (const entry of entries as readonly ReportEntry[])
      if (typeof entry === "string") kinds.set(entry, REPORT_PARAMETERS[entry][1])
      else kinds.set(entry[0], entry[1])
    methods[method] = (options) => readReport(http, route, kinds, options ?? {})
  }
  return methods as QuickBooksReportsResource
}

// QuickBooks silently ignores parameters it does not recognize, so every option is checked here.
type Kind = (typeof REPORT_PARAMETERS)[ReportOption][1] | readonly string[]

async function readReport(
  http: QuickBooksReadHttp,
  route: string,
  kinds: ReadonlyMap<string, Kind>,
  options: object
): Promise<QuickBooksReport> {
  if (typeof options !== "object" || options === null)
    throw new Error("[SixbQuickBooks] Report options must be an object.")
  const values = options as Partial<Record<ReportOption, unknown>>
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    const kind = kinds.get(key)
    if (kind === undefined)
      throw new Error(`[SixbQuickBooks] Unsupported ${route} report option: ${key}.`)
    if (value === undefined) continue
    query.set(REPORT_PARAMETERS[key as ReportOption][0], serialize(key, value, kind))
  }
  for (const [start, end, macro] of REPORT_RANGES) {
    const from = values[start]
    const to = values[end]
    if (typeof from === "string" && typeof to === "string" && from > to)
      throw new Error(`[SixbQuickBooks] ${start} must not follow ${end}.`)
    if (values[macro] !== undefined && (from !== undefined || to !== undefined))
      throw new Error(`[SixbQuickBooks] Use ${macro} or ${start}/${end}, not both.`)
  }
  const body = await http.get(`reports/${route}${query.size ? `?${query}` : ""}`)
  if (
    !isRecord(body) ||
    !isRecord(body.Header) ||
    !isRecord(body.Columns) ||
    !Array.isArray(body.Columns.Column) ||
    !body.Columns.Column.every(isRecord)
  )
    throw new Error(`[SixbQuickBooks] Invalid ${route} report response.`)
  validateRows(body.Rows)
  return body as unknown as QuickBooksReport
}

function serialize(key: string, value: unknown, kind: Kind): string {
  if (typeof kind !== "string") {
    if (typeof value !== "string" || !(kind as readonly string[]).includes(value))
      throw new Error(`[SixbQuickBooks] ${key} must be one of: ${kind.join(", ")}.`)
    return value
  }
  switch (kind) {
    case "date":
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw new Error(`[SixbQuickBooks] ${key} must be a valid YYYY-MM-DD calendar date.`)
      return value
    case "ids":
    case "keys":
      if (!Array.isArray(value) || value.length === 0)
        throw new Error(`[SixbQuickBooks] ${key} must be a non-empty array.`)
      for (const entry of value) {
        nonEmpty(entry, key)
        if (entry.includes(","))
          throw new Error(`[SixbQuickBooks] ${key} entries cannot contain commas.`)
      }
      return value.join(",")
    case "text":
      nonEmpty(value, key)
      return value
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`[SixbQuickBooks] ${key} must be a boolean.`)
      return String(value)
    case "amount":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`[SixbQuickBooks] ${key} must be a finite number.`)
      return String(value)
    case "count":
    case "days":
      integer(value as number, key, kind === "count" ? 1 : 0)
      return String(value)
  }
}

function validateRows(rows: unknown): void {
  if (rows === undefined) return
  if (!isRecord(rows) || (rows.Row !== undefined && !Array.isArray(rows.Row)))
    throw new Error("[SixbQuickBooks] Invalid report Rows.")
  if (!Array.isArray(rows.Row)) return
  for (const row of rows.Row) {
    if (!isRecord(row)) throw new Error("[SixbQuickBooks] Invalid report row.")
    for (const section of [row, row.Header, row.Summary]) {
      if (section === undefined) continue
      if (
        !isRecord(section) ||
        (section.ColData !== undefined &&
          (!Array.isArray(section.ColData) ||
            !section.ColData.every((cell) => isRecord(cell) && typeof cell.value === "string")))
      )
        throw new Error("[SixbQuickBooks] Invalid report cells.")
    }
    validateRows(row.Rows)
  }
}
