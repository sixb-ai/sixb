import type { GroupDefinition } from "../security"
import type {
  AuthStorage,
  CompleteAuthSessionInput,
  CompleteSignInResult,
  InvitationRecord,
  InvitationStatus,
  SessionRecord,
  UserRecord,
} from "../storage/auth"
import type { AuthSessionAudience, AuthSessionAudienceOptions } from "./audience"

export type Principal =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "serviceAccount"; readonly id: string }
  | { readonly type: "system"; readonly id: string }

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
  readonly now?: Date
}

export type AuthEmailDeliveryStatus = "sent" | "skipped" | "rate_limited"

export type InviteDeliveryStatus = AuthEmailDeliveryStatus | "not_supported"

export interface InviteDeliveryResult {
  readonly status: InviteDeliveryStatus
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

export interface MagicLinkAuthStrategy extends InvitationDeliveryAuthStrategy {
  readonly kind: "magicLink"
  readonly bootstrapGroupIds?: readonly string[]
  validateInvitationRecipient?(
    input: MagicLinkInvitationRecipientInput
  ): Promise<MagicLinkInvitationRecipientResult>
  requestMagicLink(input: MagicLinkRequestInput): Promise<MagicLinkRequestResult>
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
      readonly reason: "missing_invite_policy" | "invitation_delivery_not_supported"
    }

export interface GetInvitationOptionsResult {
  readonly groups: readonly InvitationGroupOption[]
  readonly canInviteWithoutGroups: boolean
  readonly capabilities: {
    readonly createInvitation: CreateInvitationCapability
  }
}

export type AuthSessionResolutionOptions = AuthSessionAudienceOptions

export interface InviteUserOptions extends AuthSessionAudienceOptions {
  readonly delivery?: {
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

export interface AuthSessionOptions {
  readonly ttlMs?: number
}

export interface AuthCookieOptions {
  readonly sessionCookieName?: string
  readonly csrfCookieName?: string
  readonly cookieDomain?: string
  readonly secure?: boolean | "auto"
  readonly sameSite?: "strict"
  readonly csrfHttpOnly?: boolean
}

export type ParioAuthConfig =
  | AuthStrategy
  | {
      readonly strategy: AuthStrategy
      readonly session?: AuthSessionOptions
      readonly cookies?: AuthCookieOptions
    }

export type AuthSessionFailureReason =
  | "auth_disabled"
  | "missing_cookie"
  | "invalid_cookie"
  | "invalid_session"
  | "missing_user"
  | "suspended_user"

export interface UnauthenticatedAuthSession {
  readonly authenticated: false
  readonly reason: AuthSessionFailureReason
}

export interface AuthenticatedAuthSession {
  readonly authenticated: true
  readonly principal: Extract<Principal, { readonly type: "user" }>
  readonly user: UserRecord
  readonly session: SessionRecord
  readonly groupIds: readonly string[]
}

export type AuthSessionResult = UnauthenticatedAuthSession | AuthenticatedAuthSession

export interface ResolvedAuthConfig {
  readonly strategy: AuthStrategy | null
  readonly session: Required<AuthSessionOptions>
  readonly cookies: Required<Omit<AuthCookieOptions, "cookieDomain">> & {
    readonly domain?: string
  }
}
