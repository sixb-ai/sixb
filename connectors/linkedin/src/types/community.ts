import type {
  LinkedinActivityUrn,
  LinkedinAuditStamp,
  LinkedinCommentUrn,
  LinkedinDigitalMediaAssetUrn,
  LinkedinDocumentUrn,
  LinkedinExtensibleString,
  LinkedinImageUrn,
  LinkedinOffsetOptions,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
  LinkedinPostUrn,
  LinkedinReactionUrn,
  LinkedinUrn,
  LinkedinVideoUrn,
} from "./common"

export type LinkedinOrganizationType = LinkedinExtensibleString<
  | "ASSOCIATION"
  | "COMPANY"
  | "EDUCATIONAL_INSTITUTION"
  | "GOVERNMENT_AGENCY"
  | "NON_PROFIT"
  | "PARTNERSHIP"
  | "PRIVATELY_HELD"
  | "PUBLIC_COMPANY"
  | "SELF_EMPLOYED"
  | "SELF_OWNED"
  | "SOLE_PROPRIETORSHIP"
>

export type LinkedinPrimaryOrganizationType = LinkedinExtensibleString<"NONE" | "SCHOOL" | "BRAND">

export interface LinkedinLocalizedString {
  readonly localized: Readonly<Record<string, string>>
  readonly preferredLocale?: {
    readonly country: string
    readonly language: string
  }
}

export interface LinkedinOrganizationLocation {
  readonly locationType?: string
  readonly address?: {
    readonly line1?: string
    readonly line2?: string
    readonly city?: string
    readonly geographicArea?: string
    readonly country?: string
    readonly postalCode?: string
    [field: string]: unknown
  }
  readonly description?: LinkedinLocalizedString
  readonly geoLocation?: LinkedinUrn
  readonly staffCountRange?: string
  [field: string]: unknown
}

/** Wire representation returned by `/organizations`. Unknown fields are preserved across versions. */
export interface LinkedinOrganization {
  readonly id: number
  readonly localizedName?: string
  readonly localizedWebsite?: string
  readonly vanityName?: string
  readonly name?: LinkedinLocalizedString
  readonly description?: LinkedinLocalizedString
  readonly website?: LinkedinLocalizedString
  readonly logoV2?: {
    readonly original?: LinkedinDigitalMediaAssetUrn | LinkedinImageUrn
    readonly cropped?: LinkedinDigitalMediaAssetUrn | LinkedinImageUrn
    readonly cropInfo?: Readonly<Record<string, unknown>>
    [field: string]: unknown
  }
  readonly locations?: readonly LinkedinOrganizationLocation[]
  readonly primaryOrganizationType?: LinkedinPrimaryOrganizationType
  readonly organizationType?: LinkedinOrganizationType
  readonly industries?: readonly LinkedinUrn[]
  readonly staffCountRange?: string
  readonly specialties?: readonly LinkedinLocalizedString[]
  readonly foundedOn?: { readonly year: number }
  readonly parentRelationship?: {
    readonly parent: LinkedinOrganizationUrn
    readonly relationshipStatus?: string
    [field: string]: unknown
  }
  readonly versionTag?: string
  [field: string]: unknown
}

export type LinkedinOrganizationRole = LinkedinExtensibleString<
  | "ADMINISTRATOR"
  | "ANALYST"
  | "CONTENT_ADMIN"
  | "CONTENT_ADMINISTRATOR"
  | "CURATOR"
  | "DIRECT_SPONSORED_CONTENT_POSTER"
  | "LEAD_CAPTURE_ADMINISTRATOR"
  | "LEAD_GEN_FORMS_MANAGER"
  | "RECRUITING_POSTER"
>

export type LinkedinOrganizationAclState = "APPROVED" | "REJECTED" | "REQUESTED" | "REVOKED"

export interface LinkedinOrganizationAcl {
  readonly role: LinkedinOrganizationRole
  readonly state: LinkedinOrganizationAclState
  readonly roleAssignee: LinkedinPersonUrn
  /** Current response field. */
  readonly organizationTarget?: LinkedinOrganizationUrn
  /** Older versioned responses may still use this field. */
  readonly organization?: LinkedinOrganizationUrn
  readonly createdAt?: number
  readonly lastModifiedAt?: number
  [field: string]: unknown
}

export interface LinkedinOrganizationAclOptions extends LinkedinOffsetOptions {
  readonly role?: LinkedinOrganizationRole
  readonly state?: LinkedinOrganizationAclState
}

