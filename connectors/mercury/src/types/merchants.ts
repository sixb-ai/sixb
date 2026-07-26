import type { MercuryCursorOptions, MercuryPageCursors } from "./common"

/** A priority merchant, usable in spend controls such as merchant locking on a card. */
export interface MercuryMerchant {
  readonly id: string
  readonly name: string
}

export interface MercuryMerchantsResponse {
  readonly data: readonly MercuryMerchant[]
  readonly page: MercuryPageCursors
}

export interface MercuryMerchantListOptions extends MercuryCursorOptions {
  /** Case-insensitive search by merchant name. */
  readonly search?: string
}
