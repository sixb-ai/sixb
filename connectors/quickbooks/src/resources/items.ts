import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksItem } from "../types/entities"
import type { QuickBooksItemListOptions, QuickBooksPage } from "../types/query"

export interface QuickBooksItemsResource {
  get(id: string): Promise<QuickBooksItem>
  list(options?: QuickBooksItemListOptions): Promise<QuickBooksPage<QuickBooksItem>>
  listAll(options?: QuickBooksItemListOptions): AsyncIterable<QuickBooksItem>
}

export function createItemsResource(http: QuickBooksReadHttp): QuickBooksItemsResource {
  const resource: QuickBooksItemsResource = {
    get: (id) => readEntity(http, "Item", `item/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Item", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
