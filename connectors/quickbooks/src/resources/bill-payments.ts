import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksBillPaymentListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksBillPayment } from "../types/transactions"

export interface QuickBooksBillPaymentsResource {
  /** GET /v3/company/{realmId}/billpayment/{id} */
  get(id: string): Promise<QuickBooksBillPayment>
  list(options?: QuickBooksBillPaymentListOptions): Promise<QuickBooksPage<QuickBooksBillPayment>>
  listAll(options?: QuickBooksBillPaymentListOptions): AsyncIterable<QuickBooksBillPayment>
}

export function createBillPaymentsResource(
  http: QuickBooksReadHttp
): QuickBooksBillPaymentsResource {
  const resource: QuickBooksBillPaymentsResource = {
    get: (id) => readEntity(http, "BillPayment", `billpayment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "BillPayment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
