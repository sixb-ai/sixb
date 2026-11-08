import type { createQuickBooksHttp } from "../http"
import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksRefundReceiptListOptions } from "../types/query"
import type { QuickBooksRefundReceipt } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksRefundReceiptCreate,
  QuickBooksRefundReceiptSendOptions,
  QuickBooksRefundReceiptUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksWriteHttp,
  revision,
  sendEntity,
  updateEntity,
  writeEntity,
} from "../write"
import { salesLines } from "../write-validation"

export interface QuickBooksRefundReceiptsResource {
  create(
    input: QuickBooksRefundReceiptCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksRefundReceipt>
  update(
    input: QuickBooksRefundReceiptUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksRefundReceipt>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  void(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksRefundReceipt>
  send(id: string, options?: QuickBooksRefundReceiptSendOptions): Promise<QuickBooksRefundReceipt>
  /** GET /v3/company/{realmId}/refundreceipt/{id} */
  get(id: string): Promise<QuickBooksRefundReceipt>
  /** GET /v3/company/{realmId}/refundreceipt/{id}/pdf */
  downloadPdf(id: string): Promise<Uint8Array<ArrayBuffer>>
  list(
    options?: QuickBooksRefundReceiptListOptions
  ): Promise<QuickBooksPage<QuickBooksRefundReceipt>>
  listAll(options?: QuickBooksRefundReceiptListOptions): AsyncIterable<QuickBooksRefundReceipt>
}

export function createRefundReceiptsResource(
  http: QuickBooksWriteHttp & Pick<Awaited<ReturnType<typeof createQuickBooksHttp>>, "getPdf">
): QuickBooksRefundReceiptsResource {
  const resource: QuickBooksRefundReceiptsResource = {
    async create(input, options) {
      createInput(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      nonEmpty(input.DepositToAccountRef?.value, "DepositToAccountRef.value")
      salesLines(input.Line)
      return writeEntity(http, "RefundReceipt", "refundreceipt", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.DepositToAccountRef !== undefined)
        nonEmpty(input.DepositToAccountRef.value, "DepositToAccountRef.value")
      if (input.Line !== undefined) salesLines(input.Line)
      return updateEntity(http, "RefundReceipt", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "RefundReceipt", input, options),
    // Unlike SalesReceipt, include=void is accepted here as a no-op update (verified live).
    void: async (input, options) =>
      writeEntity(http, "RefundReceipt", "refundreceipt?operation=void", revision(input), options, {
        id: input.Id,
      }),
    send: async (id, options) => sendEntity(http, "RefundReceipt", id, options),
    get: (id) => readEntity(http, "RefundReceipt", `refundreceipt/${pathId(id)}`, id),
    downloadPdf: (id) => http.getPdf(`refundreceipt/${pathId(id)}/pdf`),
    list: (options) => listTransactions(http, "RefundReceipt", options, { party: "customer" }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
