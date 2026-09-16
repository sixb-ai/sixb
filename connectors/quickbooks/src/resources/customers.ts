import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCustomer } from "../types/entities"
import type { QuickBooksCustomerListOptions, QuickBooksPage } from "../types/query"

export interface QuickBooksCustomersResource {
  get(id: string): Promise<QuickBooksCustomer>
  list(options?: QuickBooksCustomerListOptions): Promise<QuickBooksPage<QuickBooksCustomer>>
  listAll(options?: QuickBooksCustomerListOptions): AsyncIterable<QuickBooksCustomer>
}

export function createCustomersResource(http: QuickBooksReadHttp): QuickBooksCustomersResource {
  const resource: QuickBooksCustomersResource = {
    get: (id) => readEntity(http, "Customer", `customer/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Customer", "DisplayName", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
