import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTaxRateListOptions } from "../types/query"
import type { QuickBooksTaxRate } from "../types/tax"

/** Read-only. */
export interface QuickBooksTaxRatesResource {
  /** GET /v3/company/{realmId}/taxrate/{id} */
  get(id: string): Promise<QuickBooksTaxRate>
  list(options?: QuickBooksTaxRateListOptions): Promise<QuickBooksPage<QuickBooksTaxRate>>
  listAll(options?: QuickBooksTaxRateListOptions): AsyncIterable<QuickBooksTaxRate>
}

export function createTaxRatesResource(http: QuickBooksReadHttp): QuickBooksTaxRatesResource {
  const resource: QuickBooksTaxRatesResource = {
    get: (id) => readEntity(http, "TaxRate", `taxrate/${pathId(id)}`, id),
    list: (options) => listEntities(http, "TaxRate", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
