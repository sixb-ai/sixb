import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import { buildListQuery } from "../query"
import type {
  PennylaneCreateQuoteInput,
  PennylaneCursorOptions,
  PennylaneCursorPage,
  PennylaneQuote,
  PennylaneQuoteAppendix,
  PennylaneQuoteChildListOptions,
  PennylaneQuoteInvoiceLine,
  PennylaneQuoteInvoiceLineSection,
  PennylaneQuoteListOptions,
  PennylaneSendQuoteByEmailInput,
  PennylaneUpdateQuoteInput,
  PennylaneUpdateQuoteStatusInput,
  PennylaneUploadQuoteAppendixInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

export interface QuotesResource {
  /** `GET /quotes` */
  list(options?: PennylaneQuoteListOptions): Promise<PennylaneCursorPage<PennylaneQuote>>
  listAll(options?: PennylaneQuoteListOptions): AsyncIterable<PennylaneQuote>
  /** `GET /quotes/{id}` */
  get(id: number): Promise<PennylaneQuote>
  /** `GET /quotes/{quote_id}/invoice_line_sections` */
  listInvoiceLineSections(
    quoteId: number,
    options?: PennylaneQuoteChildListOptions
  ): Promise<PennylaneCursorPage<PennylaneQuoteInvoiceLineSection>>
  listAllInvoiceLineSections(
    quoteId: number,
    options?: PennylaneQuoteChildListOptions
  ): AsyncIterable<PennylaneQuoteInvoiceLineSection>
  /** `GET /quotes/{quote_id}/invoice_lines` */
  listInvoiceLines(
    quoteId: number,
    options?: PennylaneQuoteChildListOptions
  ): Promise<PennylaneCursorPage<PennylaneQuoteInvoiceLine>>
  listAllInvoiceLines(
    quoteId: number,
    options?: PennylaneQuoteChildListOptions
  ): AsyncIterable<PennylaneQuoteInvoiceLine>
  /** `GET /quotes/{quote_id}/appendices` */
  listAppendices(
    quoteId: number,
    options?: PennylaneCursorOptions
  ): Promise<PennylaneCursorPage<PennylaneQuoteAppendix>>
  listAllAppendices(
    quoteId: number,
    options?: PennylaneCursorOptions
  ): AsyncIterable<PennylaneQuoteAppendix>
  /** `POST /quotes` */
  create(input: PennylaneCreateQuoteInput): Promise<PennylaneQuote>
  /** `POST /quotes/{quote_id}/appendices` */
  uploadAppendix(
    quoteId: number,
    input: PennylaneUploadQuoteAppendixInput
  ): Promise<PennylaneQuoteAppendix>
  /** `POST /quotes/{id}/send_by_email` */
  sendByEmail(id: number, input?: PennylaneSendQuoteByEmailInput): Promise<void>
  /** `PUT /quotes/{id}` */
  update(id: number, input: PennylaneUpdateQuoteInput): Promise<PennylaneQuote>
  /** `PUT /quotes/{id}/update_status` */
  updateStatus(id: number, input: PennylaneUpdateQuoteStatusInput): Promise<PennylaneQuote>
}

export function createQuotesResource(http: PennylaneHttp): QuotesResource {
  const resource: QuotesResource = {
    list(options) {
      assertCursorOptions(options, 100)
      return http.get("quotes", buildListQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get(`quotes/${pathId(id, "quote id")}`)
    },
    listInvoiceLineSections(quoteId, options) {
      assertCursorOptions(options, 100)
      return http.get(
        `quotes/${pathId(quoteId, "quote id")}/invoice_line_sections`,
        buildListQuery(options)
      )
    },
    listAllInvoiceLineSections(quoteId, options) {
      return listAllCursor(
        (pageOptions) => resource.listInvoiceLineSections(quoteId, pageOptions),
        options
      )
    },
    listInvoiceLines(quoteId, options) {
      assertCursorOptions(options, 100)
      return http.get(
        `quotes/${pathId(quoteId, "quote id")}/invoice_lines`,
        buildListQuery(options)
      )
    },
    listAllInvoiceLines(quoteId, options) {
      return listAllCursor(
        (pageOptions) => resource.listInvoiceLines(quoteId, pageOptions),
        options
      )
    },
    listAppendices(quoteId, options) {
      assertCursorOptions(options, 100)
      return http.get(`quotes/${pathId(quoteId, "quote id")}/appendices`, buildListQuery(options))
    },
    listAllAppendices(quoteId, options) {
      return listAllCursor((pageOptions) => resource.listAppendices(quoteId, pageOptions), options)
    },
    create(input) {
      return http.post("quotes", input)
    },
    uploadAppendix(quoteId, input) {
      return http.post(`quotes/${pathId(quoteId, "quote id")}/appendices`, appendixFormData(input))
    },
    sendByEmail(id, input = {}) {
      return http.post(`quotes/${pathId(id, "quote id")}/send_by_email`, input)
    },
    update(id, input) {
      return http.put(`quotes/${pathId(id, "quote id")}`, input)
    },
    updateStatus(id, input) {
      return http.put(`quotes/${pathId(id, "quote id")}/update_status`, input)
    },
  }

  return resource
}

function appendixFormData(input: PennylaneUploadQuoteAppendixInput): FormData {
  if (!(input?.file instanceof Blob)) {
    throw new Error("[SixbPennylane] appendix file must be a Blob or File.")
  }
  if (input.file.size === 0) {
    throw new Error("[SixbPennylane] appendix file must not be empty.")
  }
  if (input.filename !== undefined && !input.filename.trim()) {
    throw new Error("[SixbPennylane] appendix filename must not be empty when provided.")
  }

  const form = new FormData()
  const filename =
    input.filename ??
    (typeof File !== "undefined" && input.file instanceof File ? input.file.name : undefined)

  if (filename) {
    form.append("file", input.file, filename)
  } else {
    form.append("file", input.file)
  }

  return form
}
