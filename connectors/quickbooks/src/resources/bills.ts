import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksBillListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksBill } from "../types/transactions"

export interface QuickBooksBillsResource {
  /** GET /v3/company/{realmId}/bill/{id} */
  get(id: string): Promise<QuickBooksBill>
  list(options?: QuickBooksBillListOptions): Promise<QuickBooksPage<QuickBooksBill>>
  listAll(options?: QuickBooksBillListOptions): AsyncIterable<QuickBooksBill>
}

export function createBillsResource(http: QuickBooksReadHttp): QuickBooksBillsResource {
  const resource: QuickBooksBillsResource = {
    get: (id) => readEntity(http, "Bill", `bill/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Bill", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
