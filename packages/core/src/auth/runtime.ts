import { randomUUID } from "node:crypto"
import { type AuthorizationContext, resolveAuthorizationContext } from "../authorization"
import {
  canInviteGroupIds,
  missingInviteGroupIds,
  resolveInvitePolicyScope,
  type SecurityRegistry,
} from "../security"
import type { Storage } from "../storage"
import { type AuthStorage, AuthStorageError, type InvitationRecord } from "../storage/auth"
import { paginate } from "../storage/pagination"
import {
  getCookie,
  type ResolvedAuthCookieOptions,
  resolveAuthCookieOptionsForAudience,
} from "./cookies"
import { AuthRuntimeError } from "./errors"
import { SessionCache } from "./session-cache"
import { hashSessionSecret, parseSessionCookieValue } from "./sessions"
import type {
  AuthenticatedAuthSession,
  AuthSessionResolutionOptions,
  AuthSessionResult,
  AuthStrategy,
  GetInvitationOptionsResult,
  InvitationDeliveryAuthStrategy,
  InvitationRecipientStatus,
  InviteDeliveryResult,
  InviteDeliveryStatus,
  InviteUserInput,
  InviteUserOptions,
  InviteUserResult,
  ListInvitationsInput,
  ListInvitationsResult,
  Principal,
  ResolvedAuthConfig,
  RevokeInvitationInput,
  RevokeInvitationResult,
  SecurityContext,
  SixbAuthConfig,
} from "./types"
import {
  assertNonEmpty,
  isInvitationDeliveryAuthStrategy,
  normalizePagination,
  resolveAuthConfig,
  resolveAuthSessionAudience,
  resolveInvitationExpiresAt,
  sanitizeReturnTo,
} from "./validation"

export {
  DEFAULT_AUTH_INVITATION_TTL_MS,
  DEFAULT_AUTH_SESSION_CACHE_TTL_MS,
  DEFAULT_AUTH_SESSION_TTL_MS,
  MAX_AUTH_INVITATION_TTL_MS,
  resolveAuthConfig,
} from "./validation"

// Throttle `lastSeenAt` writes: only refresh when the previous value is older
// than this, so an active session does not incur a write on every request.
const SESSION_TOUCH_INTERVAL_MS = 60_000

export interface AuthRuntimeOptions {
  readonly projectId: string
  readonly storage: Storage
  readonly security: SecurityRegistry
  readonly config?: SixbAuthConfig
}

export class AuthRuntime {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly security: SecurityRegistry
  private readonly config: ResolvedAuthConfig
  private readonly sessionCache: SessionCache | null

  constructor(options: AuthRuntimeOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.security = options.security
    this.config = resolveAuthConfig(options.config)
    this.sessionCache =
      this.config.session.cacheTtlMs > 0 ? new SessionCache(this.config.session.cacheTtlMs) : null

    if (this.isEnabled() && !this.storage.auth) {
      throw new AuthRuntimeError(
        "auth_storage_missing",
        "[Sixb] Auth is enabled but storage.auth is not configured."
      )
    }
  }

  isEnabled(): boolean {
    const strategy = this.config.strategy
    return strategy !== null && strategy.kind !== "disabled" && strategy.disabled !== true
  }

  getStrategy(): AuthStrategy | null {
    return this.config.strategy
  }

  getSessionTtlMs(): number {
    return this.config.session.ttlMs
  }

  getCookieOptions(options: AuthSessionResolutionOptions = {}): ResolvedAuthCookieOptions {
    return resolveAuthCookieOptionsForAudience(this.config.cookies, options.audience)
  }

  assertCanServeHttp(params: { readonly production: boolean }): void {
    const strategy = this.config.strategy

    if (!strategy) {
      if (params.production) {
        throw new AuthRuntimeError(
          "production_auth_required",
          "[SixbServer] Auth is required in production. Configure auth or use an explicit disabled auth strategy."
        )
      }
      return
    }

    if (params.production && strategy.developmentOnly) {
      throw new AuthRuntimeError(
        "production_auth_required",
        `[SixbServer] Auth strategy '${strategy.id}' is development-only and cannot be used in production.`
      )
    }

    if (
      params.production &&
      (strategy.kind === "disabled" || strategy.disabled === true) &&
      strategy.allowDisabledInProduction !== true
    ) {
      throw new AuthRuntimeError(
        "production_auth_required",
        "[SixbServer] Disabled auth in production requires allowDisabledInProduction: true."
      )
    }
  }

