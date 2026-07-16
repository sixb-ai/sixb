import type {
  TeamleaderPage,
  TeamleaderPrimaryEmailFilter,
  TeamleaderSort,
  TeamleaderTypeAndId,
} from "./common"
import type { TeamleaderCustomField, TeamleaderCustomFieldInput } from "./custom-fields"

export type TeamleaderContactStatus = "active" | "deactivated"

export type TeamleaderContactGender =
  | "female"
  | "male"
  | "non_binary"
  | "prefers_not_to_say"
  | "unknown"

export type TeamleaderContactTelephoneType = "phone" | "mobile" | "fax"

export type TeamleaderContactAddressType = "primary" | "invoicing" | "delivery" | "visiting"

export type TeamleaderContactAddressInputType = Exclude<TeamleaderContactAddressType, "primary">

export interface TeamleaderContactEmail {
  readonly type?: "primary"
  readonly email?: string
}

export interface TeamleaderContactTelephone {
  readonly type?: TeamleaderContactTelephoneType
  readonly number?: string
}

export interface TeamleaderContactAddressValue {
  readonly addressee?: string
  readonly line_1?: string | null
  readonly postal_code?: string | null
  readonly city?: string | null
  readonly country?: string
  readonly area_level_two?: TeamleaderTypeAndId<"area_level_two"> | null
}

export interface TeamleaderContactAddress {
  readonly type?: TeamleaderContactAddressType
  readonly address?: TeamleaderContactAddressValue
}

export interface TeamleaderContactPaymentTerm {
  readonly type?: "cash" | "end_of_month" | "after_invoice_date"
  readonly days?: number
}

export interface TeamleaderContactInvoicingPreferences {
  readonly electronic_invoicing_address?: string | null
}

export interface TeamleaderContactListRequest {
  readonly filter?: {
    readonly email?: TeamleaderPrimaryEmailFilter
    readonly ids?: readonly string[]
    readonly company_id?: string
    readonly term?: string
    readonly updated_since?: string
    readonly tags?: readonly string[]
    readonly status?: TeamleaderContactStatus
    readonly marketing_mails_consent?: boolean
  }
  readonly page?: TeamleaderPage
  readonly sort?: readonly TeamleaderSort<"added_at" | "name" | "updated_at">[]
  /** Comma-separated list. Documented values: `custom_fields`, `price_list`. */
  readonly includes?: string
}

export interface TeamleaderContactListItem {
  readonly id: string
  readonly first_name?: string
  readonly last_name?: string
  readonly status?: TeamleaderContactStatus
  readonly salutation?: string
  readonly emails?: readonly TeamleaderContactEmail[]
  readonly telephones?: readonly TeamleaderContactTelephone[]
  readonly website?: string
  readonly primary_address?: TeamleaderContactAddressValue
  readonly gender?: TeamleaderContactGender | null
  readonly birthdate?: string
  readonly iban?: string
  readonly bic?: string
  readonly national_identification_number?: string
  readonly language?: string
  readonly payment_term?: TeamleaderContactPaymentTerm | null
  readonly invoicing_preferences?: TeamleaderContactInvoicingPreferences
  readonly tags?: readonly string[]
  readonly added_at?: string
  readonly updated_at?: string
  readonly web_url?: string
  readonly marketing_mails_consent?: boolean
  readonly custom_fields?: readonly TeamleaderCustomField[]
  readonly price_list?: TeamleaderTypeAndId<"priceList">
}

export interface TeamleaderContact extends Omit<TeamleaderContactListItem, "primary_address"> {
  readonly vat_number?: string | null
  readonly addresses?: readonly TeamleaderContactAddress[]
  readonly companies?: readonly TeamleaderContactCompanyLink[]
  readonly remarks?: string
}

export interface TeamleaderContactCompanyLink {
  readonly position?: string
  readonly secondary_position?: string
  readonly division?: string
  readonly decision_maker?: boolean
  readonly company?: TeamleaderTypeAndId<"company">
}

export interface TeamleaderContactEmailInput {
  readonly type: "primary"
  readonly email: string
}

export interface TeamleaderContactEmailUpdateInput {
  readonly type: "primary"
  readonly email: string | null
}

export interface TeamleaderContactTelephoneInput {
  readonly type: TeamleaderContactTelephoneType
  readonly number: string
}

export interface TeamleaderContactAddressInput {
  readonly type: TeamleaderContactAddressInputType
  readonly address: {
    readonly addressee?: string
    /** Teamleader rejects this generic field; use the structured address fields below. */
    readonly address?: never
    readonly line_1: string | null
    readonly postal_code: string | null
    readonly city: string | null
    readonly country: string
    readonly area_level_two_id?: string
  }
}

export interface TeamleaderContactAddRequest {
  readonly first_name?: string
  readonly last_name: string
  readonly emails?: readonly TeamleaderContactEmailInput[]
  readonly salutation?: string
  readonly telephones?: readonly TeamleaderContactTelephoneInput[]
  readonly website?: string
  readonly addresses?: readonly TeamleaderContactAddressInput[]
  readonly language?: string
  readonly gender?: TeamleaderContactGender | null
  readonly birthdate?: string
  readonly iban?: string
  readonly bic?: string
  readonly national_identification_number?: string
  readonly remarks?: string
  readonly tags?: readonly string[]
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
  readonly marketing_mails_consent?: boolean
}

export interface TeamleaderContactUpdateRequest {
  readonly id: string
  readonly first_name?: string | null
  readonly last_name?: string
  readonly salutation?: string | null
  readonly emails?: readonly TeamleaderContactEmailUpdateInput[]
  readonly telephones?: readonly TeamleaderContactTelephoneInput[] | null
  readonly website?: string | null
  readonly addresses?: readonly TeamleaderContactAddressInput[]
  readonly language?: string
  readonly gender?: TeamleaderContactGender | null
  readonly birthdate?: string | null
  readonly iban?: string | null
  readonly bic?: string | null
  readonly national_identification_number?: string
  readonly remarks?: string | null
  /** Replaces all existing tags. Use `tag` or `untag` for incremental changes. */
  readonly tags?: readonly string[]
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
  /** Updates only the supplied custom fields instead of replacing the collection. */
  readonly custom_fields_update_strategy?: "partial"
  readonly marketing_mails_consent?: boolean
}

export interface TeamleaderContactTagRequest {
  readonly id: string
  readonly tags: readonly string[]
}

export interface TeamleaderContactCompanyLinkRequest {
  readonly id: string
  readonly company_id: string
  readonly position?: string
  readonly decision_maker?: boolean
}

export type TeamleaderContactLinkToCompanyRequest = TeamleaderContactCompanyLinkRequest

export type TeamleaderContactUpdateCompanyLinkRequest = TeamleaderContactCompanyLinkRequest

export interface TeamleaderContactUnlinkFromCompanyRequest {
  readonly id: string
  readonly company_id: string
}

export interface TeamleaderContactUploadAvatarRequest {
  readonly id: string
  /** A data URL, or `null` to remove the current avatar. */
  readonly image: string | null
}
