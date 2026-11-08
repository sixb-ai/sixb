import { listAll, listEntities, pathId, type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTaxCodeListOptions } from "../types/query"
import type { QuickBooksTaxCode } from "../types/tax"

/** Read-only. `list` always sends an Active predicate, which excludes US pseudo-codes (TAX, NON). */
export interface QuickBooksTaxCodesResource {
  /** GET /v3/company/{realmId}/taxcode/{id} */
  get(id: string): Promise<QuickBooksTaxCode>
  list(options?: QuickBooksTaxCodeListOptions): Promise<QuickBooksPage<QuickBooksTaxCode>>
  listAll(options?: QuickBooksTaxCodeListOptions): AsyncIterable<QuickBooksTaxCode>
}

export function createTaxCodesResource(http: QuickBooksReadHttp): QuickBooksTaxCodesResource {
  const resource: QuickBooksTaxCodesResource = {
    get: (id) => readEntity(http, "TaxCode", `taxcode/${pathId(id)}`, id),
    list: (options) => listEntities(http, "TaxCode", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
