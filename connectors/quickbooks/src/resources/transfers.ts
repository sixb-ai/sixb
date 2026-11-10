import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTransferListOptions } from "../types/query"
import type { QuickBooksTransfer } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksTransferCreate,
  QuickBooksTransferUpdate,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  finiteAmount,
  type QuickBooksWriteHttp,
  revision,
  updateEntity,
  writeEntity,
} from "../write"

/** Transfers between balance-sheet accounts. These record bookkeeping, not money movement. */
export interface QuickBooksTransfersResource {
  create(
    input: QuickBooksTransferCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksTransfer>
  /** Sparse update; QuickBooks requires FromAccountRef, ToAccountRef and Amount. */
  update(
    input: QuickBooksTransferUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksTransfer>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/transfer/{id} */
  get(id: string): Promise<QuickBooksTransfer>
  list(options?: QuickBooksTransferListOptions): Promise<QuickBooksPage<QuickBooksTransfer>>
  listAll(options?: QuickBooksTransferListOptions): AsyncIterable<QuickBooksTransfer>
}

export function createTransfersResource(http: QuickBooksWriteHttp): QuickBooksTransfersResource {
  const resource: QuickBooksTransfersResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.FromAccountRef?.value, "FromAccountRef.value")
      nonEmpty(input.ToAccountRef?.value, "ToAccountRef.value")
      finiteAmount(input.Amount, "Amount")
      return writeEntity(http, "Transfer", "transfer", input, options)
    },
    async update(input, options) {
      revision(input)
      nonEmpty(input.FromAccountRef?.value, "FromAccountRef.value")
      nonEmpty(input.ToAccountRef?.value, "ToAccountRef.value")
      finiteAmount(input.Amount, "Amount")
      return updateEntity(http, "Transfer", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Transfer", input, options),
    get: (id) => readEntity(http, "Transfer", `transfer/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Transfer", options, { docNumber: false }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
