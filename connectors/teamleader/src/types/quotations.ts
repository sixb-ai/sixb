import type {
  TeamleaderCurrencyCode,
  TeamleaderCurrencyExchangeRate,
  TeamleaderJsonObject,
  TeamleaderMoney,
  TeamleaderPage,
  TeamleaderTypeAndId,
} from "./common"

export interface TeamleaderQuotationListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
  }
  readonly page?: TeamleaderPage
}

export interface TeamleaderQuotationListItem {
  readonly id: string
  readonly deal?: TeamleaderTypeAndId<"deal">
  readonly currency_exchange_rate?: TeamleaderCurrencyExchangeRate
  readonly total?: TeamleaderMoney
  readonly created_at?: string
  readonly updated_at?: string
  readonly status?: string
  readonly name?: string
  readonly expiry?: TeamleaderQuotationExpiry
}

export interface TeamleaderQuotation extends TeamleaderQuotationListItem {
  readonly grouped_lines?: readonly TeamleaderJsonObject[]
  readonly currency?: TeamleaderCurrencyCode
  readonly text?: string | null
  readonly discounts?: readonly TeamleaderJsonObject[]
  readonly document_template?: TeamleaderTypeAndId<"documentTemplate">
}

export interface TeamleaderQuotationCreateRequest {
  readonly deal_id: string
  readonly currency?: TeamleaderQuotationCurrencyRequest
  readonly grouped_lines?: readonly TeamleaderQuotationGroupedLineRequest[]
  readonly discounts?: readonly TeamleaderQuotationCommercialDiscount[]
  readonly text?: string
  readonly document_template_id?: string
  readonly expiry?: TeamleaderQuotationExpiryRequest
}

export interface TeamleaderQuotationUpdateRequest
  extends Omit<TeamleaderQuotationCreateRequest, "deal_id" | "text"> {
  readonly id: string
  readonly text?: string | null
}

export interface TeamleaderQuotationDownloadRequest {
  readonly id: string
  readonly format: "pdf"
}

export interface TeamleaderQuotationDownload {
  readonly location?: string
  readonly expires?: string
}

export interface TeamleaderQuotationSendRequest {
  readonly quotations: readonly string[]
  readonly from?: TeamleaderQuotationEmailSender
  readonly recipients: TeamleaderQuotationRecipients
  readonly subject: string
  readonly content: string
  readonly attachments?: readonly string[]
  readonly language: TeamleaderQuotationLanguage
}

export interface TeamleaderQuotationExpiry {
  readonly valid_until?: string
  readonly expires_after?: {
    readonly value?: number
    readonly unit?: string
  }
}

export interface TeamleaderQuotationCurrencyRequest {
  readonly code: TeamleaderCurrencyCode
  readonly exchange_rate?: number
}

export interface TeamleaderQuotationGroupedLineRequest {
  readonly section?: {
    readonly title: string
  }
  readonly line_items: readonly TeamleaderQuotationLineItemRequest[]
}

export interface TeamleaderQuotationLineItemRequest {
  readonly quantity: number
  readonly description: string
  readonly extended_description?: string | null
  readonly unit_of_measure_id?: string | null
  readonly unit_price: TeamleaderQuotationAmountWithTax
  readonly tax_rate_id: string
  readonly discount?: TeamleaderQuotationLineDiscount
  readonly product_id?: string
  readonly purchase_price?: TeamleaderMoney | null
  readonly periodicity?: TeamleaderQuotationPeriodicity | null
}

export interface TeamleaderQuotationAmountWithTax {
  readonly amount: number
  readonly tax: "excluding"
}

export interface TeamleaderQuotationLineDiscount {
  readonly value: number
  readonly type: "percentage"
}

export interface TeamleaderQuotationCommercialDiscount extends TeamleaderQuotationLineDiscount {
  readonly description?: string
}

export type TeamleaderQuotationPeriodicity =
  | { readonly unit: "week"; readonly period: 1 | 2 }
  | { readonly unit: "month"; readonly period: 1 | 2 | 3 | 4 | 6 }
  | { readonly unit: "year"; readonly period: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 }

export interface TeamleaderQuotationExpiryRequest {
  readonly expires_after?: string | null
  readonly action_after_expiry: "lock" | "none"
}

export interface TeamleaderQuotationEmailSender {
  readonly sender: TeamleaderTypeAndId<"user" | "department">
  readonly email_address: string
}

export interface TeamleaderQuotationRecipients {
  readonly to: readonly TeamleaderQuotationEmailAddress[]
  readonly cc?: readonly TeamleaderQuotationEmailAddress[]
  readonly bcc?: readonly TeamleaderQuotationEmailAddress[]
}

export interface TeamleaderQuotationEmailAddress {
  readonly customer?: TeamleaderTypeAndId<"contact" | "company"> | null
  readonly email_address: string
}

export type TeamleaderQuotationLanguage =
  | "en"
  | "nl"
  | "fr"
  | "ch"
  | "jp"
  | "de"
  | "es"
  | "pt"
  | "it"
  | "gr"
  | "tr"
  | "cs"
  | "so"
  | "sk"
  | "ru"
  | "ko"
  | "ir"
  | "iq"
  | "hu"
  | "gh"
  | "bg"
  | "bs"
  | "br"
  | "ar"
  | "ag"
  | "al"
  | "af"
  | "ro"
  | "pl"
  | "ca"
  | "da"
  | "uk"
  | "no"
  | "fi"
  | "sv"
