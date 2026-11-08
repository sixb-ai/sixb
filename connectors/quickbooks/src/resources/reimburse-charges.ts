import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksReimburseChargeListOptions } from "../types/query"
import type { QuickBooksReimburseCharge } from "../types/transactions"

/** Read-only billable expenses. QuickBooks rejects TxnDate and DocNumber predicates for this entity. */
export interface QuickBooksReimburseChargesResource {
  /** GET /v3/company/{realmId}/reimbursecharge/{id} */
  get(id: string): Promise<QuickBooksReimburseCharge>
  list(
    options?: QuickBooksReimburseChargeListOptions
  ): Promise<QuickBooksPage<QuickBooksReimburseCharge>>
  listAll(options?: QuickBooksReimburseChargeListOptions): AsyncIterable<QuickBooksReimburseCharge>
}

export function createReimburseChargesResource(
  http: QuickBooksReadHttp
): QuickBooksReimburseChargesResource {
  const resource: QuickBooksReimburseChargesResource = {
    get: (id) => readEntity(http, "ReimburseCharge", `reimbursecharge/${pathId(id)}`, id),
    list: (options) =>
      listTransactions(http, "ReimburseCharge", options, {
        party: "customer",
        txnDate: false,
        docNumber: false,
      }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
