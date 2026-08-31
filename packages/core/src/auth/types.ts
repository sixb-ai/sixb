import type { GroupDefinition, GroupReference, MembershipOperation } from "../security"
import type {
  AccessTokenRecord,
  AuthStorage,
  CompleteAuthSessionInput,
  CompleteSignInResult,
  InvitationRecord,
  InvitationStatus,
  ServiceAccountGroupMembershipRecord,
  ServiceAccountRecord,
  SessionRecord,
  UserRecord,
} from "../storage/auth"
import type { AuthSessionAudience, AuthSessionAudienceOptions } from "./audience"

export type Principal =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "serviceAccount"; readonly id: string }
  | { readonly type: "system"; readonly id: string }

/**
 * The canonical principal for system-originated writes (runs triggered without a caller,
 * worker fallbacks, decode-time defaults). Import this everywhere instead of inlining a
 * `{ type: "system", id: "system" }` literal so the system identity never forks.
 */
export const SYSTEM_PRINCIPAL: Principal = { type: "system", id: "system" }

/** Structural equality for principals (same type and id). */
export function principalsEqual(left: Principal, right: Principal): boolean {
  return left.type === right.type && left.id === right.id
}

export interface SecurityContext {
  readonly principal: Principal
  readonly sessionId?: string
  readonly projectId: string
  readonly correlationId: string
}

export type AuthStrategyKind = "magicLink" | "oidc" | "dev" | "disabled"

export interface AuthStrategy {
  readonly id: string
  readonly kind: AuthStrategyKind
  readonly developmentOnly?: boolean
  readonly disabled?: boolean
  readonly allowDisabledInProduction?: boolean
}

export interface InvitationRecipientInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly email: string
  readonly now?: Date
}

export type InvitationRecipientStatus =
  | "allowed"
  | "invalid_email"
  | "disallowed_domain"
  | "suspended_user"
  | "rate_limited"

export interface InvitationRecipientResult {
  readonly status: InvitationRecipientStatus
  readonly email?: string
}

export interface InvitationDeliveryInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly invitation: InvitationRecord
  readonly audience: AuthSessionAudience
  readonly returnTo: string
  readonly requestOrigin: string
  /** Return the delivered link once so the inviter can copy it through an approved channel. */
  readonly revealLink?: boolean
  readonly now?: Date
}

export type AuthEmailDeliveryStatus = "sent" | "skipped" | "rate_limited"

export type InviteDeliveryStatus = AuthEmailDeliveryStatus | "not_supported"

export interface RevealedInvitationLink {
  readonly url: string
  readonly expiresAt?: Date
}

export interface InviteDeliveryResult {
  readonly status: InviteDeliveryStatus
  /**
   * Present only when the caller explicitly requests `revealLink`. Treat this as a credential:
   * never persist it or include it in list responses, logs, or analytics.
   */
  readonly link?: RevealedInvitationLink
}

export interface InvitationDeliveryAuthStrategy extends AuthStrategy {
  validateInvitationRecipient?(input: InvitationRecipientInput): Promise<InvitationRecipientResult>
  deliverInvitation(input: InvitationDeliveryInput): Promise<InviteDeliveryResult>
}

export interface MagicLinkRequestInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly email: string
  readonly audience: AuthSessionAudience
  readonly returnTo: string
  readonly requestOrigin: string
  /**
   * Opaque hash the strategy appends to the callback URL as the `requester`
   * query param. The server keeps the preimage in a cookie on the requesting
   * browser so the callback can sign that same browser in without the extra
   * confirmation click. Omitted for deliveries with no requesting browser
   * (invitations).
   */
  readonly requesterHash?: string
  readonly now?: Date
}

export type MagicLinkRequestStatus = AuthEmailDeliveryStatus

export interface MagicLinkRequestResult {
  readonly status: MagicLinkRequestStatus
}

export type AuthInvitationRecipientInput = InvitationRecipientInput

export type AuthInvitationRecipientStatus = InvitationRecipientStatus

export type AuthInvitationRecipientResult = InvitationRecipientResult

export type MagicLinkInvitationRecipientInput = InvitationRecipientInput

export type MagicLinkInvitationRecipientStatus = InvitationRecipientStatus

export type MagicLinkInvitationRecipientResult = InvitationRecipientResult

export interface MagicLinkCallbackInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly magicLinkId: string
  readonly token: string
  readonly session: CompleteAuthSessionInput
  readonly now?: Date
}

