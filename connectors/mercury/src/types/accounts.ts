import type { MercuryCursorOptions, MercuryPageCursors, MercuryTimestamp } from "./common"

export type MercuryAccountStatus = "active" | "deleted" | "pending" | "archived"

export type MercuryAccountType = "mercury" | "external" | "recipient"

export interface MercuryAccount {
  readonly id: string
  readonly accountNumber: string
  readonly routingNumber: string
  readonly name: string
  readonly nickname?: string | null
  readonly status: MercuryAccountStatus
  readonly type: MercuryAccountType
  /** Product name, e.g. `checking` or `savings`. Mercury may add kinds without notice. */
  readonly kind: string
  readonly legalBusinessName: string
  readonly createdAt: MercuryTimestamp
  readonly availableBalance: number
  readonly currentBalance: number
  readonly canReceiveTransactions?: boolean | null
  readonly dashboardLink: string
}

export interface MercuryAccountsResponse {
  readonly accounts: readonly MercuryAccount[]
  readonly page: MercuryPageCursors
}

export type MercuryAccountListOptions = MercuryCursorOptions
