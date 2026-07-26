import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryCreateInvoiceInput,
  MercuryInvoice,
  MercuryInvoiceListOptions,
  MercuryInvoicesResponse,
  MercuryUpdateInvoiceInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

/** Accounts Receivable invoices. */
export interface InvoicesResource {
  /** `GET /ar/invoices` */
  list(options?: MercuryInvoiceListOptions): Promise<MercuryInvoicesResponse>
  /** Cursor iterator over `GET /ar/invoices`. */
  listAll(options?: MercuryInvoiceListOptions): AsyncIterable<MercuryInvoice>
  /** `GET /ar/invoices/{invoiceId}` */
  get(invoiceId: string): Promise<MercuryInvoice>
  /** `POST /ar/invoices` — emails the invoice immediately unless `sendEmailOption` says not to. */
  create(input: MercuryCreateInvoiceInput): Promise<MercuryInvoice>
  /** `POST /ar/invoices/{invoiceId}` — replaces the invoice's editable fields. */
  update(invoiceId: string, input: MercuryUpdateInvoiceInput): Promise<MercuryInvoice>
  /** `POST /ar/invoices/{invoiceId}/cancel` — permanent. */
  cancel(invoiceId: string): Promise<MercuryInvoice>
}

export function createInvoicesResource(http: MercuryHttp): InvoicesResource {
  const resource: InvoicesResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("ar/invoices", cursorQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.invoices, options)
    },
    get(invoiceId) {
      return http.get(`ar/invoices/${pathId(invoiceId, "invoice id")}`)
    },
    create(input) {
      return http.post("ar/invoices", input)
    },
    update(invoiceId, input) {
      return http.post(`ar/invoices/${pathId(invoiceId, "invoice id")}`, input)
    },
    cancel(invoiceId) {
      return http.post(`ar/invoices/${pathId(invoiceId, "invoice id")}/cancel`)
    },
  }

  return resource
}