export interface MagicLinkCallbackResult extends CompleteSignInResult {
  readonly audience: AuthSessionAudience
  readonly returnTo: string
}

export interface MagicLinkPeekInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly magicLinkId: string
  readonly token: string
  readonly now?: Date
}

export interface MagicLinkPeekResult {
  readonly email: string
}

export interface MagicLinkAuthStrategy extends InvitationDeliveryAuthStrategy {
  readonly kind: "magicLink"
  readonly bootstrapGroupIds?: readonly string[]
  /**
   * How long issued links stay valid (ms). Lets the server align dependent
   * lifetimes (e.g. the same-device pending cookie) with the configured TTL.
   */
  readonly magicLinkTtlMs?: number
  validateInvitationRecipient?(
    input: MagicLinkInvitationRecipientInput
  ): Promise<MagicLinkInvitationRecipientResult>
  requestMagicLink(input: MagicLinkRequestInput): Promise<MagicLinkRequestResult>
  /**
   * Read-only validity check for a link the user has not confirmed yet. Must
   * never consume the token, and must apply the same rules that would make
   * {@link completeMagicLinkSignIn} fail (including token verification), so a
   * link that peeks as valid only fails to complete when raced. Returns null
   * for links that cannot complete sign-in.
   */
  peekMagicLink?(input: MagicLinkPeekInput): Promise<MagicLinkPeekResult | null>
  completeMagicLinkSignIn(input: MagicLinkCallbackInput): Promise<MagicLinkCallbackResult>
}

export interface OidcStartSignInInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly audience: AuthSessionAudience
  readonly returnTo: string
  readonly requestOrigin: string
  readonly now?: Date
}

export interface OidcStartSignInResult {
  readonly redirectTo: string
}

export interface OidcCallbackInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly requestUrl: string
  readonly requestOrigin: string
  readonly session: CompleteAuthSessionInput
  readonly now?: Date
}

export interface OidcCallbackResult extends CompleteSignInResult {
  readonly audience: AuthSessionAudience
  readonly returnTo: string
}

export interface OidcAuthStrategy extends InvitationDeliveryAuthStrategy {
  readonly kind: "oidc"
  readonly bootstrapGroupIds?: readonly string[]
  startOidcSignIn(input: OidcStartSignInInput): Promise<OidcStartSignInResult>
  completeOidcSignIn(input: OidcCallbackInput): Promise<OidcCallbackResult>
}

export interface InviteUserInput {
  readonly email: string
  readonly groups?: readonly GroupDefinition[]
  readonly groupIds?: readonly string[]
  readonly expiresAt?: Date
  readonly returnTo?: string
  /** Reveal the delivered link once in the result. Defaults to false. */
  readonly revealLink?: boolean
}

export interface InviteUserResult {
  readonly invitation: InvitationRecord
  readonly delivery: InviteDeliveryResult
}

