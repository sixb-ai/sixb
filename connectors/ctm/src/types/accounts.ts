export type CtmAccountState = "active" | "canceled" | "paused"

export interface CtmAccountListOptions {
  readonly status?: CtmAccountState
  readonly page?: number
  readonly pageSize?: number
}

export interface CtmAccount {
  readonly id: number
  readonly name: string
  readonly agency_id?: number | null
  readonly status: CtmAccountState | (string & {})
  /** The role of the API key's user on this account. */
  readonly user_role?: string | null
  readonly created: string | null
  readonly updated: string | null
  readonly canceled: string | null
  readonly website?: string | null
  readonly phone_number?: string | null
  /** A Rails time zone name, such as `Eastern Time (US & Canada)`. */
  readonly timezone?: string | null
  /** Calls per day, and counts of tracking numbers and user licenses. On the detail only. */
  readonly stats?: Readonly<Record<string, unknown>>
  readonly url?: string
}

/** An account's ID and name, from the lightweight list of active accounts. */
export interface CtmAccountSummary {
  readonly id: number
  readonly name: string
}

export interface CtmAccountStatus {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly account_status: string
}

export interface CtmAgency {
  readonly id: number
  readonly name: string
}
