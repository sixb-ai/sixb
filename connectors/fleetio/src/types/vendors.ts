import type {
  FleetioEqFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"

/** A Vendor */
export interface FleetioVendor {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The name of the Vendor. */
  readonly name: string
  /** The phone number of the Vendor. */
  readonly phone: string | null
  /** The street address of the Vendor. */
  readonly street_address: string | null
  /** The second line of the street address of the Vendor. */
  readonly street_address_line_2: string | null
  /** The city of the Vendor. */
  readonly city: string | null
  /** The region, state, province, or territory of the Vendor. */
  readonly region: string | null
  /** The postal code or ZIP code of the Vendor. */
  readonly postal_code: string | null
  /** The country of the Vendor. */
  readonly country: string | null
  /** The website of the Vendor. */
  readonly website: string | null
  /** Additional notes about the Vendor. */
  readonly notes: string | null
  /** Indicates whether the Vendor provides fuel. */
  readonly fuel: boolean | null
  /** Indicates whether the Vendor provides service. */
  readonly service: boolean | null
  /** Indicates whether the Vendor provides parts. */
  readonly parts: boolean | null
  /** Indicates whether the Vendor provides vehicles. */
  readonly vehicle: boolean | null
  /** The name of the contact person for the Vendor. */
  readonly contact_name: string | null
  /** The email address of the contact person for the Vendor. */
  readonly contact_email: string | null
  /** The phone number of the contact person for the Vendor. */
  readonly contact_phone: string | null
  /** The latitude of the Vendor's location. */
  readonly latitude: number | null
  /** The longitude of the Vendor's location. */
  readonly longitude: number | null
  /** The external identifier of the Vendor. */
  readonly external_id: string | null
  /** The date and time when the Vendor was archived, if applicable. */
  readonly archived_at: string | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields: Readonly<Record<string, unknown>> | null
}

/** A Vendor */
export interface FleetioVendorSummary {
  readonly id: number
  readonly created_at: string
  readonly updated_at: string
  /** The name of the Vendor. */
  readonly name: string
  /** The phone number of the Vendor. */
  readonly phone: string | null
  /** The street address of the Vendor. */
  readonly street_address: string | null
  /** The second line of the street address of the Vendor. */
  readonly street_address_line_2: string | null
  /** The city of the Vendor. */
  readonly city: string | null
  /** The region, state, province, or territory of the Vendor. */
  readonly region: string | null
  /** The postal code or ZIP code of the Vendor. */
  readonly postal_code: string | null
  /** The country of the Vendor. */
  readonly country: string | null
  /** The website of the Vendor. */
  readonly website: string | null
  /** Additional notes about the Vendor. */
  readonly notes: string | null
  /** Indicates whether the Vendor provides fuel. */
  readonly fuel: boolean | null
  /** Indicates whether the Vendor provides service. */
  readonly service: boolean | null
  /** Indicates whether the Vendor provides parts. */
  readonly parts: boolean | null
  /** Indicates whether the Vendor provides vehicles. */
  readonly vehicle: boolean | null
  /** The name of the contact person for the Vendor. */
  readonly contact_name: string | null
  /** The email address of the contact person for the Vendor. */
  readonly contact_email: string | null
  /** The phone number of the contact person for the Vendor. */
  readonly contact_phone: string | null
  /** The latitude of the Vendor's location. */
  readonly latitude: number | null
  /** The longitude of the Vendor's location. */
  readonly longitude: number | null
  /** The external identifier of the Vendor. */
  readonly external_id: string | null
  /** The date and time when the Vendor was archived, if applicable. */
  readonly archived_at: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly labels: readonly { readonly id?: number; readonly name?: string }[]
}

export interface FleetioVendorFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly external_id?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioVendorSort {
  readonly id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioVendorCreateInput {
  /** The name of the Vendor. */
  readonly name: string
  /** Additional notes about the Vendor. */
  readonly notes?: string | null
  /** The city of the Vendor. */
  readonly city?: string
  /** The email address of the contact person for the Vendor. */
  readonly contact_email?: string
  /** The name of the contact person for the Vendor. */
  readonly contact_name?: string
  /** The phone number of the contact person for the Vendor. */
  readonly contact_phone?: string
  /** The country of the Vendor. */
  readonly country?: string
  /** An external ID for the Vendor. */
  readonly external_id?: string
  /** The phone number of the Vendor. */
  readonly phone?: string
  /** The postal code or ZIP code of the Vendor. */
  readonly postal_code?: string
  /** The region, state, province, or territory of the Vendor. */
  readonly region?: string
  /** The street address of the Vendor. */
  readonly street_address?: string
  /** The second line of the street address of the Vendor. */
  readonly street_address_line_2?: string
  /** The website of the Vendor. */
  readonly website?: string
  /** Indicates whether the Vendor provides fuel. */
  readonly fuel?: boolean
  /** Indicates whether the Vendor provides service. */
  readonly service?: boolean
  /** Indicates whether the Vendor provides parts. */
  readonly parts?: boolean
  /** Indicates whether the Vendor provides vehicles. */
  readonly vehicle?: boolean
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
}

export type FleetioVendorUpdateInput = Partial<FleetioVendorCreateInput>

export interface FleetioArchivedVendorFilter {
  readonly name?: FleetioLikeOrEqFilter
  readonly external_id?: FleetioEqFilter
}
