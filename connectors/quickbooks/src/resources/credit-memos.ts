import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCreditMemoListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksCreditMemo } from "../types/transactions"

export interface QuickBooksCreditMemosResource {
  /** GET /v3/company/{realmId}/creditmemo/{id} */
  get(id: string): Promise<QuickBooksCreditMemo>
  list(options?: QuickBooksCreditMemoListOptions): Promise<QuickBooksPage<QuickBooksCreditMemo>>
  listAll(options?: QuickBooksCreditMemoListOptions): AsyncIterable<QuickBooksCreditMemo>
}

export function createCreditMemosResource(http: QuickBooksReadHttp): QuickBooksCreditMemosResource {
  const resource: QuickBooksCreditMemosResource = {
    get: (id) => readEntity(http, "CreditMemo", `creditmemo/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "CreditMemo", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
