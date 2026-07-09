import type { TeamleaderPage, TeamleaderSort, TeamleaderTypeAndId } from "./common"

export interface TeamleaderProductCategoryListRequest {
  readonly filter?: {
    readonly department_id?: string
  }
}

export interface TeamleaderProductCategory {
  readonly id: string
  readonly name?: string
  readonly ledgers?: readonly {
    readonly department?: TeamleaderTypeAndId<"department">
    readonly ledger_account_number?: string
  }[]
}

export interface TeamleaderPriceListListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
  }
}

export interface TeamleaderPriceList {
  readonly id: string
  readonly name?: string
  readonly calculation_method?: "manual" | "based_on_price_list" | "based_on_purchase_price"
}

export interface TeamleaderTaxRateListRequest {
  readonly filter?: {
    readonly department_id?: string
  }
  readonly page?: TeamleaderPage
  readonly sort?: readonly TeamleaderSort<"department_id" | "rate" | "description">[]
}

export interface TeamleaderTaxRate {
  readonly id: string
  readonly description?: string
  readonly rate?: number
  readonly department?: TeamleaderTypeAndId<"department">
}

export interface TeamleaderUnitOfMeasure {
  readonly id: string
  readonly name?: string
}

export interface TeamleaderPaymentTerm {
  readonly id: string
  readonly type?: "cash" | "end_of_month" | "after_invoice_date"
  readonly days?: number
}

export interface TeamleaderPaymentTermsMeta {
  readonly default?: string
}

export interface TeamleaderPaymentMethodListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
    readonly status?: readonly TeamleaderRecordStatus[]
  }
  readonly page?: TeamleaderPage
}

export interface TeamleaderPaymentMethod {
  readonly id: string
  readonly name?: string
  readonly status: TeamleaderRecordStatus
}

export interface TeamleaderDocumentTemplateListRequest {
  readonly filter: {
    readonly department_id: string
    readonly document_type: TeamleaderDocumentType
    readonly status?: readonly TeamleaderRecordStatus[]
  }
}

export interface TeamleaderDocumentTemplate {
  readonly id: string
  readonly department?: TeamleaderTypeAndId<"department">
  readonly document_type?: TeamleaderDocumentType
  readonly is_default?: boolean
  readonly name?: string
  readonly status?: TeamleaderRecordStatus
}

export type TeamleaderRecordStatus = "active" | "archived"

export type TeamleaderDocumentType =
  | "delivery_note"
  | "invoice"
  | "order"
  | "order_confirmation"
  | "quotation"
  | "timetracking_report"
  | "workorder"
