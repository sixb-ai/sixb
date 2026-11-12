import type { CtmPageOptions } from "./common"

export interface CtmTrackingNumberListOptions extends CtmPageOptions {
  /** Filter by phone number. */
  readonly number?: string
  /** Filter by the number's name. */
  readonly name?: string
}

/** A number calls are forwarded to, such as an office line or an agent's phone. */
export interface CtmReceivingNumber {
  /** `RPN…`. */
  readonly id: string
  readonly filter_id: number | null
  readonly account_id: number
  readonly name: string | null
  /** E.164. */
  readonly number: string
  readonly display_number: string | null
  readonly formatted: string | null
  readonly country_code: string | null
  readonly split: readonly string[]
  readonly url?: string
}

export interface CtmSourceListOptions extends CtmPageOptions {
  /** Matches sources by name. */
  readonly name?: string
}

export interface CtmGeoRouterListOptions extends CtmPageOptions {
  /** Matches geo routers by name. */
  readonly filter?: string
}

export interface CtmSmsListOptions extends CtmPageOptions {
  /** Matches caller ID, numbers or source name. */
  readonly filter?: string
  readonly startTime?: string
  readonly endTime?: string
  readonly direction?: "inbound" | "outbound"
}

export interface CtmTextOptOutListOptions extends CtmPageOptions {
  /** Matches the number or its caller ID. */
  readonly filter?: string
  /** The agency's list instead of the account's. Needs an agency key. */
  readonly agencyWide?: boolean
}

export interface CtmBlockedNumberListOptions {
  /** The agency's list instead of the account's. Needs an agency key. */
  readonly agencyWide?: boolean
}
