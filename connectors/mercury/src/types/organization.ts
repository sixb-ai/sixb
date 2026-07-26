export type MercuryOrganizationKind = "personal" | "business"

export type MercurySubscriptionTier = "free" | "plus" | "premium" | "pro" | "enterprise"

export type MercuryBillingCadence = "monthly" | "annual"

/** A "Doing Business As" name registered on the organization. */
export interface MercuryOrganizationDba {
  readonly dbaName: string
  /** Whether this DBA is the default for payments. */
  readonly dbaIsDefault: boolean
}

export interface MercuryOrganization {
  readonly id: string
  readonly kind: MercuryOrganizationKind
  readonly legalBusinessName: string
  readonly dbas: readonly MercuryOrganizationDba[]
  readonly subscriptionTier: MercurySubscriptionTier
  /** Always `monthly` when the tier is `free`. */
  readonly billingCadence: MercuryBillingCadence
  /** Employer Identification Number, when Mercury holds one. */
  readonly ein?: string | null
}

export interface MercuryOrganizationResponse {
  readonly organization: MercuryOrganization
}
