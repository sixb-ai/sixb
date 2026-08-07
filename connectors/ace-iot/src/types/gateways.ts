import type { AceIotListAllOptions, AceIotPageOptions, AceIotTimestamp } from "./common"

export interface AceIotGateway {
  /** Gateway name, and the identifier every `/gateways/{gateway_name}` route takes. */
  readonly name: string
  readonly site: string
  readonly client: string
  /** Hardware type. Read-only. */
  readonly hw_type: string | null
  /** Software type. Read-only. */
  readonly software_type: string | null
  readonly primary_mac: string | null
  /** Overlay network IP. */
  readonly vpn_ip: string | null
  readonly device_token: string | null
  /**
   * Gateway API key expiry. Unlike every other ACE timestamp this is space-separated
   * (`2027-03-04 19:34:54.114795`) rather than ISO. `parseAceIotTimestamp` handles both.
   */
  readonly device_token_expires: AceIotTimestamp | null
  /** Free-form interface blob: netplans and discovered interfaces, keyed by name. */
  readonly interfaces: Readonly<Record<string, unknown>>
  /** Free-form deployment config: agent state, scan settings, collection flags. */
  readonly deploy_config: Readonly<Record<string, unknown>>
  readonly archived: boolean
  readonly updated: AceIotTimestamp
}

export interface AceIotGatewayListOptions extends AceIotPageOptions {
  /** Include archived gateways. Defaults to false. */
  readonly showArchived?: boolean
}

export interface AceIotGatewayListAllOptions
  extends AceIotGatewayListOptions,
    AceIotListAllOptions {}

/** Writable gateway fields. `hw_type` and `software_type` are read-only upstream. */
export interface AceIotGatewayInput {
  readonly name: string
  readonly site?: string
  readonly client?: string
  readonly primary_mac?: string
  readonly vpn_ip?: string
  readonly device_token?: string
  readonly device_token_expires?: string
  readonly interfaces?: Readonly<Record<string, unknown>>
  readonly deploy_config?: Readonly<Record<string, unknown>>
  readonly archived?: boolean
}

/** The fields a PATCH may change. `name` comes from the path. */
export type AceIotUpdateGatewayInput = Omit<AceIotGatewayInput, "name"> & { readonly name?: string }

/** An authorization token used to access the ACE Manager API. */
export interface AceIotGatewayToken {
  readonly auth_token: string
}

export interface AceIotPcapListOptions extends AceIotPageOptions {
  readonly startTime: Date | string
  readonly endTime: Date | string
}

export interface AceIotPcapListAllOptions extends AceIotPcapListOptions, AceIotListAllOptions {}
