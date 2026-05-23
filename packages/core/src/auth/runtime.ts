import { randomUUID } from "node:crypto"
import {
  canInviteGroupIds,
  missingInviteGroupIds,
  resolveInvitePolicyScope,
  type SecurityRegistry,
} from "../security"
import type { Storage } from "../storage"
import { type AuthStorage, AuthStorageError, type InvitationRecord } from "../storage/auth"
import { paginate } from "../storage/pagination"
import { getCookie, type ResolvedAuthCookieOptions } from "./cookies"
import { AuthRuntimeError } from "./errors"
import { hashSessionSecret, parseSessionCookieValue } from "./sessions"
import type {
  AuthenticatedAuthSession,
  AuthSessionResult,
  AuthStrategy,
  InvitationDeliveryAuthStrategy,
  InviteDeliveryResult,
  InviteDeliveryStatus,
  InviteUserInput,
  InviteUserResult,
  ListInvitationsInput,
  ListInvitationsResult,
  ParioAuthConfig,
  Principal,
  ResolvedAuthConfig,
  RevokeInvitationInput,
  RevokeInvitationResult,
  SecurityContext,
} from "./types"
import {
  assertNonEmpty,
  isInvitationDeliveryAuthStrategy,
  normalizePagination,
  resolveAuthConfig,
  resolveInvitationExpiresAt,
  sanitizeReturnTo,
} from "./validation"

export {
  DEFAULT_AUTH_INVITATION_TTL_MS,
  DEFAULT_AUTH_SESSION_TTL_MS,
  MAX_AUTH_INVITATION_TTL_MS,
  resolveAuthConfig,
} from "./validation"

export interface ParioAuthRuntimeOptions {
  readonly projectId: string
  readonly storage: Storage
  readonly security: SecurityRegistry
  readonly config?: ParioAuthConfig
}

export class ParioAuthRuntime {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly security: SecurityRegistry
  private readonly config: ResolvedAuthConfig

