import type {
  TeamleaderAddress,
  TeamleaderCurrencyCode,
  TeamleaderEmail,
  TeamleaderInfoRequest,
  TeamleaderJsonObject,
  TeamleaderPage,
  TeamleaderPrimaryEmailFilter,
  TeamleaderSort,
  TeamleaderTelephone,
  TeamleaderTypeAndId,
} from "./common"
import type { TeamleaderCustomField } from "./custom-fields"

export interface TeamleaderCompanyInfoRequest extends TeamleaderInfoRequest {
  /** Comma-separated list. Documented values: `related_companies`, `related_contacts`. */
  readonly includes?: string
}

export interface TeamleaderCompanyListRequest {
  readonly filter?: {
    readonly email?: TeamleaderPrimaryEmailFilter
    readonly ids?: readonly string[]
    readonly term?: string
    readonly updated_since?: string
    readonly tags?: readonly string[]
    readonly vat_number?: string
    readonly national_identification_number?: string
    readonly status?: "active" | "deactivated"
    readonly marketing_mails_consent?: boolean
  }
  readonly page?: TeamleaderPage
  readonly sort?: readonly TeamleaderSort<"name" | "added_at" | "updated_at">[]
  /** Comma-separated list. Documented values: `custom_fields`, `price_list`. */
  readonly includes?: string
}

export interface TeamleaderCompanyListItem {
  readonly id: string
  readonly name?: string
  readonly status?: "active" | "deactivated"
  readonly business_type?: TeamleaderTypeAndId<"businessType">
  readonly vat_number?: string
  readonly national_identification_number?: string
  readonly emails?: readonly TeamleaderEmail[]
  readonly telephones?: readonly TeamleaderTelephone[]
  readonly website?: string
  readonly primary_address?: TeamleaderAddress
  readonly iban?: string
  readonly bic?: string
  readonly language?: string
  readonly preferred_currency?: TeamleaderCurrencyCode
  readonly payment_term?: TeamleaderTypeAndId<"paymentTerm">
  readonly invoicing_preferences?: TeamleaderJsonObject
  readonly responsible_user?: TeamleaderTypeAndId<"user">
  readonly added_at?: string
  readonly updated_at?: string
  readonly web_url?: string
  readonly tags?: readonly string[]
  readonly marketing_mails_consent?: boolean
  readonly custom_fields?: readonly TeamleaderCustomField[]
  readonly price_list?: TeamleaderTypeAndId<"priceList">
}

export interface TeamleaderCompany extends Omit<TeamleaderCompanyListItem, "primary_address"> {
  readonly addresses?: readonly TeamleaderAddress[]
  readonly remarks?: string
  readonly related_companies?: readonly TeamleaderTypeAndId<"company">[]
  readonly related_contacts?: readonly {
    readonly type?: "contact"
    readonly id?: string
    readonly position?: string | null
    readonly secondary_position?: string | null
    readonly division?: string | null
    readonly is_decision_maker?: boolean
  }[]
}
