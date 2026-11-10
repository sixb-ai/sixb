import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksSalesReceiptListOptions } from "../types/query"
import type { QuickBooksSalesReceipt } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksSalesReceiptCreate,
  QuickBooksSalesReceiptSendOptions,
  QuickBooksSalesReceiptUpdate,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksPdfHttp,
  revision,
  sendEntity,
  updateEntity,
  voidByUpdate,
  writeEntity,
} from "../write"
import { salesLines } from "../write-validation"

export interface QuickBooksSalesReceiptsResource {
  create(
    input: QuickBooksSalesReceiptCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksSalesReceipt>
  update(
    input: QuickBooksSalesReceiptUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksSalesReceipt>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** Sparse update with include=void; the receipt is retained with zero amounts. */
  void(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksSalesReceipt>
  send(id: string, options?: QuickBooksSalesReceiptSendOptions): Promise<QuickBooksSalesReceipt>
  /** GET /v3/company/{realmId}/salesreceipt/{id} */
  get(id: string): Promise<QuickBooksSalesReceipt>
  /** GET /v3/company/{realmId}/salesreceipt/{id}/pdf */
  downloadPdf(id: string): Promise<Uint8Array<ArrayBuffer>>
  list(options?: QuickBooksSalesReceiptListOptions): Promise<QuickBooksPage<QuickBooksSalesReceipt>>
  listAll(options?: QuickBooksSalesReceiptListOptions): AsyncIterable<QuickBooksSalesReceipt>
}

export function createSalesReceiptsResource(
  http: QuickBooksPdfHttp
): QuickBooksSalesReceiptsResource {
  const resource: QuickBooksSalesReceiptsResource = {
    async create(input, options) {
      createInput(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      salesLines(input.Line)
      return writeEntity(http, "SalesReceipt", "salesreceipt", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.Line !== undefined) salesLines(input.Line)
      return updateEntity(http, "SalesReceipt", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "SalesReceipt", input, options),
    void: async (input, options) => voidByUpdate(http, "SalesReceipt", input, options),
    send: async (id, options) => sendEntity(http, "SalesReceipt", id, options),
    get: (id) => readEntity(http, "SalesReceipt", `salesreceipt/${pathId(id)}`, id),
    downloadPdf: (id) => http.getPdf(`salesreceipt/${pathId(id)}/pdf`),
    list: (options) => listTransactions(http, "SalesReceipt", options, { party: "customer" }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
