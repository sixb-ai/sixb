/** The user an API key belongs to. Fleetio documents this in its quick start, not its API spec. */
export interface FleetioCurrentUser {
  readonly id: number
  readonly username: string
  readonly email: string
  readonly time_zone_name: string | null
  readonly time_zone_offset_in_seconds: number | null
  readonly created_at: string
  readonly updated_at: string
  readonly has_multiple_accounts: boolean
  readonly first_name: string | null
  readonly last_name: string | null
  readonly default_image_url: string | null
  readonly fuel_economy_units: string | null
  readonly contact_id: number | null
  readonly technician: boolean
}
