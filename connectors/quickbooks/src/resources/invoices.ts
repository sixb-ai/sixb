import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksInvoiceListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksInvoice } from "../types/transactions"

export interface QuickBooksInvoicesResource {
  /** GET /v3/company/{realmId}/invoice/{id} */
  get(id: string): Promise<QuickBooksInvoice>
  list(options?: QuickBooksInvoiceListOptions): Promise<QuickBooksPage<QuickBooksInvoice>>
  listAll(options?: QuickBooksInvoiceListOptions): AsyncIterable<QuickBooksInvoice>
}

export function createInvoicesResource(http: QuickBooksReadHttp): QuickBooksInvoicesResource {
  const resource: QuickBooksInvoicesResource = {
    get: (id) => readEntity(http, "Invoice", `invoice/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Invoice", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
