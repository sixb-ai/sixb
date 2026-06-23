import type { CompanyCamCoordinate, CompanyCamImageUri, PageOptions } from "./common"

export type CompanyCamProjectStatus = "active" | "deleted"

export interface CompanyCamAddress {
  readonly street_address_1?: string | null
  readonly street_address_2?: string | null
  readonly city?: string | null
  readonly state?: string | null
  readonly postal_code?: string | null
  readonly country?: string | null
}

export interface CompanyCamPrimaryContact {
  readonly id?: string
  readonly name?: string | null
  readonly email?: string | null
  readonly phone_number?: string | null
}

export interface CompanyCamProject {
  readonly id: string
  readonly company_id: string
  readonly creator_id: string
  readonly creator_type: string
  readonly creator_name: string
  readonly status: CompanyCamProjectStatus
  readonly archived: boolean
  readonly name: string | null
  readonly address: CompanyCamAddress | null
  readonly coordinates: CompanyCamCoordinate | null
  readonly featured_image: readonly CompanyCamImageUri[]
  readonly project_url: string
  readonly embedded_project_url: string
  readonly slug: string
  readonly public: boolean
  readonly geofence: readonly CompanyCamCoordinate[]
  readonly primary_contact: CompanyCamPrimaryContact | null
  readonly notepad: string | null
  /** Unix epoch seconds. */
  readonly created_at: number
  /** Unix epoch seconds. */
  readonly updated_at: number
}

export interface ListProjectsOptions extends PageOptions {
  /** Filter by project name or address line 1. */
  readonly query?: string
  /** Only projects modified at or after this ISO 8601 timestamp. */
  readonly modifiedSince?: string
}