  constructor(options: ParioAuthRuntimeOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.security = options.security
    this.config = resolveAuthConfig(options.config)

    if (this.isEnabled() && !this.storage.auth) {
      throw new AuthRuntimeError(
        "auth_storage_missing",
        "[Pario] Auth is enabled but storage.auth is not configured."
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

  getCookieOptions(): ResolvedAuthCookieOptions {
    return this.config.cookies
  }

  assertCanServeHttp(params: { readonly production: boolean }): void {
    const strategy = this.config.strategy

    if (!strategy) {
      if (params.production) {
        throw new AuthRuntimeError(
          "production_auth_required",
          "[ParioServer] Auth is required in production. Configure auth or use an explicit disabled auth strategy."
        )
      }
      return
    }

    if (params.production && strategy.developmentOnly) {
      throw new AuthRuntimeError(
        "production_auth_required",
        `[ParioServer] Auth strategy '${strategy.id}' is development-only and cannot be used in production.`
      )
    }

    if (
      params.production &&
      (strategy.kind === "disabled" || strategy.disabled === true) &&
      strategy.allowDisabledInProduction !== true
    ) {
      throw new AuthRuntimeError(
        "production_auth_required",
        "[ParioServer] Disabled auth in production requires allowDisabledInProduction: true."
      )
    }
  }

  async getSession(request: Request): Promise<AuthSessionResult> {
    if (!this.isEnabled()) {
      return { authenticated: false, reason: "auth_disabled" }
    }

    const cookieValue = getCookie(request, this.config.cookies.sessionCookieName)
    if (!cookieValue) {
      return { authenticated: false, reason: "missing_cookie" }
    }

    const parts = parseSessionCookieValue(cookieValue)
    if (!parts) {
      return { authenticated: false, reason: "invalid_cookie" }
    }

    const storage = this.requireAuthStorage()
    const session = await storage.sessions.findValidByTokenHash({
      projectId: this.projectId,
      id: parts.sessionId,
      tokenHash: hashSessionSecret(parts.sessionSecret),
      now: new Date(),
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

    return {
      authenticated: true,
      principal: { type: "user", id: user.id },
      user,
      session,
      groupIds: memberships.map((membership) => membership.groupId),
    }
  }

  async requirePrincipal(request: Request): Promise<Principal> {
    const session = await this.getSession(request)
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Pario] Authentication is required.")
    }

    return session.principal
  }

  async requireUser(request: Request): Promise<AuthenticatedAuthSession> {
    const session = await this.getSession(request)
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Pario] Authentication is required.")
    }

    return session
  }

  async createSecurityContext(request: Request): Promise<SecurityContext> {
    const session = await this.requireUser(request)
    return {
      principal: session.principal,
      sessionId: session.session.id,
      projectId: this.projectId,
      correlationId: resolveCorrelationId(request),
    }
  }

  async invite(request: Request, input: InviteUserInput): Promise<InviteUserResult> {
    const session = await this.requireUser(request)
    const authStorage = this.requireAuthStorage()
    const now = new Date()
    const groupIds = this.resolveInviteGroupIds(input)
    this.assertCanManageInvitationGroups(session.groupIds, groupIds)

    const strategy = this.getStrategy()
    if (!isInvitationDeliveryAuthStrategy(strategy)) {
      throw new AuthRuntimeError(
        "invalid_auth_config",
        "[Pario] The active auth strategy does not support invitation email delivery."
      )
    }

    await this.assertCanDeliverInvitation(strategy, authStorage, input.email, now)

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
        returnTo: sanitizeReturnTo(input.returnTo),
        requestOrigin: new URL(request.url).origin,
        now,
      })
    } catch (error) {
      await this.revokeInvitationAfterDeliveryFailure(authStorage, invitation, now)
      throw error
    }

    if (delivery.status !== "sent") {
      await this.revokeInvitationAfterDeliveryFailure(authStorage, invitation, now)
      throw this.createInvitationDeliveryError(delivery.status)
    }

    return { invitation, delivery }
  }

  async listInvitations(
    request: Request,
    input: ListInvitationsInput = {}
  ): Promise<ListInvitationsResult> {
    const session = await this.requireUser(request)
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
    input: RevokeInvitationInput
  ): Promise<RevokeInvitationResult> {
    const session = await this.requireUser(request)
    const authStorage = this.requireAuthStorage()
    const invitationId = assertNonEmpty(input.invitationId, "Invitation id")
    const invitation = await authStorage.invitations.getById({
      projectId: this.projectId,
      id: invitationId,
    })

    if (!invitation) {
      throw new AuthStorageError(
        "missing_invitation",
        `[Pario] Invitation '${invitationId}' not found for project '${this.projectId}'.`
      )
    }

    this.assertCanManageInvitationGroups(session.groupIds, invitation.groupIds)

    if (invitation.status !== "pending") {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        `[Pario] Invitation '${invitationId}' is already ${invitation.status} and cannot be revoked.`
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
        "[Pario] Auth is enabled but storage.auth is not configured."
      )
    }

    return this.storage.auth
  }

  private resolveInviteGroupIds(input: InviteUserInput): readonly string[] {
    if (input.groups && input.groupIds) {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        "[Pario] Invitation input cannot provide both groups and groupIds."
      )
    }

    const rawGroupIds =
      input.groupIds ?? input.groups?.map((group) => assertNonEmpty(group.id, "Group id")) ?? []
    const groupIds = [...new Set(rawGroupIds.map((groupId) => assertNonEmpty(groupId, "Group id")))]

    for (const groupId of groupIds) {
      if (!this.security.getGroupById(groupId)) {
        throw new AuthRuntimeError(
          "invalid_auth_input",
          `[Pario] Unknown invitation group '${groupId}'. Add it to 'security/groups/' or pass it to createPario({ groups }).`
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

  private async assertCanDeliverInvitation(
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

    if (result.status === "rate_limited") {
      throw new AuthRuntimeError(
        "rate_limited",
        "[Pario] Invitation delivery is rate limited. Try again later."
      )
    }

    if (result.status === "invalid_email") {
      throw new AuthRuntimeError("invalid_auth_input", "[Pario] Invitation email is invalid.")
    }

    if (result.status === "disallowed_domain") {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        `[Pario] Invitation email '${result.email ?? email}' is not allowed by the active auth strategy.`
      )
    }

    if (result.status === "suspended_user") {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        `[Pario] Invitation email '${result.email ?? email}' belongs to a suspended user.`
      )
    }
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

  private createInvitationDeliveryError(status: Exclude<InviteDeliveryStatus, "sent">) {
    if (status === "rate_limited") {
      return new AuthRuntimeError(
        "rate_limited",
        "[Pario] Invitation delivery is rate limited. Try again later."
      )
    }

    if (status === "not_supported") {
      return new AuthRuntimeError(
        "invalid_auth_config",
        "[Pario] The active auth strategy does not support invitation email delivery."
      )
    }

    return new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation delivery was skipped by the active auth strategy."
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
        "[Pario] The current user is not allowed to create or manage invitations without groups."
      )
    }

    const missing = missingInviteGroupIds(scope, groupIds)
    throw new AuthRuntimeError(
      "authorization_denied",
      `[Pario] The current user is not allowed to create or manage invitations for group(s): ${missing.join(", ")}.`
    )
  }
}

function resolveCorrelationId(request: Request): string {
  return (
    request.headers.get("x-correlation-id") ?? request.headers.get("x-request-id") ?? randomUUID()
  )
}
