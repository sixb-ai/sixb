import { listAll, listTransactions, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksInventoryAdjustmentListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksInventoryAdjustment } from "../types/transactions"

/** Read-only inventory quantity adjustments. */
export interface QuickBooksInventoryAdjustmentsResource {
  /** GET /v3/company/{realmId}/inventoryadjustment/{id} */
  get(id: string): Promise<QuickBooksInventoryAdjustment>
  list(
    options?: QuickBooksInventoryAdjustmentListOptions
  ): Promise<QuickBooksPage<QuickBooksInventoryAdjustment>>
  listAll(
    options?: QuickBooksInventoryAdjustmentListOptions
  ): AsyncIterable<QuickBooksInventoryAdjustment>
}

export function createInventoryAdjustmentsResource(
  http: QuickBooksReadHttp
): QuickBooksInventoryAdjustmentsResource {
  const resource: QuickBooksInventoryAdjustmentsResource = {
    get: (id) => readEntity(http, "InventoryAdjustment", `inventoryadjustment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "InventoryAdjustment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