export type LinkedinPostLifecycleState = LinkedinExtensibleString<
  "DRAFT" | "PUBLISHED" | "PUBLISH_REQUESTED" | "PUBLISH_FAILED"
>
export type LinkedinPostVisibility = LinkedinExtensibleString<
  "PUBLIC" | "CONNECTIONS" | "LOGGED_IN" | "CONTAINER"
>
export type LinkedinPostSortBy = "CREATED" | "LAST_MODIFIED"
export type LinkedinPostViewContext = "AUTHOR" | "READER"

export interface LinkedinPostDistribution {
  readonly feedDistribution?: "MAIN_FEED" | "NONE"
  readonly targetEntities?: readonly Readonly<Record<string, unknown>>[]
  readonly thirdPartyDistributionChannels?: readonly string[]
  [field: string]: unknown
}

export interface LinkedinPostArticleContent {
  readonly source: string
  readonly title?: string
  readonly description?: string
  readonly thumbnail?: LinkedinImageUrn
  readonly thumbnailAltText?: string
  [field: string]: unknown
}

export interface LinkedinPostMediaContent {
  readonly id: LinkedinImageUrn | LinkedinVideoUrn | LinkedinDocumentUrn | LinkedinUrn
  readonly title?: string
  readonly altText?: string
  [field: string]: unknown
}

export interface LinkedinPostMultiImageContent {
  readonly images: readonly {
    readonly id: LinkedinImageUrn
    readonly altText?: string
    [field: string]: unknown
  }[]
}

export interface LinkedinPostPollContent {
  readonly question: string
  readonly options: readonly {
    readonly text: string
    readonly isVotedByViewer?: boolean
    readonly voteCount?: number
    [field: string]: unknown
  }[]
  readonly settings: {
    readonly duration: "ONE_DAY" | "THREE_DAYS" | "SEVEN_DAYS" | "FOURTEEN_DAYS"
    readonly voteSelectionType?: "SINGLE_VOTE" | "MULTIPLE_VOTE"
    readonly isVoterVisibleToAuthor?: boolean
    [field: string]: unknown
  }
  readonly uniqueVotersCount?: number
  [field: string]: unknown
}

export interface LinkedinPostReferenceContent {
  readonly id: LinkedinUrn
  [field: string]: unknown
}

export interface LinkedinPostContent {
  readonly article?: LinkedinPostArticleContent
  readonly media?: LinkedinPostMediaContent
  readonly multiImage?: LinkedinPostMultiImageContent
  readonly poll?: LinkedinPostPollContent
  readonly reference?: LinkedinPostReferenceContent
  readonly carousel?: Readonly<Record<string, unknown>>
  readonly celebration?: Readonly<Record<string, unknown>>
  [format: string]: unknown
}

export type LinkedinPostCallToActionLabel = LinkedinExtensibleString<
  | "APPLY"
  | "DOWNLOAD"
  | "VIEW_QUOTE"
  | "LEARN_MORE"
  | "SIGN_UP"
  | "SUBSCRIBE"
  | "REGISTER"
  | "JOIN"
  | "ATTEND"
  | "REQUEST_DEMO"
  | "SEE_MORE"
  | "BUY_NOW"
  | "SHOP_NOW"
>

export interface LinkedinPostLifecycleStateInfo {
  readonly contentStatus?: string
  readonly reviewStatus?: string
  readonly isEditedByAuthor?: boolean
  [field: string]: unknown
}

export interface LinkedinPostReshareContext {
  readonly parent: LinkedinPostUrn
  readonly root?: LinkedinPostUrn
  [field: string]: unknown
}

export interface LinkedinPost {
  readonly id: LinkedinPostUrn
  readonly author: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly commentary: string
  readonly container?: LinkedinUrn
  readonly content?: LinkedinPostContent
  readonly contentLandingPage?: string
  readonly contentCallToActionLabel?: LinkedinPostCallToActionLabel
  readonly distribution?: LinkedinPostDistribution
  readonly visibility: LinkedinPostVisibility
  readonly lifecycleState: LinkedinPostLifecycleState
  readonly createdAt?: number
  readonly lastModifiedAt?: number
  readonly publishedAt?: number
  readonly isReshareDisabledByAuthor?: boolean
  readonly lifecycleStateInfo?: LinkedinPostLifecycleStateInfo
  readonly reshareContext?: LinkedinPostReshareContext
  readonly adContext?: Readonly<Record<string, unknown>>
  [field: string]: unknown
}

