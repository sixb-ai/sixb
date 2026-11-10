import {
  allowedOptions,
  inList,
  pathId,
  type QuickBooksReadHttp,
  quoted,
  readEntity,
  readQueryPage,
  where,
} from "../query"
import type { QuickBooksPage, QuickBooksTaxClassificationListOptions } from "../types/query"
import type { QuickBooksTaxClassification } from "../types/tax"

/**
 * Read-only global tax categories. QuickBooks ignores STARTPOSITION/MAXRESULTS for this entity
 * and returns every match in one response (over 2,000 rows unfiltered), so `list` is not paged.
 */
export interface QuickBooksTaxClassificationsResource {
  /** GET /v3/company/{realmId}/taxclassification/{id} */
  get(id: string): Promise<QuickBooksTaxClassification>
  /** One provider response containing every matching classification. */
  list(
    options?: QuickBooksTaxClassificationListOptions
  ): Promise<QuickBooksPage<QuickBooksTaxClassification>>
  listAll(
    options?: QuickBooksTaxClassificationListOptions
  ): AsyncIterable<QuickBooksTaxClassification>
}

export function createTaxClassificationsResource(
  http: QuickBooksReadHttp
): QuickBooksTaxClassificationsResource {
  const resource: QuickBooksTaxClassificationsResource = {
    get: (id) => readEntity(http, "TaxClassification", `taxclassification/${pathId(id)}`, id),
    async list(options = {}) {
      allowedOptions(options, "tax classification list", ["ids", "name", "level", "parentId"])
      const clauses: string[] = []
      if (options.ids !== undefined) clauses.push(inList("Id", options.ids, "ids"))
      if (options.name !== undefined) clauses.push(`Name = ${quoted(options.name)}`)
      if (options.level !== undefined) clauses.push(`Level = ${quoted(options.level)}`)
      if (options.parentId !== undefined) clauses.push(`ParentRef = ${quoted(options.parentId)}`)
      return readQueryPage(
        http,
        "TaxClassification",
        `SELECT * FROM TaxClassification${where(clauses)}`,
        1,
        Number.MAX_SAFE_INTEGER
      )
    },
    async *listAll(options) {
      yield* (await resource.list(options)).items
    },
  }
  return resource
}
