import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksDepositListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksDeposit } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksDepositCreate,
  QuickBooksDepositUpdate,
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
import { depositLines } from "../write-validation"

/** Bank deposits, including deposits of undeposited payments through LinkedTxn lines. */
export interface QuickBooksDepositsResource {
  create(
    input: QuickBooksDepositCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeposit>
  /** Sparse update; QuickBooks requires DepositToAccountRef. */
  update(
    input: QuickBooksDepositUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeposit>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/deposit/{id} */
  get(id: string): Promise<QuickBooksDeposit>
  list(options?: QuickBooksDepositListOptions): Promise<QuickBooksPage<QuickBooksDeposit>>
  listAll(options?: QuickBooksDepositListOptions): AsyncIterable<QuickBooksDeposit>
}

export function createDepositsResource(http: QuickBooksWriteHttp): QuickBooksDepositsResource {
  const resource: QuickBooksDepositsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.DepositToAccountRef?.value, "DepositToAccountRef.value")
      depositLines(input.Line)
      return writeEntity(http, "Deposit", "deposit", input, options)
    },
    async update(input, options) {
      revision(input)
      nonEmpty(input.DepositToAccountRef?.value, "DepositToAccountRef.value")
      if (input.Line !== undefined) depositLines(input.Line)
      return updateEntity(http, "Deposit", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Deposit", input, options),
    get: (id) => readEntity(http, "Deposit", `deposit/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Deposit", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
