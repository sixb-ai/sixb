import type { AceIotListAllOptions, AceIotPageOptions } from "./common"

/**
 * One record from the `/clients` resource — the tenant that owns sites, points, and gateways.
 * Named `…ClientAccount` because `AceIotClient` is the connected SDK client.
 */
export interface AceIotClientAccount {
  readonly id: number
  /** Unique name, and the identifier every `/clients/{client_name}` route takes. */
  readonly name: string
  readonly nice_name: string | null
  /** Business contact. */
  readonly bus_contact: string | null
  /** Technical contact. */
  readonly tech_contact: string | null
  readonly address: string | null
}

export interface AceIotClientListOptions extends AceIotPageOptions {}
export interface AceIotClientListAllOptions extends AceIotListAllOptions {}

export interface AceIotCreateClientInput {
  readonly name: string
  readonly nice_name?: string
  readonly bus_contact?: string
  readonly tech_contact?: string
  readonly address?: string
}
