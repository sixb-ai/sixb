import type {
  LinkedinChangeAuditStamps,
  LinkedinExtensibleString,
  LinkedinId,
  LinkedinMoney,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
  LinkedinRunSchedule,
  LinkedinSortOrder,
  LinkedinSponsoredAccountUrn,
  LinkedinSponsoredCampaignGroupUrn,
  LinkedinSponsoredCampaignUrn,
  LinkedinSponsoredCreativeUrn,
  LinkedinUrn,
  LinkedinVersionTag,
} from "./common"

export type LinkedinAdAccountStatus =
  | "ACTIVE"
  | "CANCELED"
  | "DRAFT"
  | "PENDING_DELETION"
  | "REMOVED"

export type LinkedinAdAccountType = "BUSINESS" | "ENTERPRISE"

export interface LinkedinAdAccount {
  readonly id: number
  readonly name: string
  readonly currency?: string
  readonly type: LinkedinAdAccountType
  readonly status?: LinkedinAdAccountStatus
  readonly test?: boolean
  readonly reference?: LinkedinPersonUrn | LinkedinOrganizationUrn
  readonly notifiedOnCampaignOptimization?: boolean
  readonly notifiedOnCreativeApproval?: boolean
  readonly notifiedOnCreativeRejection?: boolean
  readonly notifiedOnEndOfCampaign?: boolean
  readonly notifiedOnNewFeaturesEnabled?: boolean
  readonly servingStatuses?: readonly string[]
  readonly changeAuditStamps?: LinkedinChangeAuditStamps
  readonly version?: LinkedinVersionTag
  readonly referenceInfo?: unknown
}

export interface LinkedinCreateAdAccountInput {
  readonly name: string
  readonly type: "BUSINESS"
  readonly currency?: string
  readonly reference?: LinkedinPersonUrn | LinkedinOrganizationUrn
  readonly test?: boolean
  readonly notifiedOnCampaignOptimization?: boolean
  readonly notifiedOnCreativeApproval?: boolean
  readonly notifiedOnCreativeRejection?: boolean
  readonly notifiedOnEndOfCampaign?: boolean
  readonly notifiedOnNewFeaturesEnabled?: boolean
}

export type LinkedinUpdateAdAccountInput = Partial<
  Pick<
    LinkedinAdAccount,
    | "name"
    | "currency"
    | "reference"
    | "status"
    | "notifiedOnCampaignOptimization"
    | "notifiedOnCreativeApproval"
    | "notifiedOnCreativeRejection"
    | "notifiedOnEndOfCampaign"
    | "notifiedOnNewFeaturesEnabled"
  >
>

export interface LinkedinAdAccountSearchOptions {
  readonly ids?: readonly LinkedinId[]
  readonly names?: readonly string[]
  readonly references?: readonly (LinkedinPersonUrn | LinkedinOrganizationUrn)[]
  readonly statuses?: readonly LinkedinAdAccountStatus[]
  readonly types?: readonly LinkedinAdAccountType[]
  readonly test?: boolean
  readonly sortOrder?: LinkedinSortOrder
  readonly pageSize?: number
  readonly pageToken?: string
}

export type LinkedinAdAccountUserRole =
  | "VIEWER"
  | "CREATIVE_MANAGER"
  | "CAMPAIGN_MANAGER"
  | "ACCOUNT_MANAGER"
  | "ACCOUNT_BILLING_ADMIN"

export interface LinkedinAdAccountUser {
  readonly account: LinkedinSponsoredAccountUrn
  readonly user: LinkedinPersonUrn
  readonly role: LinkedinAdAccountUserRole
  readonly createdAt?: number
  readonly lastModifiedAt?: number
  readonly changeAuditStamps?: LinkedinChangeAuditStamps
  readonly version?: LinkedinVersionTag
}

export interface LinkedinAdAccountUserInput {
  readonly account: LinkedinSponsoredAccountUrn
  readonly user: LinkedinPersonUrn
  readonly role: LinkedinAdAccountUserRole
}

export type LinkedinCampaignType = "TEXT_AD" | "SPONSORED_UPDATES" | "SPONSORED_INMAILS" | "DYNAMIC"

export type LinkedinCampaignObjectiveType = LinkedinExtensibleString<
  | "BRAND_AWARENESS"
  | "ENGAGEMENT"
  | "JOB_APPLICANTS"
  | "LEAD_GENERATION"
  | "WEBSITE_CONVERSIONS"
  | "WEBSITE_VISITS"
  | "VIDEO_VIEWS"