  async getSession(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<AuthSessionResult> {
    if (!this.isEnabled()) {
      return { authenticated: false, reason: "auth_disabled" }
    }

    const audience = resolveAuthSessionAudience(options.audience)
    const cookieOptions = this.getCookieOptions({ audience })
    const cookieValue = getCookie(request, cookieOptions.sessionCookieName)
    if (!cookieValue) {
      return { authenticated: false, reason: "missing_cookie" }
    }

    const parts = parseSessionCookieValue(cookieValue)
    if (!parts) {
      return { authenticated: false, reason: "invalid_cookie" }
    }

    const tokenHash = hashSessionSecret(parts.sessionSecret)
    const nowMs = Date.now()

    const cached = this.sessionCache?.get({
      sessionId: parts.sessionId,
      tokenHash,
      audience,
      nowMs,
    })
    if (cached) {
      return cached
    }

    const storage = this.requireAuthStorage()
    const now = new Date(nowMs)
    const session = await storage.sessions.findValidByTokenHash({
      projectId: this.projectId,
      id: parts.sessionId,
      audience,
      tokenHash,
      now,
    })

    if (!session) {
      return { authenticated: false, reason: "invalid_session" }
    }

    const user = await storage.users.getById({
      projectId: this.projectId,
      id: session.userId,
    })

    if (!user) {
      return { authenticated: false, reason: "missing_user" }
    }

    if (user.status === "suspended") {
      return { authenticated: false, reason: "suspended_user" }
    }

    const memberships = await storage.groupMemberships.listForUser({
      projectId: this.projectId,
      userId: user.id,
    })

    await this.touchSessionLastSeen(storage, session, now)

    const result: AuthenticatedAuthSession = {
      authenticated: true,
      principal: { type: "user", id: user.id },
      user,
      session,
      groupIds: memberships.map((membership) => membership.groupId),
    }

    this.sessionCache?.set({
      sessionId: parts.sessionId,
      tokenHash,
      audience,
      session: result,
      nowMs,
      sessionExpiresAtMs: session.expiresAt.getTime(),
    })

    return result
  }

  /**
   * Evict a session from the in-process cache. Call this when a session is revoked
   * (e.g. sign-out) so the cached result is dropped before its TTL would expire.
   */
  invalidateSession(sessionId: string): void {
    this.sessionCache?.invalidate(sessionId)
  }

  // Best-effort refresh of `lastSeenAt` for the active-sessions view. Throttled,
  // and never allowed to fail an otherwise-valid request.
  private async touchSessionLastSeen(
    storage: AuthStorage,
    session: { readonly id: string; readonly lastSeenAt?: Date },
    now: Date
  ): Promise<void> {
    const lastSeen = session.lastSeenAt?.getTime() ?? 0
    if (now.getTime() - lastSeen < SESSION_TOUCH_INTERVAL_MS) {
      return
    }
    try {
      await storage.sessions.touch({ projectId: this.projectId, id: session.id, lastSeenAt: now })
    } catch {
      // Touch is non-critical; ignore failures so auth still succeeds.
    }
  }

  async requirePrincipal(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<Principal> {
    const session = await this.getSession(request, options)
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Sixb] Authentication is required.")
    }

    return session.principal
  }

  async requireUser(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<AuthenticatedAuthSession> {
    const session = await this.getSession(request, options)
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Sixb] Authentication is required.")
    }

