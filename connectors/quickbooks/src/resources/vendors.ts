import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksVendor } from "../types/entities"
import type { QuickBooksPage, QuickBooksVendorListOptions } from "../types/query"

export interface QuickBooksVendorsResource {
  get(id: string): Promise<QuickBooksVendor>
  list(options?: QuickBooksVendorListOptions): Promise<QuickBooksPage<QuickBooksVendor>>
  listAll(options?: QuickBooksVendorListOptions): AsyncIterable<QuickBooksVendor>
}

export function createVendorsResource(http: QuickBooksReadHttp): QuickBooksVendorsResource {
  const resource: QuickBooksVendorsResource = {
    get: (id) => readEntity(http, "Vendor", `vendor/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Vendor", "DisplayName", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
