import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTaxPaymentListOptions } from "../types/query"
import type { QuickBooksTaxPayment } from "../types/tax"

/** Read-only sales-tax payments. Not available in US companies (QuickBooks error 5030). */
export interface QuickBooksTaxPaymentsResource {
  /** GET /v3/company/{realmId}/taxpayment/{id} */
  get(id: string): Promise<QuickBooksTaxPayment>
  list(options?: QuickBooksTaxPaymentListOptions): Promise<QuickBooksPage<QuickBooksTaxPayment>>
  listAll(options?: QuickBooksTaxPaymentListOptions): AsyncIterable<QuickBooksTaxPayment>
}

export function createTaxPaymentsResource(http: QuickBooksReadHttp): QuickBooksTaxPaymentsResource {
  const resource: QuickBooksTaxPaymentsResource = {
    get: (id) => readEntity(http, "TaxPayment", `taxpayment/${pathId(id)}`, id),
    list: (options) =>
      listTransactions(http, "TaxPayment", options, { txnDate: false, docNumber: false }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
