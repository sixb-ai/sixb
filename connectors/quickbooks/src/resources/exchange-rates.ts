import {
  allowedOptions,
  dateLiteral,
  listAll,
  page,
  type QuickBooksReadHttp,
  readQueryPage,
  updatedSince,
  where,
} from "../query"
import type { QuickBooksExchangeRate } from "../types/entities"
import type {
  QuickBooksExchangeRateKey,
  QuickBooksExchangeRateListOptions,
  QuickBooksPage,
} from "../types/query"
import { isRecord } from "../validation"

/**
 * Read-only rates to the home currency. Rates have no entity ID: read one by currency and date.
 * QuickBooks ignores SourceCurrencyCode and AsOfDate query predicates, so `list` offers only
 * pagination and a modification bound, in provider order.
 */
export interface QuickBooksExchangeRatesResource {
  /** GET /v3/company/{realmId}/exchangerate?sourcecurrencycode=..&asofdate=.. */
  get(key: QuickBooksExchangeRateKey): Promise<QuickBooksExchangeRate>
  list(options?: QuickBooksExchangeRateListOptions): Promise<QuickBooksPage<QuickBooksExchangeRate>>
  listAll(options?: QuickBooksExchangeRateListOptions): AsyncIterable<QuickBooksExchangeRate>
}

export function createExchangeRatesResource(
  http: QuickBooksReadHttp
): QuickBooksExchangeRatesResource {
  const resource: QuickBooksExchangeRatesResource = {
    async get(key) {
      allowedOptions(key, "exchange rate key", ["sourceCurrencyCode", "asOfDate"])
      const currency = currencyCode(key.sourceCurrencyCode)
      const params = new URLSearchParams({ sourcecurrencycode: currency })
      if (key.asOfDate !== undefined) {
        dateLiteral(key.asOfDate, "asOfDate")
        params.set("asofdate", key.asOfDate)
      }
      const body = await http.get(`exchangerate?${params}`)
      const rate = isRecord(body) ? body.ExchangeRate : undefined
      exchangeRate(rate)
      if (
        rate.SourceCurrencyCode !== currency ||
        (key.asOfDate !== undefined && rate.AsOfDate !== key.asOfDate)
      )
        throw new Error("[SixbQuickBooks] ExchangeRate response does not match the request.")
      return rate as unknown as QuickBooksExchangeRate
    },
    async list(options = {}) {
      allowedOptions(options, "exchange rate list", ["startPosition", "maxResults", "updatedSince"])
      const { start, count } = page(options)
      const clauses = options.updatedSince === undefined ? [] : [updatedSince(options.updatedSince)]
      // No ORDERBY: QuickBooks cannot sort exchange rates by date or currency.
      return readQueryPage(
        http,
        "Exchangerate",
        `SELECT * FROM Exchangerate${where(clauses)} STARTPOSITION ${start} MAXRESULTS ${count}`,
        start,
        count,
        { key: "ExchangeRate", validate: exchangeRate }
      )
    },
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function currencyCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
    throw new Error("[SixbQuickBooks] sourceCurrencyCode must be a three-letter ISO 4217 code.")
  return value
}

function exchangeRate(value: unknown): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.SourceCurrencyCode !== "string" ||
    !value.SourceCurrencyCode.trim()
  )
    throw new Error("[SixbQuickBooks] Invalid ExchangeRate response.")
}
