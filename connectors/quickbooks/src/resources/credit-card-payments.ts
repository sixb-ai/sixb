import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCreditCardPaymentListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksCreditCardPayment } from "../types/transactions"

/** Read-only payments toward credit-card balances. */
export interface QuickBooksCreditCardPaymentsResource {
  /** GET /v3/company/{realmId}/creditcardpayment/{id} */
  get(id: string): Promise<QuickBooksCreditCardPayment>
  list(
    options?: QuickBooksCreditCardPaymentListOptions
  ): Promise<QuickBooksPage<QuickBooksCreditCardPayment>>
  listAll(
    options?: QuickBooksCreditCardPaymentListOptions
  ): AsyncIterable<QuickBooksCreditCardPayment>
}

export function createCreditCardPaymentsResource(
  http: QuickBooksReadHttp
): QuickBooksCreditCardPaymentsResource {
  const resource: QuickBooksCreditCardPaymentsResource = {
    get: (id) => readEntity(http, "CreditCardPayment", `creditcardpayment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "CreditCardPayment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
