import { integer, type QuickBooksReadHttp } from "../query"
import type {
  QuickBooksAgingReportOptions,
  QuickBooksPayableAgingOptions,
  QuickBooksReceivableAgingOptions,
  QuickBooksReport,
} from "../types/reports"
import { isRecord, nonEmpty } from "../validation"

export interface QuickBooksReportsResource {
  agedReceivables(options?: QuickBooksReceivableAgingOptions): Promise<QuickBooksReport>
  agedReceivableDetail(options?: QuickBooksReceivableAgingOptions): Promise<QuickBooksReport>
  agedPayables(options?: QuickBooksPayableAgingOptions): Promise<QuickBooksReport>
  agedPayableDetail(options?: QuickBooksPayableAgingOptions): Promise<QuickBooksReport>
}

export function createReportsResource(http: QuickBooksReadHttp): QuickBooksReportsResource {
  async function read(
    name: string,
    options: QuickBooksAgingReportOptions & {
      readonly customerIds?: readonly string[]
      readonly vendorIds?: readonly string[]
    } = {},
    party: "customer" | "vendor"
  ): Promise<QuickBooksReport> {
    const idKey = party === "customer" ? "customerIds" : "vendorIds"
    for (const key of Object.keys(options))
      if (!["reportDate", "agingMethod", "agingPeriod", "numPeriods", idKey].includes(key))
        throw new Error(`[SixbQuickBooks] Unsupported aging report option: ${key}.`)
    const query = new URLSearchParams()
    if (options.reportDate !== undefined) {
      const date = options.reportDate
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      )
        throw new Error("[SixbQuickBooks] reportDate must be a valid YYYY-MM-DD calendar date.")
      query.set("report_date", date)
    }
    if (options.agingMethod !== undefined) {
      if (options.agingMethod !== "Current" && options.agingMethod !== "Report_Date")
        throw new Error("[SixbQuickBooks] agingMethod must be Current or Report_Date.")
      query.set("aging_method", options.agingMethod)
    }
    for (const [key, parameter] of [
      ["agingPeriod", "aging_period"],
      ["numPeriods", "num_periods"],
    ] as const) {
      const value = options[key]
      if (value !== undefined) {
        integer(value, key, 1)
        query.set(parameter, String(value))
      }
    }
    const ids = options[idKey]
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length === 0)
        throw new Error(`[SixbQuickBooks] ${idKey} must be a non-empty array.`)
      for (const id of ids) {
        nonEmpty(id, idKey)
        if (id.includes(","))
          throw new Error(`[SixbQuickBooks] ${idKey} entries cannot contain commas.`)
      }
      query.set(party, ids.join(","))
    }
    const body = await http.get(`reports/${name}${query.size ? `?${query}` : ""}`)
    if (
      !isRecord(body) ||
      !isRecord(body.Header) ||
      !isRecord(body.Columns) ||
      !Array.isArray(body.Columns.Column) ||
      !body.Columns.Column.every(isRecord)
    )
      throw new Error("[SixbQuickBooks] Invalid aging report response.")
    validateRows(body.Rows)
    return body as unknown as QuickBooksReport
  }
  return {
    agedReceivables: (options) => read("AgedReceivables", options, "customer"),
    agedReceivableDetail: (options) => read("AgedReceivableDetail", options, "customer"),
    agedPayables: (options) => read("AgedPayables", options, "vendor"),
    agedPayableDetail: (options) => read("AgedPayableDetail", options, "vendor"),
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
