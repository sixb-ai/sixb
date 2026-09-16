import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksTerm } from "../types/entities"
import type { QuickBooksPage, QuickBooksTermListOptions } from "../types/query"

export interface QuickBooksTermsResource {
  get(id: string): Promise<QuickBooksTerm>
  list(options?: QuickBooksTermListOptions): Promise<QuickBooksPage<QuickBooksTerm>>
  listAll(options?: QuickBooksTermListOptions): AsyncIterable<QuickBooksTerm>
}

export function createTermsResource(http: QuickBooksReadHttp): QuickBooksTermsResource {
  const resource: QuickBooksTermsResource = {
    get: (id) => readEntity(http, "Term", `term/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Term", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
