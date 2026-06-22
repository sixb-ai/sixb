import type {
  TeamleaderAddress,
  TeamleaderEmail,
  TeamleaderJsonObject,
  TeamleaderPage,
  TeamleaderPrimaryEmailFilter,
  TeamleaderSort,
  TeamleaderTelephone,
  TeamleaderTypeAndId,
} from "./common"
import type { TeamleaderCustomField } from "./custom-fields"

export interface TeamleaderContactListRequest {
  readonly filter?: {
    readonly email?: TeamleaderPrimaryEmailFilter
    readonly ids?: readonly string[]
    readonly company_id?: string
    readonly term?: string
    readonly updated_since?: string
    readonly tags?: readonly string[]
    readonly status?: "active" | "deactivated"
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
  readonly status?: "active" | "deactivated"
  readonly salutation?: string
  readonly emails?: readonly TeamleaderEmail[]
  readonly telephones?: readonly TeamleaderTelephone[]
  readonly website?: string
  readonly primary_address?: TeamleaderAddress
  readonly gender?: string
  readonly birthdate?: string
  readonly iban?: string
  readonly bic?: string
  readonly national_identification_number?: string
  readonly language?: string
  readonly payment_term?: TeamleaderTypeAndId<"paymentTerm">
  readonly invoicing_preferences?: TeamleaderJsonObject
  readonly tags?: readonly string[]
  readonly added_at?: string
  readonly updated_at?: string
  readonly web_url?: string
  readonly marketing_mails_consent?: boolean
  readonly custom_fields?: readonly TeamleaderCustomField[]
  readonly price_list?: TeamleaderTypeAndId<"priceList">
}

export interface TeamleaderContact extends Omit<TeamleaderContactListItem, "primary_address"> {
  readonly vat_number?: string
  readonly addresses?: readonly TeamleaderAddress[]
  readonly companies?: readonly {
    readonly position?: string
    readonly secondary_position?: string
    readonly division?: string
    readonly decision_maker?: boolean
    readonly company?: TeamleaderTypeAndId<"company">
  }[]
  readonly remarks?: string
}
