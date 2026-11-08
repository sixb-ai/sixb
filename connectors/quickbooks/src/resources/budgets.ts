import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksBudget } from "../types/entities"
import type { QuickBooksBudgetListOptions, QuickBooksPage } from "../types/query"

/** Read-only. */
export interface QuickBooksBudgetsResource {
  /** GET /v3/company/{realmId}/budget/{id} */
  get(id: string): Promise<QuickBooksBudget>
  list(options?: QuickBooksBudgetListOptions): Promise<QuickBooksPage<QuickBooksBudget>>
  listAll(options?: QuickBooksBudgetListOptions): AsyncIterable<QuickBooksBudget>
}

export function createBudgetsResource(http: QuickBooksReadHttp): QuickBooksBudgetsResource {
  const resource: QuickBooksBudgetsResource = {
    get: (id) => readEntity(http, "Budget", `budget/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Budget", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
