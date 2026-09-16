import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksPaymentListOptions } from "../types/query"
import type { QuickBooksPayment } from "../types/transactions"

export interface QuickBooksPaymentsResource {
  /** GET /v3/company/{realmId}/payment/{id} */
  get(id: string): Promise<QuickBooksPayment>
  list(options?: QuickBooksPaymentListOptions): Promise<QuickBooksPage<QuickBooksPayment>>
  listAll(options?: QuickBooksPaymentListOptions): AsyncIterable<QuickBooksPayment>
}

export function createPaymentsResource(http: QuickBooksReadHttp): QuickBooksPaymentsResource {
  const resource: QuickBooksPaymentsResource = {
    get: (id) => readEntity(http, "Payment", `payment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Payment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
