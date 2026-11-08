import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksCompanyCurrency } from "../types/entities"
import type { QuickBooksCompanyCurrencyListOptions, QuickBooksPage } from "../types/query"

/** Read-only; requires multicurrency. Currencies have no queryable name field. */
export interface QuickBooksCompanyCurrenciesResource {
  /** GET /v3/company/{realmId}/companycurrency/{id} */
  get(id: string): Promise<QuickBooksCompanyCurrency>
  list(
    options?: QuickBooksCompanyCurrencyListOptions
  ): Promise<QuickBooksPage<QuickBooksCompanyCurrency>>
  listAll(options?: QuickBooksCompanyCurrencyListOptions): AsyncIterable<QuickBooksCompanyCurrency>
}

export function createCompanyCurrenciesResource(
  http: QuickBooksReadHttp
): QuickBooksCompanyCurrenciesResource {
  const resource: QuickBooksCompanyCurrenciesResource = {
    get: (id) => readEntity(http, "CompanyCurrency", `companycurrency/${pathId(id)}`, id),
    list: (options) => listEntities(http, "CompanyCurrency", undefined, options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