>

export type LinkedinCampaignGroupStatus =
  | "ACTIVE"
  | "ARCHIVED"
  | "CANCELED"
  | "DRAFT"
  | "PAUSED"
  | "PENDING_DELETION"
  | "REMOVED"

export interface LinkedinBudgetOptimization {
  readonly bidStrategy?: "MAXIMUM_DELIVERY" | "MANUAL" | "COST_CAP"
  readonly budgetOptimizationStrategy: "DYNAMIC"
}

export interface LinkedinCampaignGroup {
  readonly id: number
  readonly account: LinkedinSponsoredAccountUrn
  readonly name: string
  readonly runSchedule: LinkedinRunSchedule
  readonly status: LinkedinCampaignGroupStatus
  readonly totalBudget?: LinkedinMoney
  readonly dailyBudget?: LinkedinMoney
  readonly objectiveType?: LinkedinCampaignObjectiveType
  readonly budgetOptimization?: LinkedinBudgetOptimization
  readonly backfilled?: boolean
  readonly test?: boolean
  readonly allowedCampaignTypes?: readonly LinkedinCampaignType[]
  readonly servingStatuses?: readonly string[]
  readonly changeAuditStamps?: LinkedinChangeAuditStamps
  readonly accountInfo?: LinkedinAdAccount
}

export interface LinkedinCreateCampaignGroupInput {
  readonly account: LinkedinSponsoredAccountUrn
  readonly name: string
  readonly runSchedule: LinkedinRunSchedule
  readonly status: "ACTIVE" | "DRAFT"
  readonly totalBudget?: LinkedinMoney
  readonly dailyBudget?: LinkedinMoney
  readonly objectiveType?: LinkedinCampaignObjectiveType
  readonly budgetOptimization?: LinkedinBudgetOptimization
}

export type LinkedinUpdateCampaignGroupInput = Partial<
  Pick<
    LinkedinCampaignGroup,
    "name" | "runSchedule" | "status" | "totalBudget" | "dailyBudget" | "budgetOptimization"
  >
>

export interface LinkedinCampaignGroupSearchOptions {
  readonly ids?: readonly (LinkedinId | LinkedinSponsoredCampaignGroupUrn)[]
  readonly names?: readonly string[]
  readonly statuses?: readonly LinkedinCampaignGroupStatus[]
  readonly test?: boolean
  readonly sortOrder?: LinkedinSortOrder
  readonly pageSize?: number
  readonly pageToken?: string
}

export type LinkedinCampaignStatus =
  | "ACTIVE"
  | "PAUSED"
  | "ARCHIVED"
  | "COMPLETED"
  | "CANCELED"
  | "DRAFT"
  | "PENDING_DELETION"
  | "REMOVED"

export type LinkedinCampaignCostType = "CPM" | "CPC" | "CPV"
export type LinkedinCampaignCreativeSelection = "ROUND_ROBIN" | "OPTIMIZED"
export type LinkedinCampaignPacingStrategy = "LIFETIME" | "ACCELERATED"
export type LinkedinPoliticalIntent = "POLITICAL" | "NOT_POLITICAL" | "NOT_DECLARED"
export type LinkedinOptimizationTargetType = LinkedinExtensibleString<
  | "NONE"
  | "ENHANCED_CONVERSION"
  | "MAX_IMPRESSION"
  | "MAX_CLICK"
  | "MAX_CONVERSION"
  | "MAX_VIDEO_VIEW"
  | "MAX_LEAD"
  | "MAX_QUALIFIED_LEAD"
  | "MAX_REACH"
>

export interface LinkedinLocale {
  readonly country: string
  readonly language: string
}

export type LinkedinTargetingFacet = `urn:li:adTargetingFacet:${string}`
export type LinkedinTargetingFacetMap = Readonly<
  Partial<Record<LinkedinTargetingFacet, readonly LinkedinUrn[]>>
>

export interface LinkedinTargetingOrExpression {
  readonly or: LinkedinTargetingFacetMap
}

export interface LinkedinTargetingAndExpression {
  readonly and: readonly LinkedinTargetingOrExpression[]
}

export interface LinkedinTargetingCriteria {
  readonly include: LinkedinTargetingAndExpression | LinkedinTargetingOrExpression
  readonly exclude?: LinkedinTargetingAndExpression | LinkedinTargetingOrExpression
}

