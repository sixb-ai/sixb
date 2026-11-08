import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCreditCardPaymentListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksCreditCardPayment } from "../types/transactions"

/**
 * Read-only payments toward credit-card balances. The wire entity is `CreditCardPaymentTxn`
 * (path `creditcardpayment`); QuickBooks does not store DocNumber on them.
 */
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
    get: (id) => readEntity(http, "CreditCardPaymentTxn", `creditcardpayment/${pathId(id)}`, id),
    list: (options) =>
      listTransactions(
        http,
        "CreditCardPayment",
        options,
        { docNumber: false },
        { key: "CreditCardPaymentTxn" }
      ),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
