import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksAccount } from "../types/entities"
import type { QuickBooksAccountListOptions, QuickBooksPage } from "../types/query"

export interface QuickBooksAccountsResource {
  get(id: string): Promise<QuickBooksAccount>
  list(options?: QuickBooksAccountListOptions): Promise<QuickBooksPage<QuickBooksAccount>>
  listAll(options?: QuickBooksAccountListOptions): AsyncIterable<QuickBooksAccount>
}

export function createAccountsResource(http: QuickBooksReadHttp): QuickBooksAccountsResource {
  const resource: QuickBooksAccountsResource = {
    get: (id) => readEntity(http, "Account", `account/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Account", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
