import type { AceIotListAllOptions, AceIotPageOptions } from "./common"

export interface AceIotSite {
  readonly id: number
  /** Unique path for the site, and the identifier every `/sites/{site_name}` route takes. */
  readonly name: string
  /** Name of the owning client. */
  readonly client: string
  readonly address: string | null
  readonly nice_name: string | null
  /** Ansible user for deploy tasks. */
  readonly ansible_user: string | null
  /** VOLTTRON run-as user. */
  readonly vtron_user: string | null
  readonly vtron_ip: string | null
  /** PostGIS point as a WKB hex string (`0101000000…`), not a readable coordinate pair. */
  readonly geo_location: string | null
  readonly mqtt_prefix: string | null
  readonly latitude: number | null
  readonly longitude: number | null
  readonly archived: boolean
}

export interface AceIotSiteListOptions extends AceIotPageOptions {
  /** Only sites with at least one collect-enabled point. Defaults to false. */
  readonly collectEnabled?: boolean
  /** Include archived sites. Defaults to false. */
  readonly showArchived?: boolean
}

export interface AceIotSiteListAllOptions extends AceIotSiteListOptions, AceIotListAllOptions {}

export interface AceIotCreateSiteInput {
  readonly name: string
  readonly client?: string
  readonly address?: string
  readonly nice_name?: string
  readonly ansible_user?: string
  readonly vtron_user?: string
  readonly vtron_ip?: string
  readonly geo_location?: string
  readonly mqtt_prefix?: string
  readonly latitude?: number
  readonly longitude?: number
  readonly archived?: boolean
}
