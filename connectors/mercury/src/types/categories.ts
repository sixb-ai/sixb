import type { MercuryCursorOptions, MercuryPageCursors } from "./common"

/**
 * One of the organization's custom expense categories, used to classify transactions.
 *
 * Distinct from {@link MercuryMerchantCategory}, which is Mercury's fixed merchant-type
 * vocabulary. Both appear on a transaction: `categoryData` holds the custom category and
 * `mercuryCategory` holds the merchant type.
 */
export interface MercuryCategory {
  readonly id: string
  readonly name: string
  /** Whether the category applies to expense-reimbursement transactions. */
  readonly visibleForReimbursements: boolean
  /** Whether the category applies to card transactions. */
  readonly visibleForCardSpend: boolean
  /** Whether the category applies to every other transaction kind. */
  readonly visibleForOther: boolean
}

/**
 * Mercury's fixed merchant-type vocabulary, surfaced in the dashboard as "Merchant Type" and on
 * the wire as `mercuryCategory`. Read-only: it is assigned by Mercury, never by the API.
 */
export type MercuryMerchantCategory =
  | "Other"
  | "Advertising"
  | "Airlines"
  | "AlcoholAndBars"
  | "BooksAndNewspaper"
  | "CarRental"
  | "Charity"
  | "Clothing"
  | "Conferences"
  | "Education"
  | "Electronics"
  | "Entertainment"
  | "FacilitiesExpenses"
  | "Fees"
  | "FoodDelivery"
  | "FuelAndGas"
  | "Gambling"
  | "GovernmentServices"
  | "Grocery"
  | "GroundTransportation"
  | "Insurance"
  | "InternetAndTelephone"
  | "Legal"
  | "Lodging"
  | "Medical"
  | "Memberships"
  | "OfficeSupplies"
  | "OtherTravel"
  | "Parking"
  | "Political"
  | "ProfessionalServices"
  | "Restaurants"
  | "Retail"
  | "RideshareAndTaxis"
  | "Shipping"
  | "Software"
  | "Taxes"
  | "Utilities"
  | "VehicleExpenses"

export interface MercuryCategoriesResponse {
  readonly categories: readonly MercuryCategory[]
  readonly page: MercuryPageCursors
}

export type MercuryCategoryListOptions = MercuryCursorOptions

export interface MercuryCreateCategoryInput {
  readonly name: string
  readonly visibleForReimbursements: boolean
  readonly visibleForCardSpend: boolean
  readonly visibleForOther: boolean
}

/** Every field is optional; omitted fields are left unchanged. */
export interface MercuryUpdateCategoryInput {
  readonly name?: string
  readonly visibleForReimbursements?: boolean
  readonly visibleForCardSpend?: boolean
  readonly visibleForOther?: boolean
}
