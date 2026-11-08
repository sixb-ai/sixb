import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCustomerType } from "../types/entities"
import type { QuickBooksCustomerTypeListOptions, QuickBooksPage } from "../types/query"

export interface QuickBooksCustomerTypesResource {
  /** GET /v3/company/{realmId}/customertype/{id} */
  get(id: string): Promise<QuickBooksCustomerType>
  list(options?: QuickBooksCustomerTypeListOptions): Promise<QuickBooksPage<QuickBooksCustomerType>>
  listAll(options?: QuickBooksCustomerTypeListOptions): AsyncIterable<QuickBooksCustomerType>
}

export function createCustomerTypesResource(
  http: QuickBooksReadHttp
): QuickBooksCustomerTypesResource {
  const resource: QuickBooksCustomerTypesResource = {
    get: (id) => readEntity(http, "CustomerType", `customertype/${pathId(id)}`, id),
    list: (options) => listEntities(http, "CustomerType", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
