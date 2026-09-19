import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksBillListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksBill } from "../types/transactions"
import type {
  QuickBooksBillCreate,
  QuickBooksBillUpdate,
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksWriteHttp,
  updateEntity,
  writeEntity,
} from "../write"
import { expenseLines } from "../write-validation"

export interface QuickBooksBillsResource {
  create(input: QuickBooksBillCreate, options?: QuickBooksWriteOptions): Promise<QuickBooksBill>
  /** Sparse update with the provider-required VendorRef and Line. */
  update(input: QuickBooksBillUpdate, options?: QuickBooksWriteOptions): Promise<QuickBooksBill>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/bill/{id} */
  get(id: string): Promise<QuickBooksBill>
  list(options?: QuickBooksBillListOptions): Promise<QuickBooksPage<QuickBooksBill>>
  listAll(options?: QuickBooksBillListOptions): AsyncIterable<QuickBooksBill>
}

export function createBillsResource(http: QuickBooksWriteHttp): QuickBooksBillsResource {
  const resource: QuickBooksBillsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
      expenseLines(input.Line)
      return writeEntity(http, "Bill", "bill", input, options)
    },
    async update(input, options) {
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
      expenseLines(input.Line)
      return updateEntity(http, "Bill", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Bill", input, options),
    get: (id) => readEntity(http, "Bill", `bill/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Bill", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
