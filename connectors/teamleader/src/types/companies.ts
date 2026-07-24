import type {
  TeamleaderCurrencyCode,
  TeamleaderInfoRequest,
  TeamleaderPage,
  TeamleaderPrimaryEmailFilter,
  TeamleaderSort,
  TeamleaderTypeAndId,
} from "./common"
import type { TeamleaderCustomField, TeamleaderCustomFieldInput } from "./custom-fields"

export type TeamleaderCompanyStatus = "active" | "deactivated"

export type TeamleaderCompanyEmailType = "primary" | "invoicing"

export type TeamleaderCompanyTelephoneType = "phone" | "fax"

export type TeamleaderCompanyAddressType = "primary" | "invoicing" | "delivery" | "visiting"

export interface TeamleaderCompanyEmail {
  readonly type?: TeamleaderCompanyEmailType
  readonly email?: string
}

export interface TeamleaderCompanyTelephone {
  readonly type?: TeamleaderCompanyTelephoneType
  readonly number?: string
}

export interface TeamleaderCompanyAddressValue {
  readonly addressee?: string
  readonly line_1?: string | null
  readonly postal_code?: string | null
  readonly city?: string | null
  readonly country?: string
  readonly area_level_two?: TeamleaderTypeAndId<"area_level_two"> | null
}

export interface TeamleaderCompanyAddress {
  readonly type?: TeamleaderCompanyAddressType
  readonly address?: TeamleaderCompanyAddressValue
}

export interface TeamleaderCompanyPaymentTerm {
  readonly type?: "cash" | "end_of_month" | "after_invoice_date"
  readonly days?: number
}

export interface TeamleaderCompanyInvoicingPreferences {
  readonly electronic_invoicing_address?: string | null
}

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
    readonly status?: TeamleaderCompanyStatus
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
  readonly status?: TeamleaderCompanyStatus
  readonly business_type?: TeamleaderTypeAndId<"businessType">
  readonly vat_number?: string
  readonly national_identification_number?: string
  readonly emails?: readonly TeamleaderCompanyEmail[]
  readonly telephones?: readonly TeamleaderCompanyTelephone[]
  readonly website?: string
  readonly primary_address?: TeamleaderCompanyAddressValue
  readonly iban?: string
  readonly bic?: string
  readonly language?: string
  readonly preferred_currency?: TeamleaderCurrencyCode | null
  readonly payment_term?: TeamleaderCompanyPaymentTerm | null
  readonly invoicing_preferences?: TeamleaderCompanyInvoicingPreferences
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
  readonly addresses?: readonly TeamleaderCompanyAddress[]
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

export interface TeamleaderCompanyEmailInput {
  readonly type: TeamleaderCompanyEmailType
  readonly email: string
}

export interface TeamleaderCompanyTelephoneInput {
  readonly type: TeamleaderCompanyTelephoneType
  readonly number: string
}

export interface TeamleaderCompanyAddressInput {
  readonly type: TeamleaderCompanyAddressType
  readonly address: {
    readonly addressee?: string
    /** Teamleader expects structured address fields, not a generic nested address. */
    readonly address?: never
    readonly line_1: string | null
    readonly postal_code: string | null
    readonly city: string | null
    readonly country: string
    readonly area_level_two_id?: string
  }
}

export interface TeamleaderCompanyAddRequest {
  readonly name: string
  readonly business_type_id?: string
  readonly vat_number?: string
  readonly national_identification_number?: string
  readonly emails?: readonly TeamleaderCompanyEmailInput[]
  readonly telephones?: readonly TeamleaderCompanyTelephoneInput[]
  readonly website?: string
  readonly addresses?: readonly TeamleaderCompanyAddressInput[]
  readonly iban?: string
  readonly bic?: string
  readonly language?: string
  readonly responsible_user_id?: string
  readonly remarks?: string
  readonly tags?: readonly string[]
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
  readonly marketing_mails_consent?: boolean
  readonly preferred_currency?: TeamleaderCurrencyCode
}

export interface TeamleaderCompanyUpdateRequest {
  readonly id: string
  readonly name?: string
  readonly business_type_id?: string | null
  readonly vat_number?: string | null
  readonly national_identification_number?: string | null
  readonly emails?: readonly TeamleaderCompanyEmailInput[]
  readonly telephones?: readonly TeamleaderCompanyTelephoneInput[]
  readonly website?: string
  readonly addresses?: readonly TeamleaderCompanyAddressInput[]
  readonly iban?: string | null
  readonly bic?: string | null
  readonly language?: string | null
  readonly responsible_user_id?: string | null
  readonly remarks?: string | null
  /** Replaces all existing tags. Use `tag` or `untag` for incremental changes. */
  readonly tags?: readonly string[]
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
  /** Updates only the supplied custom fields instead of replacing the collection. */
  readonly custom_fields_update_strategy?: "partial"
  readonly marketing_mails_consent?: boolean
  readonly preferred_currency?: TeamleaderCurrencyCode | null
}

export interface TeamleaderCompanyTagRequest {
  readonly id: string
  readonly tags: readonly string[]
}

export interface TeamleaderCompanyUploadLogoRequest {
  readonly id: string
  /** A data URL, or `null` to remove the current logo. */
  readonly image: string | null
}
