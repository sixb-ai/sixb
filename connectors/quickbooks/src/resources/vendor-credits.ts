import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksVendorCreditListOptions } from "../types/query"
import type { QuickBooksVendorCredit } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksVendorCreditCreate,
  QuickBooksVendorCreditUpdate,
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

export interface QuickBooksVendorCreditsResource {
  create(
    input: QuickBooksVendorCreditCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksVendorCredit>
  update(
    input: QuickBooksVendorCreditUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksVendorCredit>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/vendorcredit/{id} */
  get(id: string): Promise<QuickBooksVendorCredit>
  list(options?: QuickBooksVendorCreditListOptions): Promise<QuickBooksPage<QuickBooksVendorCredit>>
  listAll(options?: QuickBooksVendorCreditListOptions): AsyncIterable<QuickBooksVendorCredit>
}

export function createVendorCreditsResource(
  http: QuickBooksWriteHttp
): QuickBooksVendorCreditsResource {
  const resource: QuickBooksVendorCreditsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
      expenseLines(input.Line)
      return writeEntity(http, "VendorCredit", "vendorcredit", input, options)
    },
    async update(input, options) {
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
      expenseLines(input.Line)
      return updateEntity(http, "VendorCredit", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "VendorCredit", input, options),
    get: (id) => readEntity(http, "VendorCredit", `vendorcredit/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "VendorCredit", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