    return session
  }

  async createSecurityContext(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<SecurityContext> {
    const session = await this.requireUser(request, options)
    return {
      principal: session.principal,
      sessionId: session.session.id,
      projectId: this.projectId,
      correlationId: resolveCorrelationId(request),
    }
  }

  /**
   * Resolve the authenticated principal's authorization context for a request.
   *
   * Grants resolve eagerly (`groups -> roles -> grants`, subtype-expanded), so
   * the returned context supports synchronous set-lookup checks and `sixb.as()`.
   */
  async createAuthorizationContext(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<AuthorizationContext> {
    const session = await this.requireUser(request, options)
    return this.contextFromSession(session)
  }

  /**
   * Build an authorization context from an already-resolved session, so callers
   * that resolve the session themselves (e.g. the server auth guard) don't read
   * the request twice.
   */
  contextFromSession(session: AuthenticatedAuthSession): AuthorizationContext {
    return resolveAuthorizationContext({
      principal: session.principal,
      sessionId: session.session.id,
      groupIds: session.groupIds,
      roles: this.security.getResolvedRoles(),
    })
  }

  async getInvitationOptions(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<GetInvitationOptionsResult> {
    const session = await this.requireUser(request, options)
    const scope = this.resolveInvitePolicyScopeForUser(session.groupIds)
    const groups = this.security
      .getGroupDefinitions()
      .filter((group) => scope.canInviteToGroupIds.has(group.id))
      .map((group) => ({
        id: group.id,
        ...(group.label !== undefined ? { label: group.label } : {}),
        ...(group.description !== undefined ? { description: group.description } : {}),
      }))

    return {
      groups,
      canInviteWithoutGroups: scope.canInviteWithoutGroups,
      capabilities: {
        createInvitation: this.resolveCreateInvitationCapability({
          canInviteToGroups: groups.length > 0,
          canInviteWithoutGroups: scope.canInviteWithoutGroups,
        }),
      },
    }
  }

  async invite(
    request: Request,
    input: InviteUserInput,
    options: InviteUserOptions = {}
  ): Promise<InviteUserResult> {
    const session = await this.requireUser(request, options)
    const authStorage = this.requireAuthStorage()
    const now = new Date()
    const groupIds = this.resolveInviteGroupIds(input)
    this.assertCanManageInvitationGroups(session.groupIds, groupIds)

    const strategy = this.getStrategy()
    if (!isInvitationDeliveryAuthStrategy(strategy)) {
      throw new AuthRuntimeError(
        "invalid_auth_config",
        "[Sixb] The active auth strategy does not support invitations."
      )
    }

    await this.assertCanInviteRecipient(strategy, authStorage, input.email, now)

    const invitation = await authStorage.invitations.createOrUpdateActive({
      id: `inv_${randomUUID()}`,
      projectId: this.projectId,
      email: input.email,
      groupIds,
      createdByPrincipal: session.principal,
      createdBySessionId: session.session.id,
      createdAt: now,
      updatedAt: now,
      expiresAt: resolveInvitationExpiresAt(input.expiresAt, now),
    })

    let delivery: InviteDeliveryResult
    try {
      delivery = await strategy.deliverInvitation({
        projectId: this.projectId,
        authStorage,
        invitation,
        audience: resolveAuthSessionAudience(options.audience),
        returnTo: options.delivery?.returnTo ?? sanitizeReturnTo(input.returnTo),
        requestOrigin: options.delivery?.requestOrigin ?? new URL(request.url).origin,
        now,
      })
    } catch (error) {
      await this.revokeInvitationAfterDeliveryFailure(authStorage, invitation, now)
      throw error
    }

    if (delivery.status === "not_supported") {
      return { invitation, delivery }
    }

    if (delivery.status !== "sent") {
      await this.revokeInvitationAfterDeliveryFailure(authStorage, invitation, now)
      throw this.createInvitationDeliveryError(delivery.status)
    }

    return { invitation, delivery }
  }

  async listInvitations(
    request: Request,
    input: ListInvitationsInput = {},
    options: AuthSessionResolutionOptions = {}
  ): Promise<ListInvitationsResult> {
    const session = await this.requireUser(request, options)
    const authStorage = this.requireAuthStorage()
    const { limit, offset } = normalizePagination(input)
    const result = await authStorage.invitations.list({
      projectId: this.projectId,
      email: input.email,
      statuses: input.statuses,
      order: input.order,
    })
    const scope = this.resolveInvitePolicyScopeForUser(session.groupIds)
    const manageable = result.invitations.filter((invitation) =>
      canInviteGroupIds(scope, invitation.groupIds)
    )
    const page = paginate(manageable, { limit, offset })

    return {
      invitations: page.page,
      hasMore: page.hasMore,
      total: page.total,
    }
  }

  async revokeInvitation(
    request: Request,
    input: RevokeInvitationInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<RevokeInvitationResult> {
    const session = await this.requireUser(request, options)
    const authStorage = this.requireAuthStorage()
    const invitationId = assertNonEmpty(input.invitationId, "Invitation id")
    const invitation = await authStorage.invitations.getById({
      projectId: this.projectId,
      id: invitationId,
    })

    if (!invitation) {
      throw new AuthStorageError(
        "missing_invitation",
        `[Sixb] Invitation '${invitationId}' not found for project '${this.projectId}'.`
      )
    }

    this.assertCanManageInvitationGroups(session.groupIds, invitation.groupIds)

    if (invitation.status !== "pending") {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        `[Sixb] Invitation '${invitationId}' is already ${invitation.status} and cannot be revoked.`
      )
    }

    return {
      invitation: await authStorage.invitations.revoke({
        projectId: this.projectId,
        id: invitation.id,
        revokedAt: new Date(),
      }),
    }
  }

  private requireAuthStorage() {
    if (!this.storage.auth) {
      throw new AuthRuntimeError(
        "auth_storage_missing",
        "[Sixb] Auth is enabled but storage.auth is not configured."
      )
    }

    return this.storage.auth
  }

  private resolveInviteGroupIds(input: InviteUserInput): readonly string[] {
    if (input.groups && input.groupIds) {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        "[Sixb] Invitation input cannot provide both groups and groupIds."
      )
    }

    const rawGroupIds =
      input.groupIds ?? input.groups?.map((group) => assertNonEmpty(group.id, "Group id")) ?? []
    const groupIds = [...new Set(rawGroupIds.map((groupId) => assertNonEmpty(groupId, "Group id")))]

    for (const groupId of groupIds) {
      if (!this.security.getGroupById(groupId)) {
        throw new AuthRuntimeError(
          "invalid_auth_input",
          `[Sixb] Unknown invitation group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }

    return groupIds
  }

  private resolveInvitePolicyScopeForUser(callerGroupIds: readonly string[]) {
    return resolveInvitePolicyScope({
      invitePolicies: this.security.getInvitePolicyDefinitions(),
      callerGroupIds,
    })
  }

  private resolveCreateInvitationCapability(input: {
    readonly canInviteToGroups: boolean
    readonly canInviteWithoutGroups: boolean
  }): GetInvitationOptionsResult["capabilities"]["createInvitation"] {
    if (!isInvitationDeliveryAuthStrategy(this.getStrategy())) {
      return { state: "disabled", reason: "invitation_delivery_not_supported" }
    }

    if (!input.canInviteToGroups && !input.canInviteWithoutGroups) {
      return { state: "disabled", reason: "missing_invite_policy" }
    }

    return { state: "enabled" }
  }

  private async assertCanInviteRecipient(
    strategy: InvitationDeliveryAuthStrategy,
    authStorage: AuthStorage,
    email: string,
    now: Date
  ): Promise<void> {
    if (!strategy.validateInvitationRecipient) {
      return
    }

    const result = await strategy.validateInvitationRecipient({
      projectId: this.projectId,
      authStorage,
      email,
      now,
    })

    if (result.status === "allowed") {
      return
    }

    throw createInvitationRecipientError(result.status, result.email ?? email)
  }

  private async revokeInvitationAfterDeliveryFailure(
    authStorage: AuthStorage,
    invitation: InvitationRecord,
    failedAt: Date
  ): Promise<void> {
    await authStorage.invitations.revoke({
      projectId: this.projectId,
      id: invitation.id,
      revokedAt: failedAt,
    })
  }

  private createInvitationDeliveryError(
    status: Exclude<InviteDeliveryStatus, "sent" | "not_supported">
  ) {
    if (status === "rate_limited") {
      return new AuthRuntimeError(
        "rate_limited",
        "[Sixb] Invitation delivery is rate limited. Try again later."
      )
    }

    return new AuthRuntimeError(
      "invalid_auth_input",
      "[Sixb] Invitation delivery was skipped by the active auth strategy."
    )
  }

  private assertCanManageInvitationGroups(
    callerGroupIds: readonly string[],
    groupIds: readonly string[]
  ): void {
    const scope = this.resolveInvitePolicyScopeForUser(callerGroupIds)

    if (canInviteGroupIds(scope, groupIds)) {
      return
    }

    if (groupIds.length === 0) {
      throw new AuthRuntimeError(
        "authorization_denied",
        "[Sixb] The current user is not allowed to create or manage invitations without groups."
      )
    }

    const missing = missingInviteGroupIds(scope, groupIds)
    throw new AuthRuntimeError(
      "authorization_denied",
      `[Sixb] The current user is not allowed to create or manage invitations for group(s): ${missing.join(", ")}.`
    )
  }
}

function resolveCorrelationId(request: Request): string {
  return (
    request.headers.get("x-correlation-id") ?? request.headers.get("x-request-id") ?? randomUUID()
  )
}

function createInvitationRecipientError(
  status: Exclude<InvitationRecipientStatus, "allowed">,
  email: string
): AuthRuntimeError {
  if (status === "rate_limited") {
    return new AuthRuntimeError(
      "rate_limited",
      "[Sixb] Invitation delivery is rate limited. Try again later."
    )
  }

  if (status === "invalid_email") {
    return new AuthRuntimeError("invalid_auth_input", "[Sixb] Invitation email is invalid.")
  }

  if (status === "disallowed_domain") {
    return new AuthRuntimeError(
      "invalid_auth_input",
      `[Sixb] Invitation email '${email}' is not allowed by the active auth strategy.`
    )
  }

  return new AuthRuntimeError(
    "invalid_auth_input",
    `[Sixb] Invitation email '${email}' belongs to a suspended user.`
  )
}
