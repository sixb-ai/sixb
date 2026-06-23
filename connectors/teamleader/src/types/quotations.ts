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

export interface TeamleaderQuotationExpiry {
  readonly valid_until?: string
  readonly expires_after?: {
    readonly value?: number
    readonly unit?: string
  }
}
