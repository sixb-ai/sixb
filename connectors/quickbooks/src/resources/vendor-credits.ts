import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksVendorCreditListOptions } from "../types/query"
import type { QuickBooksVendorCredit } from "../types/transactions"

export interface QuickBooksVendorCreditsResource {
  /** GET /v3/company/{realmId}/vendorcredit/{id} */
  get(id: string): Promise<QuickBooksVendorCredit>
  list(options?: QuickBooksVendorCreditListOptions): Promise<QuickBooksPage<QuickBooksVendorCredit>>
  listAll(options?: QuickBooksVendorCreditListOptions): AsyncIterable<QuickBooksVendorCredit>
}

export function createVendorCreditsResource(
  http: QuickBooksReadHttp
): QuickBooksVendorCreditsResource {
  const resource: QuickBooksVendorCreditsResource = {
    get: (id) => readEntity(http, "VendorCredit", `vendorcredit/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "VendorCredit", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
