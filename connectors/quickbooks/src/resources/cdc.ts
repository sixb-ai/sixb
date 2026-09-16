import type { QuickBooksReadHttp } from "../query"
import type { QuickBooksCdcOptions, QuickBooksCdcResponse } from "../types/cdc"
import { isRecord } from "../validation"

const ENTITIES = new Set([
  "Account",
  "Customer",
  "Item",
  "Term",
  "Vendor",
  "Invoice",
  "Payment",
  "CreditMemo",
  "Bill",
  "BillPayment",
  "VendorCredit",
])
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

export class QuickBooksCdcLimitError extends Error {
  readonly name = "QuickBooksCdcLimitError"
  constructor(readonly response: QuickBooksCdcResponse) {
    super(
      "[SixbQuickBooks] CDC reached the 1,000-object limit. Do not advance the checkpoint; split entity requests or reconcile with a full import."
    )
  }
}

export interface QuickBooksCdcResource {
  /** GET /v3/company/{realmId}/cdc. Rejects potentially truncated results. */
  get(options: QuickBooksCdcOptions): Promise<QuickBooksCdcResponse>
}

export function createCdcResource(http: QuickBooksReadHttp): QuickBooksCdcResource {
  return {
    async get(options) {
      if (!Array.isArray(options.entities))
        throw new Error("[SixbQuickBooks] CDC entities must be an array.")
      const entities = [...options.entities]
      if (
        !entities.length ||
        entities.some((entity) => !ENTITIES.has(entity)) ||
        new Set(entities).size !== entities.length
      )
        throw new Error(
          "[SixbQuickBooks] CDC entities must be a nonempty, unique list of supported entity names."
        )
      const since = options.changedSince instanceof Date ? options.changedSince.getTime() : NaN
      const age = Date.now() - since
      if (!Number.isFinite(since) || age < 0 || age > LOOKBACK_MS)
        throw new Error(
          "[SixbQuickBooks] CDC changedSince must be a valid date within the last 30 days."
        )
      const value = await http.get(
        `cdc?${new URLSearchParams({ entities: entities.join(","), changedSince: new Date(since).toISOString() })}`
      )
      if (
        !isRecord(value) ||
        !Array.isArray(value.CDCResponse) ||
        typeof value.time !== "string" ||
        !Number.isFinite(Date.parse(value.time))
      )
        throw new Error("[SixbQuickBooks] Invalid CDC response envelope.")
      let count = 0
      for (const batch of value.CDCResponse) {
        if (!isRecord(batch) || !Array.isArray(batch.QueryResponse))
          throw new Error("[SixbQuickBooks] Invalid CDC QueryResponse.")
        for (const group of batch.QueryResponse) {
          if (!isRecord(group)) throw new Error("[SixbQuickBooks] Invalid CDC entity group.")
          let groupCount = 0
          for (const [key, records] of Object.entries(group)) {
            if (["startPosition", "maxResults", "totalCount"].includes(key)) {
              if (typeof records !== "number" || !Number.isSafeInteger(records) || records < 0)
                throw new Error("[SixbQuickBooks] Invalid CDC count metadata.")
              continue
            }
            if (!entities.some((entity) => entity === key) || !Array.isArray(records))
              throw new Error("[SixbQuickBooks] CDC returned an unexpected entity or fault.")
            for (const record of records) {
              if (
                !isRecord(record) ||
                typeof record.Id !== "string" ||
                !record.Id.trim() ||
                (record.status !== undefined && record.status !== "Deleted")
              )
                throw new Error("[SixbQuickBooks] Invalid CDC record.")
            }
            groupCount += records.length
          }
          if (
            !groupCount &&
            ((typeof group.totalCount === "number" && group.totalCount > 0) ||
              (typeof group.maxResults === "number" && group.maxResults > 0))
          )
            throw new Error("[SixbQuickBooks] CDC omitted its entity records.")
          count += Math.max(
            groupCount,
            typeof group.totalCount === "number" ? group.totalCount : 0,
            typeof group.maxResults === "number" ? group.maxResults : 0
          )
        }
      }
      const response = value as unknown as QuickBooksCdcResponse
      if (count >= 1000) throw new QuickBooksCdcLimitError(response)
      return response
    },
  }
}