export interface LinkedinOffsitePreferences {
  readonly iabCategories?: {
    readonly include?: readonly LinkedinUrn[]
    readonly exclude?: readonly LinkedinUrn[]
  }
  readonly publisherRestrictionFiles?: {
    readonly include?: readonly LinkedinUrn[]
    readonly exclude?: readonly LinkedinUrn[]
  }
}

export interface LinkedinFrequencyOptimizationPreference {
  readonly frequencyOptimizationPreference: {
    readonly optimizationType: "MAX_FREQUENCY"
    readonly frequency: number
    readonly timeSpan: { readonly duration: 7; readonly unit: "DAY" }
  }
}

export interface LinkedinCampaign {
  readonly id: number
  readonly account: LinkedinSponsoredAccountUrn
  readonly campaignGroup: LinkedinSponsoredCampaignGroupUrn
  readonly name: string
  readonly costType: LinkedinCampaignCostType
  readonly locale: LinkedinLocale
  readonly offsiteDeliveryEnabled: boolean
  readonly targetingCriteria: LinkedinTargetingCriteria
  readonly type: LinkedinCampaignType
  readonly unitCost: LinkedinMoney
  readonly status: LinkedinCampaignStatus
  readonly associatedEntity?: LinkedinUrn
  readonly audienceExpansionEnabled?: boolean
  readonly connectedTelevisionOnly?: boolean
  readonly creativeSelection?: LinkedinCampaignCreativeSelection
  readonly dailyBudget?: LinkedinMoney
  readonly totalBudget?: LinkedinMoney
  readonly objectiveType?: LinkedinCampaignObjectiveType
  readonly offsitePreferences?: LinkedinOffsitePreferences
  readonly optimizationPreference?: LinkedinFrequencyOptimizationPreference
  readonly optimizationTargetType?: LinkedinOptimizationTargetType
  readonly format?: string
  readonly pacingStrategy?: LinkedinCampaignPacingStrategy
  readonly politicalIntent?: LinkedinPoliticalIntent
  readonly runSchedule?: LinkedinRunSchedule
  readonly test?: boolean
  readonly servingStatuses?: readonly string[]
  readonly changeAuditStamps?: LinkedinChangeAuditStamps
  readonly version?: LinkedinVersionTag
  readonly accountInfo?: LinkedinAdAccount
  readonly campaignGroupInfo?: LinkedinCampaignGroup
  readonly associatedEntityInfo?: unknown
}

type LinkedinCampaignBudget =
  | { readonly dailyBudget: LinkedinMoney; readonly totalBudget?: LinkedinMoney }
  | { readonly dailyBudget?: LinkedinMoney; readonly totalBudget: LinkedinMoney }

export type LinkedinCreateCampaignInput = Omit<
  LinkedinCampaign,
  | "id"
  | "test"
  | "servingStatuses"
  | "changeAuditStamps"
  | "version"
  | "accountInfo"
  | "campaignGroupInfo"
  | "associatedEntityInfo"
  | "dailyBudget"
  | "totalBudget"
  | "status"
  | "politicalIntent"
  | "runSchedule"
> &
  LinkedinCampaignBudget & {
    readonly status: "ACTIVE" | "DRAFT"
    /** Required by current LinkedIn Marketing API versions. */
    readonly politicalIntent: LinkedinPoliticalIntent
    /** Required when creating a campaign, even though older read payloads may omit it. */
    readonly runSchedule: LinkedinRunSchedule
  }

export type LinkedinUpdateCampaignInput = Partial<
  Pick<
    LinkedinCampaign,
    | "associatedEntity"
    | "audienceExpansionEnabled"
    | "creativeSelection"
    | "dailyBudget"
    | "totalBudget"
    | "name"
    | "offsiteDeliveryEnabled"
    | "offsitePreferences"
    | "optimizationPreference"
    | "optimizationTargetType"
    | "politicalIntent"
    | "runSchedule"
    | "status"
    | "targetingCriteria"
    | "unitCost"
  >
>

export interface LinkedinCampaignSearchOptions {
  readonly ids?: readonly (LinkedinId | LinkedinSponsoredCampaignUrn)[]
  readonly campaignGroups?: readonly LinkedinSponsoredCampaignGroupUrn[]
  readonly associatedEntities?: readonly LinkedinUrn[]
  readonly names?: readonly string[]
  readonly statuses?: readonly LinkedinCampaignStatus[]
  readonly types?: readonly LinkedinCampaignType[]
  readonly test?: boolean
  readonly sortOrder?: LinkedinSortOrder
  readonly pageSize?: number
  readonly pageToken?: string
}

