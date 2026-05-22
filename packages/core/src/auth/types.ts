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

export interface MagicLinkRequestInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly email: string
  readonly returnTo: string
  readonly requestOrigin: string
  readonly now?: Date
}

export type MagicLinkRequestStatus = "sent" | "skipped" | "rate_limited"

export interface MagicLinkRequestResult {
  readonly status: MagicLinkRequestStatus
}

export interface MagicLinkInvitationRecipientInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly email: string
  readonly now?: Date
}

export type MagicLinkInvitationRecipientStatus =
  | "allowed"
  | "invalid_email"
  | "disallowed_domain"
  | "suspended_user"
  | "rate_limited"

export interface MagicLinkInvitationRecipientResult {
  readonly status: MagicLinkInvitationRecipientStatus
  readonly email?: string
}

export interface MagicLinkCallbackInput {
  readonly projectId: string
  readonly authStorage: AuthStorage
  readonly magicLinkId: string
  readonly token: string
  readonly session: CompleteAuthSessionInput
  readonly now?: Date
}

export interface MagicLinkAuthStrategy extends AuthStrategy {
  readonly kind: "magicLink"
  readonly bootstrapGroupIds?: readonly string[]
  validateInvitationRecipient?(
    input: MagicLinkInvitationRecipientInput
  ): Promise<MagicLinkInvitationRecipientResult>
  requestMagicLink(input: MagicLinkRequestInput): Promise<MagicLinkRequestResult>
  completeMagicLinkSignIn(input: MagicLinkCallbackInput): Promise<CompleteSignInResult>
}

export interface InviteUserInput {
  readonly email: string
  readonly groups?: readonly GroupDefinition[]
  readonly groupIds?: readonly string[]
  readonly expiresAt?: Date
  readonly returnTo?: string
}

export type InviteDeliveryStatus = MagicLinkRequestStatus | "not_supported"

export interface InviteDeliveryResult {
  readonly status: InviteDeliveryStatus
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
