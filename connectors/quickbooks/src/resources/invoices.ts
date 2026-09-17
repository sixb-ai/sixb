import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksInvoiceListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksInvoice } from "../types/transactions"
import type {
  QuickBooksInvoiceCreate,
  QuickBooksInvoiceDeleteResult,
  QuickBooksInvoiceSendOptions,
  QuickBooksInvoiceUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import { createInput, type QuickBooksWriteHttp, revision, writeEntity } from "../write"
import { salesLines } from "../write-validation"

export interface QuickBooksInvoicesResource {
  create(
    input: QuickBooksInvoiceCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksInvoice>
  update(
    input: QuickBooksInvoiceUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksInvoice>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksInvoiceDeleteResult>
  void(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksInvoice>
  send(id: string, options?: QuickBooksInvoiceSendOptions): Promise<QuickBooksInvoice>
  /** GET /v3/company/{realmId}/invoice/{id} */
  get(id: string): Promise<QuickBooksInvoice>
  list(options?: QuickBooksInvoiceListOptions): Promise<QuickBooksPage<QuickBooksInvoice>>
  listAll(options?: QuickBooksInvoiceListOptions): AsyncIterable<QuickBooksInvoice>
}

export function createInvoicesResource(http: QuickBooksWriteHttp): QuickBooksInvoicesResource {
  const resource: QuickBooksInvoicesResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      salesLines(input.Line)
      return writeEntity(http, "Invoice", "invoice", input, options)
    },
    async update(input, options) {
      const identity = revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.Line !== undefined) salesLines(input.Line)
      return writeEntity(
        http,
        "Invoice",
        "invoice",
        { ...input, ...identity, sparse: true },
        options,
        { id: input.Id }
      )
    },
    async delete(input, options) {
      return writeEntity(http, "Invoice", "invoice?operation=delete", revision(input), options, {
        id: input.Id,
        deleted: true,
      })
    },
    async void(input, options) {
      return writeEntity(http, "Invoice", "invoice?operation=void", revision(input), options, {
        id: input.Id,
      })
    },
    async send(id, options = {}) {
      let path = `invoice/${pathId(id)}/send`
      if (options.sendTo !== undefined) {
        nonEmpty(options.sendTo, "sendTo")
        path += `?${new URLSearchParams({ sendTo: options.sendTo })}`
      }
      return writeEntity(http, "Invoice", path, undefined, options, { id }, true)
    },
    get: (id) => readEntity(http, "Invoice", `invoice/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Invoice", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