export type LinkedinCreativeStatus =
  | "ACTIVE"
  | "PAUSED"
  | "DRAFT"
  | "ARCHIVED"
  | "CANCELED"
  | "PENDING_DELETION"
  | "REMOVED"

export interface LinkedinEventAdContent {
  readonly post: LinkedinUrn
  readonly event: LinkedinUrn
  readonly directSponsoredContent?: boolean
  readonly preEventRegistrationImage?: LinkedinUrn
  readonly hidePreviewVideo?: boolean
  readonly contentAuthor?: LinkedinPersonUrn | LinkedinOrganizationUrn
}

/**
 * Creative bodies vary by ad format and evolve monthly. Known common shapes are typed, while the
 * open keys preserve new LinkedIn content unions without discarding data.
 */
export interface LinkedinCreativeContent {
  readonly reference?: LinkedinUrn
  readonly eventAd?: LinkedinEventAdContent
  readonly [contentType: string]: unknown
}

export interface LinkedinLeadgenCallToAction {
  readonly destination: LinkedinUrn
  readonly label: LinkedinExtensibleString<
    | "APPLY"
    | "DOWNLOAD"
    | "VIEW_QUOTE"
    | "LEARN_MORE"
    | "SIGN_UP"
    | "SUBSCRIBE"
    | "REGISTER"
    | "REQUEST_DEMO"
    | "JOIN"
    | "ATTEND"
    | "UNLOCK_FULL_DOCUMENT"
  >
}

export interface LinkedinCreativeReview {
  readonly status: "PENDING" | "APPROVED" | "REJECTED" | "NEEDS_REVIEW"
  readonly rejectionReasons?: readonly string[]
}

export interface LinkedinCreative<
  TContent extends LinkedinCreativeContent = LinkedinCreativeContent,
> {
  readonly id: LinkedinSponsoredCreativeUrn
  readonly account: LinkedinSponsoredAccountUrn
  readonly campaign: LinkedinSponsoredCampaignUrn
  readonly intendedStatus: LinkedinCreativeStatus
  readonly content?: TContent
  readonly inlineContent?: unknown
  readonly name?: string
  readonly leadgenCallToAction?: LinkedinLeadgenCallToAction
  readonly createdAt?: number
  readonly createdBy?: LinkedinPersonUrn
  readonly lastModifiedAt?: number
  readonly lastModifiedBy?: LinkedinPersonUrn
  readonly isServing?: boolean
  readonly isTest?: boolean
  readonly review?: LinkedinCreativeReview
  readonly servingHoldReasons?: readonly string[]
}

export interface LinkedinCreateCreativeInput<
  TContent extends LinkedinCreativeContent = LinkedinCreativeContent,
> {
  readonly campaign: LinkedinSponsoredCampaignUrn
  readonly intendedStatus?: LinkedinCreativeStatus
  readonly content?: TContent
  readonly name?: string
  readonly leadgenCallToAction?: LinkedinLeadgenCallToAction
}

export interface LinkedinCreateInlineCreativeInput {
  /**
   * The full `creative` union accepted by LinkedIn's `createInline` action. The payload deliberately
   * stays open because the supported post formats evolve independently of the Creative schema.
   */
  readonly creative: Readonly<Record<string, unknown>>
}

export type LinkedinUpdateCreativeInput = Partial<
  Pick<LinkedinCreative, "intendedStatus" | "name" | "leadgenCallToAction" | "content">
>

export interface LinkedinCreativeSearchOptions {
  readonly campaigns?: readonly LinkedinSponsoredCampaignUrn[]
  readonly contentReferences?: readonly LinkedinUrn[]
  readonly creatives?: readonly LinkedinSponsoredCreativeUrn[]
  readonly intendedStatuses?: readonly LinkedinCreativeStatus[]
  readonly isTestAccount?: boolean
  readonly isTotalIncluded?: boolean
  readonly leadgenCreativeCallToActionDestinations?: readonly LinkedinUrn[]
  readonly sortOrder?: LinkedinSortOrder
  readonly pageSize?: number
  readonly pageToken?: string
}
