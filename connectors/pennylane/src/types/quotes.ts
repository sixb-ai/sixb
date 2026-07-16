import type {
  PennylaneCollectionLink,
  PennylaneCurrency,
  PennylaneCursorOptions,
  PennylaneDiscount,
  PennylaneEqualityFilterOperator,
  PennylaneIdReference,
  PennylaneIdSort,
  PennylaneLanguage,
  PennylaneListFilterOperator,
  PennylaneQuoteStatus,
  PennylaneResourceLink,
  PennylaneScalarFilterOperator,
  PennylaneVatRate,
} from "./common"

export interface PennylaneQuote {
  readonly id: number
  readonly label: string | null
  readonly quote_number: string
  readonly currency: PennylaneCurrency
  /** Total converted to euros. */
  readonly amount: string
  readonly currency_amount: string
  readonly currency_amount_before_tax: string
  readonly exchange_rate: string
  readonly date: string | null
  readonly deadline: string | null
  readonly currency_tax: string
  readonly tax: string
  readonly language: PennylaneLanguage
  readonly status: PennylaneQuoteStatus
  readonly discount: PennylaneDiscount
  /** Signed PDF URL that expires after 30 minutes. */
  readonly public_file_url: string | null
  readonly filename: string | null
  readonly special_mention: string | null
  readonly customer: PennylaneResourceLink | null
  readonly invoice_line_sections: PennylaneCollectionLink
  readonly invoice_lines: PennylaneCollectionLink
  readonly linked_invoices: PennylaneCollectionLink
  readonly pdf_invoice_free_text: string
  readonly pdf_invoice_subject: string
  readonly pdf_description: string | null
  readonly quote_template: PennylaneIdReference | null
  readonly appendices: PennylaneCollectionLink
  readonly external_reference: string
  readonly archived_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

export type PennylaneQuoteFilter =
  | {
      readonly field: "id" | "customer_id"
      readonly operator: PennylaneScalarFilterOperator
      readonly value: number | string
    }
  | {
      readonly field: "id" | "customer_id"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly (number | string)[]
    }
  | {
      readonly field: "status"
      readonly operator: PennylaneEqualityFilterOperator
      readonly value: PennylaneQuoteStatus
    }
  | {
      readonly field: "status"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly PennylaneQuoteStatus[]
    }

export interface PennylaneQuoteListOptions extends PennylaneCursorOptions {
  readonly filter?: readonly PennylaneQuoteFilter[]
  readonly sort?: PennylaneIdSort
}

export interface PennylaneQuoteChildListOptions extends PennylaneCursorOptions {
  readonly sort?: PennylaneIdSort
}

export interface PennylaneQuoteInvoiceLineSection {
  readonly id: number
  readonly title: string | null
  readonly description: string | null
  readonly rank: number
  readonly created_at: string
  readonly updated_at: string
}

export interface PennylaneQuoteInvoiceLine {
  readonly id: number
  readonly label: string
  readonly unit: string | null
  readonly quantity: string
  readonly amount: string
  readonly currency_amount: string
  readonly description: string
  readonly product: PennylaneResourceLink | null
  readonly vat_rate: PennylaneVatRate
  readonly currency_amount_before_tax: string
  readonly currency_tax: string
  readonly tax: string
  readonly raw_currency_unit_price: string
  readonly discount: PennylaneDiscount
  readonly section_rank: number | null
  readonly created_at: string
  readonly updated_at: string
}

export interface PennylaneQuoteAppendix {
  readonly id: number
  readonly url: string
  readonly filename: string
  readonly created_at: string
  readonly updated_at: string
}

export interface PennylaneCreateQuoteSectionInput {
  readonly title?: string
  readonly description?: string
  readonly rank: number
}

interface PennylaneCreateQuoteLineBase {
  readonly quantity: number
  readonly label?: string
  readonly ledger_account_id?: number
  readonly raw_currency_unit_price?: string
  readonly unit?: string
  readonly vat_rate?: PennylaneVatRate
  readonly description?: string | null
  readonly section_rank?: number
  readonly discount?: PennylaneDiscount
}

export interface PennylaneCreateQuoteProductLineInput extends PennylaneCreateQuoteLineBase {
  readonly product_id: number
}

export interface PennylaneCreateQuoteCustomLineInput
  extends Omit<
    PennylaneCreateQuoteLineBase,
    "label" | "raw_currency_unit_price" | "unit" | "vat_rate"
  > {
  readonly product_id?: never
  readonly label: string
  readonly raw_currency_unit_price: string
  readonly unit: string
  readonly vat_rate: PennylaneVatRate
}

export type PennylaneCreateQuoteLineInput =
  | PennylaneCreateQuoteProductLineInput
  | PennylaneCreateQuoteCustomLineInput

export interface PennylaneCreateQuoteInput {
  readonly date: string
  readonly deadline: string
  readonly customer_id: number
  readonly quote_template_id?: number
  readonly pdf_invoice_free_text?: string | null
  readonly pdf_invoice_subject?: string | null
  readonly pdf_description?: string | null
  readonly currency?: PennylaneCurrency
  readonly special_mention?: string | null
  readonly language?: PennylaneLanguage
  readonly discount?: PennylaneDiscount
  readonly invoice_line_sections?: readonly PennylaneCreateQuoteSectionInput[]
  readonly external_reference?: string
  readonly invoice_lines: readonly PennylaneCreateQuoteLineInput[]
}

export interface PennylaneUpdateQuoteLineInput {
  readonly id: number
  readonly label?: string
  readonly quantity?: number
  readonly ledger_account_id?: number
  readonly raw_currency_unit_price?: string
  readonly unit?: string
  readonly vat_rate?: PennylaneVatRate
  readonly description?: string | null
  readonly product_id?: number
  readonly discount?: PennylaneDiscount
  readonly section_rank?: number
}

export interface PennylaneDeleteQuoteLineInput {
  readonly id: number
}

export interface PennylaneUpdateQuoteLinesInput {
  readonly create?: readonly PennylaneCreateQuoteLineInput[]
  readonly update?: readonly PennylaneUpdateQuoteLineInput[]
  readonly delete?: readonly PennylaneDeleteQuoteLineInput[]
}

export interface PennylaneUpdateQuoteInput {
  readonly date?: string
  readonly deadline?: string
  readonly customer_id?: number
  readonly quote_template_id?: number
  readonly pdf_invoice_free_text?: string | null
  readonly pdf_invoice_subject?: string | null
  readonly pdf_description?: string | null
  readonly currency?: PennylaneCurrency
  readonly special_mention?: string | null
  readonly discount?: PennylaneDiscount
  readonly language?: PennylaneLanguage
  readonly invoice_lines?: PennylaneUpdateQuoteLinesInput
  readonly external_reference?: string
}

export interface PennylaneUpdateQuoteStatusInput {
  readonly status: PennylaneQuoteStatus
}

export interface PennylaneSendQuoteByEmailInput {
  readonly recipients?: readonly string[]
}

export interface PennylaneUploadQuoteAppendixInput {
  readonly file: Blob
  /** Filename sent in the multipart request. Defaults to File.name when available. */
  readonly filename?: string
}
