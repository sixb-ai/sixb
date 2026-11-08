import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTaxAgencyListOptions } from "../types/query"
import type { QuickBooksTaxAgency } from "../types/tax"

/** Read-only. TaxAgency has no Active flag; `name` matches DisplayName via the provider's Name field. */
export interface QuickBooksTaxAgenciesResource {
  /** GET /v3/company/{realmId}/taxagency/{id} */
  get(id: string): Promise<QuickBooksTaxAgency>
  list(options?: QuickBooksTaxAgencyListOptions): Promise<QuickBooksPage<QuickBooksTaxAgency>>
  listAll(options?: QuickBooksTaxAgencyListOptions): AsyncIterable<QuickBooksTaxAgency>
}

export function createTaxAgenciesResource(http: QuickBooksReadHttp): QuickBooksTaxAgenciesResource {
  const resource: QuickBooksTaxAgenciesResource = {
    get: (id) => readEntity(http, "TaxAgency", `taxagency/${pathId(id)}`, id),
    list: (options) => listEntities(http, "TaxAgency", "Name", options, { active: false }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
