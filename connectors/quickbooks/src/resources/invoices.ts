import type { createQuickBooksHttp } from "../http"
import { allowedOptions, listAll, listTransactions, pathId, readEntity } from "../query"
import type {
  QuickBooksInvoiceLinkOptions,
  QuickBooksInvoiceListOptions,
  QuickBooksPage,
} from "../types/query"
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
import { linkedTransactions, salesLines } from "../write-validation"

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
  /** GET /v3/company/{realmId}/invoice/{id}, optionally with `include=invoiceLink`. */
  get(id: string, options?: QuickBooksInvoiceLinkOptions): Promise<QuickBooksInvoice>
  /** GET /v3/company/{realmId}/invoice/{id}/pdf — PDF bytes using company form styles. */
  downloadPdf(id: string): Promise<Uint8Array<ArrayBuffer>>
  list(options?: QuickBooksInvoiceListOptions): Promise<QuickBooksPage<QuickBooksInvoice>>
  listAll(options?: QuickBooksInvoiceListOptions): AsyncIterable<QuickBooksInvoice>
}

export function createInvoicesResource(
  http: QuickBooksWriteHttp & Pick<Awaited<ReturnType<typeof createQuickBooksHttp>>, "getPdf">
): QuickBooksInvoicesResource {
  const resource: QuickBooksInvoicesResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      salesLines(input.Line)
      linkedTransactions(input.LinkedTxn)
      return writeEntity(http, "Invoice", "invoice", input, options)
    },
    async update(input, options) {
      const identity = revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.Line !== undefined) salesLines(input.Line)
      linkedTransactions(input.LinkedTxn)
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
    get(id, options = {}) {
      const path = `invoice/${pathId(id)}`
      return readEntity(
        http,
        "Invoice",
        `${path}${invoiceLink(options) ? "?include=invoiceLink" : ""}`,
        id
      )
    },
    downloadPdf: (id) => http.getPdf(`invoice/${pathId(id)}/pdf`),
    async list(options = {}) {
      const { includeInvoiceLink, ...query } = options
      return listTransactions(
        http,
        "Invoice",
        query,
        { party: "customer" },
        { params: invoiceLink({ includeInvoiceLink }) ? { include: "invoiceLink" } : undefined }
      )
    },
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function invoiceLink(options: QuickBooksInvoiceLinkOptions): boolean {
  allowedOptions(options, "invoice read", ["includeInvoiceLink"])
  if (options.includeInvoiceLink !== undefined && typeof options.includeInvoiceLink !== "boolean")
    throw new Error("[SixbQuickBooks] includeInvoiceLink must be a boolean.")
  return options.includeInvoiceLink === true
}