export interface LinkedinPostListOptions extends LinkedinOffsetOptions {
  readonly sortBy?: LinkedinPostSortBy
}

export interface LinkedinCreatePostInput {
  readonly author: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly commentary: string
  readonly container?: LinkedinUrn
  readonly content?: LinkedinPostContent
  readonly contentLandingPage?: string
  readonly contentCallToActionLabel?: LinkedinPostCallToActionLabel
  readonly distribution: LinkedinPostDistribution
  readonly visibility: LinkedinPostVisibility
  /** LinkedIn only accepts PUBLISHED during post creation. */
  readonly lifecycleState: "PUBLISHED"
  readonly isReshareDisabledByAuthor?: boolean
  readonly reshareContext?: Pick<LinkedinPostReshareContext, "parent">
  readonly adContext?: Readonly<Record<string, unknown>>
}

export interface LinkedinUpdatePostInput {
  readonly commentary?: string
  readonly contentCallToActionLabel?: LinkedinPostCallToActionLabel
  readonly contentLandingPage?: string
  readonly lifecycleState?: LinkedinPostLifecycleState
  readonly adContext?: Readonly<Record<string, unknown>>
}

export type LinkedinCommentsState = "OPEN" | "CLOSED" | "PROCESSING" | "DELETED"
export type LinkedinReactionType = LinkedinExtensibleString<
  "LIKE" | "PRAISE" | "MAYBE" | "EMPATHY" | "INTEREST" | "APPRECIATION" | "ENTERTAINMENT"
>

export interface LinkedinSocialMetadata {
  readonly entity: LinkedinUrn
  readonly commentsState?: LinkedinCommentsState
  readonly commentSummary?: {
    readonly count: number
    readonly topLevelCount?: number
    [field: string]: unknown
  }
  readonly reactionSummaries?: Readonly<
    Record<string, { readonly count: number; readonly reactionType?: LinkedinReactionType }>
  >
  [field: string]: unknown
}

export type LinkedinSocialEntityUrn = LinkedinPostUrn | LinkedinCommentUrn

export interface LinkedinCommentMessageAttribute {
  readonly start: number
  readonly length: number
  readonly value?: Readonly<Record<string, unknown>>
  [field: string]: unknown
}

export interface LinkedinCommentMessage {
  readonly text: string
  readonly attributes?: readonly LinkedinCommentMessageAttribute[]
}

export interface LinkedinComment {
  readonly id: string
  readonly commentUrn?: LinkedinCommentUrn
  readonly actor: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly object?: LinkedinUrn
  readonly parentComment?: LinkedinCommentUrn
  readonly message: LinkedinCommentMessage
  readonly content?: readonly Readonly<Record<string, unknown>>[]
  readonly created?: LinkedinAuditStamp
  readonly lastModified?: LinkedinAuditStamp
  readonly agent?: LinkedinUrn
  readonly likesSummary?: Readonly<Record<string, unknown>>
  [field: string]: unknown
}

export interface LinkedinCreateCommentInput {
  readonly actor: LinkedinOrganizationUrn | LinkedinPersonUrn
  /** Required for a nested comment because the request target is then a comment URN. */
  readonly object?: LinkedinPostUrn | LinkedinActivityUrn
  readonly parentComment?: LinkedinCommentUrn
  readonly message: LinkedinCommentMessage
  readonly content?: readonly Readonly<Record<string, unknown>>[]
}

export interface LinkedinUpdateCommentInput {
  readonly actor?: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly message: LinkedinCommentMessage
}

export interface LinkedinReaction {
  readonly id?: LinkedinReactionUrn
  readonly reactionType: LinkedinReactionType
  readonly root: LinkedinUrn
  readonly created?: LinkedinAuditStamp
  readonly lastModified?: LinkedinAuditStamp
  [field: string]: unknown
}

export type LinkedinReactionSortOrder = "CHRONOLOGICAL" | "REVERSE_CHRONOLOGICAL" | "RELEVANCE"

export interface LinkedinReactionListOptions extends LinkedinOffsetOptions {
  readonly sort?: LinkedinReactionSortOrder
}

export interface LinkedinCreateReactionInput {
  readonly actor: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly entity: LinkedinUrn
  readonly reactionType: LinkedinReactionType
}
