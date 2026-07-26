import type {
  MercuryAddress,
  MercuryCursorOptions,
  MercuryPageCursors,
  MercuryTimestamp,
} from "./common"

/** An Accounts Receivable customer — the party an invoice is billed to. */
export interface MercuryCustomer {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly address?: MercuryAddress | null
  /** Set once the customer has been deleted. */
  readonly deletedAt?: MercuryTimestamp | null
}

export interface MercuryCustomersResponse {
  readonly customers: readonly MercuryCustomer[]
  readonly page: MercuryPageCursors
}

export type MercuryCustomerListOptions = MercuryCursorOptions

export interface MercuryCreateCustomerInput {
  readonly name: string
  readonly email: string
  readonly address?: MercuryAddress | null
}

export interface MercuryUpdateCustomerInput {
  readonly name?: string
  readonly email?: string
  readonly address?: MercuryAddress | null
}
