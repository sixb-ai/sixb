export type TeamleaderAccessTokenResolver = string | (() => Promise<string> | string)

export interface TeamleaderRequestOptions {
  readonly signal?: AbortSignal
}

export interface TeamleaderListAllOptions extends TeamleaderRequestOptions {
  readonly pageSize?: number
}

export interface TeamleaderClientOptions {
  readonly accessToken: TeamleaderAccessTokenResolver
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export interface TeamleaderInfoRequest {
  readonly id: string
}

export interface TeamleaderListResponse<TItem, TMeta = TeamleaderPaginationMeta> {
  readonly data: readonly TItem[]
  readonly meta?: TMeta
  readonly included?: TeamleaderIncluded
}

export interface TeamleaderSingleResponse<TItem> {
  readonly data: TItem
  readonly included?: TeamleaderIncluded
}

export interface TeamleaderPaginationMeta {
  readonly page?: {
    readonly size?: number
    readonly number?: number
  }
  readonly matches?: number
}

export type TeamleaderIncluded = Readonly<Record<string, readonly TeamleaderJsonObject[]>>

export type TeamleaderJsonValue =
  | string
  | number
  | boolean
  | null
  | TeamleaderJsonObject
  | readonly TeamleaderJsonValue[]

export interface TeamleaderJsonObject {
  readonly [key: string]: TeamleaderJsonValue
}

export interface TeamleaderPage {
  readonly size?: number
  readonly number?: number
}

export interface TeamleaderSort<TField extends string = string> {
  readonly field: TField
  readonly order?: "asc" | "desc"
}

export interface TeamleaderTypeAndId<TType extends string = string> {
  readonly id: string
  readonly type: TType
}

export type TeamleaderCurrencyCode =
  | "BAM"
  | "CAD"
  | "CHF"
  | "CLP"
  | "CNY"
  | "COP"
  | "CZK"
  | "DKK"
  | "EUR"
  | "GBP"
  | "INR"
  | "ISK"
  | "JPY"
  | "MAD"
  | "MXN"
  | "NOK"
  | "PEN"
  | "PLN"
  | "RON"
  | "SEK"
  | "TRY"
  | "USD"
  | "ZAR"

export interface TeamleaderMoney {
  readonly amount: number
  readonly currency: TeamleaderCurrencyCode
}

export interface TeamleaderCurrencyExchangeRate {
  readonly from?: TeamleaderCurrencyCode
  readonly to?: TeamleaderCurrencyCode
  readonly rate?: number
}

export interface TeamleaderPrimaryEmailFilter {
  readonly type: "primary"
  readonly email: string
}

export interface TeamleaderEmail {
  readonly type?: string
  readonly email?: string
}

export interface TeamleaderTelephone {
  readonly type?: string
  readonly number?: string
}

export interface TeamleaderAddress {
  readonly type?: string
  readonly address?: {
    readonly line_1?: string
    readonly postal_code?: string
    readonly city?: string
    readonly country?: string
  }
}

export interface TeamleaderApiErrorItem {
  readonly title?: string
  readonly key?: string
  readonly code?: string
  readonly status?: string
  readonly detail?: string
  readonly meta?: TeamleaderApiErrorMeta
  readonly source?: TeamleaderJsonObject
}

export interface TeamleaderApiErrorMeta {
  readonly field?: string
  readonly [key: string]: TeamleaderJsonValue | undefined
}
