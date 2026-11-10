import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksPurchaseListOptions } from "../types/query"
import type { QuickBooksPurchase } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksPurchaseCreate,
  QuickBooksPurchaseUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksWriteHttp,
  revision,
  updateEntity,
  writeEntity,
} from "../write"
import { expenseLines, purchasePayment } from "../write-validation"

/** Expenses, checks and credit-card charges. These record bookkeeping, not money movement. */
export interface QuickBooksPurchasesResource {
  create(
    input: QuickBooksPurchaseCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPurchase>
  /** Sparse update; QuickBooks requires the current PaymentType. */
  update(
    input: QuickBooksPurchaseUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPurchase>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/purchase/{id} */
  get(id: string): Promise<QuickBooksPurchase>
  list(options?: QuickBooksPurchaseListOptions): Promise<QuickBooksPage<QuickBooksPurchase>>
  listAll(options?: QuickBooksPurchaseListOptions): AsyncIterable<QuickBooksPurchase>
}

export function createPurchasesResource(http: QuickBooksWriteHttp): QuickBooksPurchasesResource {
  const resource: QuickBooksPurchasesResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.PaymentType, "PaymentType")
      nonEmpty(input.AccountRef?.value, "AccountRef.value")
      purchasePayment(input)
      expenseLines(input.Line)
      return writeEntity(http, "Purchase", "purchase", input, options)
    },
    async update(input, options) {
      revision(input)
      nonEmpty(input.PaymentType, "PaymentType")
      purchasePayment(input)
      if (input.Line !== undefined) expenseLines(input.Line)
      return updateEntity(http, "Purchase", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Purchase", input, options),
    get: (id) => readEntity(http, "Purchase", `purchase/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Purchase", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
