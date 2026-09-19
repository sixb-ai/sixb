import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksCreditMemoListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksCreditMemo } from "../types/transactions"
import type {
  QuickBooksCreditMemoCreate,
  QuickBooksCreditMemoSendOptions,
  QuickBooksCreditMemoUpdate,
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksWriteHttp,
  sendEntity,
  updateEntity,
  writeEntity,
} from "../write"
import { salesLines } from "../write-validation"

export interface QuickBooksCreditMemosResource {
  create(
    input: QuickBooksCreditMemoCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCreditMemo>
  update(
    input: QuickBooksCreditMemoUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCreditMemo>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  send(id: string, options?: QuickBooksCreditMemoSendOptions): Promise<QuickBooksCreditMemo>
  /** GET /v3/company/{realmId}/creditmemo/{id} */
  get(id: string): Promise<QuickBooksCreditMemo>
  list(options?: QuickBooksCreditMemoListOptions): Promise<QuickBooksPage<QuickBooksCreditMemo>>
  listAll(options?: QuickBooksCreditMemoListOptions): AsyncIterable<QuickBooksCreditMemo>
}

export function createCreditMemosResource(
  http: QuickBooksWriteHttp
): QuickBooksCreditMemosResource {
  const resource: QuickBooksCreditMemosResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      salesLines(input.Line)
      return writeEntity(http, "CreditMemo", "creditmemo", input, options)
    },
    async update(input, options) {
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      salesLines(input.Line)
      return updateEntity(http, "CreditMemo", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "CreditMemo", input, options),
    send: async (id, options) => sendEntity(http, "CreditMemo", id, options),
    get: (id) => readEntity(http, "CreditMemo", `creditmemo/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "CreditMemo", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