export interface ListInvitationsInput {
  readonly email?: string
  readonly statuses?: readonly InvitationStatus[]
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListInvitationsResult {
  readonly invitations: readonly InvitationRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface InvitationGroupOption {
  readonly id: string
  readonly label?: string
  readonly description?: string
}

export type CreateInvitationCapability =
  | { readonly state: "enabled" }
  | {
      readonly state: "disabled"
      readonly reason: "missing_membership_policy" | "invitation_delivery_not_supported"
    }

export interface GetInvitationOptionsResult {
  readonly groups: readonly InvitationGroupOption[]
  readonly canInviteWithoutGroups: boolean
  readonly capabilities: {
    readonly createInvitation: CreateInvitationCapability
  }
}

/**
 * Which membership operations the caller holds at least one policy for. Coarse,
 * caller-wide capabilities used to gate top-level UI affordances; per-target
 * checks (scope over a member's current groups, self-protection) are finer.
 */
export interface MembershipOperationCapabilities {
  readonly invite: boolean
  readonly assignGroups: boolean
  readonly suspend: boolean
}

export interface GetMembershipOptionsResult {
  /** Groups the caller may assign to a member (the `assignGroups` scope). */
  readonly groups: readonly InvitationGroupOption[]
  readonly capabilities: MembershipOperationCapabilities
}

/**
 * What a caller's membership policies let it do — the answer to "may this principal invite?".
 *
 * Resolved from group ids alone, with no HTTP request involved, so project code and tests can ask the
 * question the same way the member-admin routes do.
 */
export interface MembershipCapabilities {
  /** True when at least one policy grants the operation, ignoring which groups it covers. */
  readonly holds: MembershipOperationCapabilities
  /** Group ids the caller may assign to a member. */
  readonly assignableGroupIds: readonly string[]
  /**
   * Whether the caller's policy scope reaches a member currently holding exactly `memberGroups`.
   *
   * Pass definitions when your code knows the groups (`covers("suspend", [teamMembers])`) and ids when
   * they came from a session or a member's stored memberships. An empty list asks the group-less case —
   * inviting someone who joins no group — which any holder of the operation may do.
   *
   * Coverage is not authorization. It is the group boundary the membership policies draw, which is what
   * a UI needs to decide whether to offer a control for a given member. The operation itself applies
   * rules this question cannot see: `suspendMember` refuses the current user, `assignGroups` also checks
   * the groups being assigned against `assignableGroupIds`, and a member's status can rule it out. Ask
   * the runtime method for the decision; ask this for the boundary.
   */
  covers(operation: MembershipOperation, memberGroups: readonly GroupReference[]): boolean
}

export interface ListMembersInput {
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

/** Per-target actions the caller may take on a member, after self-protection. */
export interface MemberCapabilities {
  readonly assignGroups: boolean
  readonly suspend: boolean
  readonly reactivate: boolean
}

export interface MemberSummary {
  readonly user: UserRecord
  readonly groupIds: readonly string[]
  readonly capabilities: MemberCapabilities
}

export interface ListMembersResult {
  readonly members: readonly MemberSummary[]
  readonly hasMore: boolean
  readonly total: number
}

export interface UpdateMemberGroupsInput {
  readonly userId: string
  /** The desired full set of groups; additions and removals are derived from it. */
  readonly groupIds: readonly string[]
}

export interface UpdateMemberGroupsResult {
  readonly user: UserRecord
  readonly groupIds: readonly string[]
}

export interface SuspendMemberInput {
  readonly userId: string
}

export interface SuspendMemberResult {
  readonly user: UserRecord
  readonly groupIds: readonly string[]
}

export interface ReactivateMemberInput {
  readonly userId: string
}

export interface ReactivateMemberResult {
  readonly user: UserRecord
  readonly groupIds: readonly string[]
}

export type AuthCredentialSource = "session" | "accessToken" | "any"

export interface AuthSessionResolutionOptions extends AuthSessionAudienceOptions {
  readonly credentialSource?: AuthCredentialSource
  /** Marks this request as eligible to renew a near-expiry browser session. */
  readonly sessionActivity?: "foreground"
}

export interface InviteUserOptions extends AuthSessionAudienceOptions {
  readonly delivery?: {
    readonly audience?: AuthSessionAudience
    readonly requestOrigin?: string
    readonly returnTo?: string
  }
}

export interface RevokeInvitationInput {
  readonly invitationId: string
}

export interface RevokeInvitationResult {
  readonly invitation: InvitationRecord
}

export interface CreatePersonalAccessTokenInput {
  readonly name: string
  readonly expiresAt: Date
  readonly groupIds?: readonly string[]
}

export interface CreateServiceAccountInput {
  readonly id?: string
  readonly name: string
  readonly description?: string
  readonly groupIds?: readonly string[]
}

export interface CreateServiceAccountResult {
  readonly serviceAccount: ServiceAccountRecord
  readonly groupMemberships: readonly ServiceAccountGroupMembershipRecord[]
}

export interface CreateServiceAccountAccessTokenInput {
  readonly serviceAccountId: string
  readonly name: string
  readonly expiresAt: Date
  readonly groupIds?: readonly string[]
}

export interface CreateAccessTokenResult {
  readonly accessToken: AccessTokenRecord
  readonly tokenValue: string
}

export interface CreateServiceAccountAccessTokenResult extends CreateAccessTokenResult {
  readonly serviceAccount: ServiceAccountRecord
}

export interface ServiceAccountWithGroups {
  readonly serviceAccount: ServiceAccountRecord
  readonly groupIds: readonly string[]
}

export interface ListServiceAccountsResult {
  readonly serviceAccounts: readonly ServiceAccountWithGroups[]
}

export interface ListPersonalAccessTokensResult {
  readonly accessTokens: readonly AccessTokenRecord[]
}

export interface ListServiceAccountAccessTokensInput {
  readonly serviceAccountId: string
}

export interface ListServiceAccountAccessTokensResult {
  readonly serviceAccount: ServiceAccountRecord
  readonly accessTokens: readonly AccessTokenRecord[]
}

export interface DisableServiceAccountInput {
  readonly serviceAccountId: string
}

export interface DisableServiceAccountResult {
  readonly serviceAccount: ServiceAccountRecord
  readonly groupIds: readonly string[]
}

export interface RevokePersonalAccessTokenInput {
  readonly tokenId: string
}

export interface RevokeServiceAccountAccessTokenInput {
  readonly serviceAccountId: string
  readonly tokenId: string
}

export interface RevokeAccessTokenResult {
  readonly accessToken: AccessTokenRecord
}

export interface RevokeServiceAccountAccessTokenResult {
  readonly serviceAccount: ServiceAccountRecord
  readonly accessToken: AccessTokenRecord
}

export interface AuthSessionOptions {
  /** How long a browser session may remain idle before it expires. Defaults to 30 days. */
  readonly idleTimeoutMs?: number
  /** How close to idle expiry a foreground request must be before renewal. Defaults to 7 days. */
  readonly renewalWindowMs?: number
  /**
   * Optional maximum lifetime that foreground activity cannot extend. Captured when the session
   * is created, so later configuration changes affect only newly issued sessions. Disabled by
   * default.
   */
  readonly absoluteTimeoutMs?: number
  /**
   * How long (ms) a resolved session is cached in-process before it is re-validated
   * against storage. Collapses the per-request auth reads (session + user + memberships)
   * during request bursts so they cannot starve the storage pool. Set to 0 to disable.
   * Defaults to {@link DEFAULT_AUTH_SESSION_CACHE_TTL_MS}.
   */
  readonly cacheTtlMs?: number
}

export interface ResolvedAuthSessionOptions {
  readonly idleTimeoutMs: number
  readonly renewalWindowMs: number
  readonly absoluteTimeoutMs?: number
  readonly cacheTtlMs: number
}

export interface AuthCookieOptions {
  readonly sessionCookieName?: string
  readonly csrfCookieName?: string
  readonly cookieDomain?: string
  readonly secure?: boolean | "auto"
  readonly sameSite?: "strict"
  readonly csrfHttpOnly?: boolean
}

export type SixbAuthConfig =
  | AuthStrategy
  | {
      readonly strategy: AuthStrategy
      readonly session?: AuthSessionOptions
      readonly cookies?: AuthCookieOptions
    }

export type AuthSessionFailureReason =
  | "auth_disabled"
  | "missing_credentials"
  | "missing_cookie"
  | "missing_access_token"
  | "invalid_cookie"
  | "invalid_access_token"
  | "invalid_session"
  | "missing_user"
  | "missing_service_account"
  | "suspended_service_account"
  | "suspended_user"

export interface UnauthenticatedAuthSession {
  readonly authenticated: false
  readonly reason: AuthSessionFailureReason
}

export interface AuthenticatedAuthSession {
  readonly authenticated: true
  readonly credentialSource: "session"
  readonly principal: Extract<Principal, { readonly type: "user" }>
  readonly user: UserRecord
  readonly session: SessionRecord
  readonly groupIds: readonly string[]
  /** Internal response hint: the rolling session deadline advanced during this request. */
  readonly sessionRenewed?: true
}

export interface AuthenticatedUserAccessTokenSession {
  readonly authenticated: true
  readonly credentialSource: "accessToken"
  readonly principal: Extract<Principal, { readonly type: "user" }>
  readonly user: UserRecord
  readonly accessToken: AccessTokenRecord
  readonly groupIds: readonly string[]
}

export interface AuthenticatedServiceAccountAccessTokenSession {
  readonly authenticated: true
  readonly credentialSource: "accessToken"
  readonly principal: Extract<Principal, { readonly type: "serviceAccount" }>
  readonly serviceAccount: ServiceAccountRecord
  readonly accessToken: AccessTokenRecord
  readonly groupIds: readonly string[]
}

export type AuthSessionResult = UnauthenticatedAuthSession | AuthenticatedAuthSession

export type AuthenticatedUserRequestSession =
  | AuthenticatedAuthSession
  | AuthenticatedUserAccessTokenSession

export type AuthenticatedRequestAuthSession =
  | AuthenticatedUserRequestSession
  | AuthenticatedServiceAccountAccessTokenSession

export type AuthRequestResult = UnauthenticatedAuthSession | AuthenticatedRequestAuthSession

export interface ResolvedAuthConfig {
  readonly strategy: AuthStrategy | null
  readonly session: ResolvedAuthSessionOptions
  readonly cookies: Required<Omit<AuthCookieOptions, "cookieDomain">> & {
    readonly domain?: string
  }
}
