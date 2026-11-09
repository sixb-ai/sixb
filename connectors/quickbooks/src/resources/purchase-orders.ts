import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksPurchaseOrderListOptions } from "../types/query"
import type { QuickBooksPurchaseOrder } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksPurchaseOrderCreate,
  QuickBooksPurchaseOrderSendOptions,
  QuickBooksPurchaseOrderUpdate,
  QuickBooksRevision,
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
  writeEntity,
} from "../write"
import { expenseLines } from "../write-validation"

export interface QuickBooksPurchaseOrdersResource {
  create(
    input: QuickBooksPurchaseOrderCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPurchaseOrder>
  update(
    input: QuickBooksPurchaseOrderUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPurchaseOrder>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  send(id: string, options?: QuickBooksPurchaseOrderSendOptions): Promise<QuickBooksPurchaseOrder>
  /** GET /v3/company/{realmId}/purchaseorder/{id} */
  get(id: string): Promise<QuickBooksPurchaseOrder>
  /** GET /v3/company/{realmId}/purchaseorder/{id}/pdf */
  downloadPdf(id: string): Promise<Uint8Array<ArrayBuffer>>
  list(
    options?: QuickBooksPurchaseOrderListOptions
  ): Promise<QuickBooksPage<QuickBooksPurchaseOrder>>
  listAll(options?: QuickBooksPurchaseOrderListOptions): AsyncIterable<QuickBooksPurchaseOrder>
}

export function createPurchaseOrdersResource(
  http: QuickBooksPdfHttp
): QuickBooksPurchaseOrdersResource {
  const resource: QuickBooksPurchaseOrdersResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
      expenseLines(input.Line)
      poStatus(input.POStatus)
      return writeEntity(http, "PurchaseOrder", "purchaseorder", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.VendorRef !== undefined) nonEmpty(input.VendorRef.value, "VendorRef.value")
      if (input.Line !== undefined) expenseLines(input.Line)
      poStatus(input.POStatus)
      return updateEntity(http, "PurchaseOrder", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "PurchaseOrder", input, options),
    send: async (id, options) => sendEntity(http, "PurchaseOrder", id, options),
    get: (id) => readEntity(http, "PurchaseOrder", `purchaseorder/${pathId(id)}`, id),
    downloadPdf: (id) => http.getPdf(`purchaseorder/${pathId(id)}/pdf`),
    list: (options) => listTransactions(http, "PurchaseOrder", options, { party: "vendor" }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function poStatus(value: unknown) {
  if (value !== undefined && value !== "Open" && value !== "Closed")
    throw new Error("[SixbQuickBooks] POStatus must be Open or Closed.")
}
