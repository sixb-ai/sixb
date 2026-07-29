import { randomUUID } from "node:crypto"
import {
  type AuthorizationContext,
  canAccessApplication,
  resolveAuthorizationContext,
} from "../authorization"
import {
  canPerformMembershipOperation,
  type MembershipOperation,
  type MembershipPolicyScope,
  missingMembershipGroupIds,
  resolveMembershipPolicyScope,
  type SecurityRegistry,
} from "../security"
import type { Storage } from "../storage"
import {
  type AccessTokenRecord,
  type AuthStorage,
  AuthStorageError,
  type InvitationRecord,
  type ServiceAccountGroupMembershipRecord,
  type ServiceAccountRecord,
  type SessionRecord,
  type UserRecord,
} from "../storage/auth"
import { paginate } from "../storage/pagination"
import {
  createAccessTokenCredential,
  getBearerAccessTokenValue,
  hashAccessTokenSecret,
  parseAccessTokenValue,
} from "./access-tokens"
import type { AuthSessionAudience } from "./audience"
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
  AuthenticatedRequestAuthSession,
  AuthenticatedUserRequestSession,
  AuthRequestResult,
  AuthSessionResolutionOptions,
  AuthSessionResult,
  AuthStrategy,
  CreateAccessTokenResult,
  CreatePersonalAccessTokenInput,
  CreateServiceAccountAccessTokenInput,
  CreateServiceAccountAccessTokenResult,
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  DisableServiceAccountInput,
  DisableServiceAccountResult,
  GetInvitationOptionsResult,
  GetMembershipOptionsResult,
  InvitationDeliveryAuthStrategy,
  InvitationGroupOption,
  InvitationRecipientStatus,
  InviteDeliveryResult,
  InviteDeliveryStatus,
  InviteUserInput,
  InviteUserOptions,
  InviteUserResult,
  ListInvitationsInput,
  ListInvitationsResult,
  ListMembersInput,
  ListMembersResult,
  ListPersonalAccessTokensResult,
  ListServiceAccountAccessTokensInput,
  ListServiceAccountAccessTokensResult,
  ListServiceAccountsResult,
  MemberSummary,
  Principal,
  ReactivateMemberInput,
  ReactivateMemberResult,
  ResolvedAuthConfig,
  RevokeAccessTokenResult,
  RevokeInvitationInput,
  RevokeInvitationResult,
  RevokePersonalAccessTokenInput,
  RevokeServiceAccountAccessTokenInput,
  RevokeServiceAccountAccessTokenResult,
  SecurityContext,
  SixbAuthConfig,
  SuspendMemberInput,
  SuspendMemberResult,
  UpdateMemberGroupsInput,
  UpdateMemberGroupsResult,
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
  DEFAULT_AUTH_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_AUTH_SESSION_RENEWAL_WINDOW_MS,
  MAX_AUTH_INVITATION_TTL_MS,
  resolveAuthConfig,
} from "./validation"

// Throttle `lastSeenAt` writes: only refresh when the previous value is older
// than this, so an active session does not incur a write on every request.
const SESSION_TOUCH_INTERVAL_MS = 60_000
const ACCESS_TOKEN_TOUCH_INTERVAL_MS = 60_000

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

  createSessionDeadlines(now: Date): {
    readonly expiresAt: Date
    readonly absoluteExpiresAt?: Date
  } {
    const absoluteTimeoutMs = this.config.session.absoluteTimeoutMs
    return {
      expiresAt: new Date(now.getTime() + this.config.session.idleTimeoutMs),
      ...(absoluteTimeoutMs === undefined
        ? {}
        : { absoluteExpiresAt: new Date(now.getTime() + absoluteTimeoutMs) }),
    }
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
    options?: AuthSessionResolutionOptions & { readonly credentialSource?: "session" }
  ): Promise<AuthSessionResult>
  async getSession(
    request: Request,
    options: AuthSessionResolutionOptions & { readonly credentialSource: "accessToken" | "any" }
  ): Promise<AuthRequestResult>
  async getSession(
    request: Request,
    options: AuthSessionResolutionOptions
  ): Promise<AuthRequestResult>
  async getSession(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<AuthSessionResult | AuthRequestResult> {
    if (!this.isEnabled()) {
      return { authenticated: false, reason: "auth_disabled" }
    }

    const audience = resolveAuthSessionAudience(options.audience)
    const credentialSource = options.credentialSource ?? "session"

    if (credentialSource !== "session") {
      const authorizationHeader = request.headers.get("authorization")
      const tokenValue = getBearerAccessTokenValue(request)
      if (tokenValue) {
        return this.resolveAccessTokenSession(request, tokenValue)
      }

      if (authorizationHeader) {
        return { authenticated: false, reason: "invalid_access_token" }
      }

      if (credentialSource === "accessToken") {
        return { authenticated: false, reason: "missing_access_token" }
      }
    }

    return this.resolveCookieSession(request, audience, options.sessionActivity)
  }

  private async resolveCookieSession(
    request: Request,
    audience: ReturnType<typeof resolveAuthSessionAudience>,
    activity: AuthSessionResolutionOptions["sessionActivity"]
  ): Promise<AuthSessionResult> {
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
      if (activity !== "foreground" || !this.canRenewSession(cached.session, nowMs)) {
        return cached
      }
      this.sessionCache?.invalidate(parts.sessionId)
    }

    const storage = this.requireAuthStorage()
    const now = new Date(nowMs)
    let session = await storage.sessions.findValidByTokenHash({
      projectId: this.projectId,
      id: parts.sessionId,
      audience,
      tokenHash,
      now,
    })

    if (!session) {
      return { authenticated: false, reason: "invalid_session" }
    }

    let sessionRenewed = false
    if (activity === "foreground" && this.canRenewSession(session, nowMs)) {
      const renewed = await storage.sessions.renewIfValid({
        projectId: this.projectId,
        id: parts.sessionId,
        audience,
        tokenHash,
        now,
        expiresAt: this.getRenewedSessionExpiresAt(session, nowMs),
      })
      if (!renewed) {
        this.sessionCache?.invalidate(parts.sessionId)
        return { authenticated: false, reason: "invalid_session" }
      }
      session = renewed
      sessionRenewed = true
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

    if (!sessionRenewed) {
      await this.touchSessionLastSeen(storage, session, now)
    }

    const result: AuthenticatedAuthSession = {
      authenticated: true,
      credentialSource: "session",
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
      sessionAbsoluteExpiresAtMs: session.absoluteExpiresAt?.getTime(),
    })

    return sessionRenewed ? { ...result, sessionRenewed: true } : result
  }

  private canRenewSession(session: SessionRecord, nowMs: number): boolean {
    if (session.expiresAt.getTime() - nowMs > this.config.session.renewalWindowMs) {
      return false
    }

    return this.getRenewedSessionExpiresAt(session, nowMs).getTime() > session.expiresAt.getTime()
  }

  private getRenewedSessionExpiresAt(session: SessionRecord, nowMs: number): Date {
    const idleExpiresAtMs = nowMs + this.config.session.idleTimeoutMs
    return new Date(
      session.absoluteExpiresAt
        ? Math.min(idleExpiresAtMs, session.absoluteExpiresAt.getTime())
        : idleExpiresAtMs
    )
  }

  private async resolveAccessTokenSession(
    request: Request,
    tokenValue: string
  ): Promise<AuthRequestResult> {
    const parts = parseAccessTokenValue(tokenValue)
    if (!parts) {
      return { authenticated: false, reason: "invalid_access_token" }
    }

    const storage = this.requireAuthStorage()
    const now = new Date()
    const accessToken = await storage.accessTokens.findValidByTokenHash({
      projectId: this.projectId,
      id: parts.tokenId,
      kind: parts.kind,
      tokenHash: hashAccessTokenSecret(parts.tokenSecret),
      now,
    })

    if (!accessToken) {
      return { authenticated: false, reason: "invalid_access_token" }
    }

    await this.touchAccessTokenLastUsed(storage, accessToken, request, now)

    if (accessToken.subjectType === "user") {
      const user = await storage.users.getById({
        projectId: this.projectId,
        id: accessToken.subjectId,
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
        credentialSource: "accessToken",
        principal: { type: "user", id: user.id },
        user,
        accessToken,
        groupIds: constrainTokenGroupIds(
          memberships.map((membership) => membership.groupId),
          accessToken
        ),
      }
    }

    const serviceAccount = await storage.serviceAccounts.getById({
      projectId: this.projectId,
      id: accessToken.subjectId,
    })

    if (!serviceAccount) {
      return { authenticated: false, reason: "missing_service_account" }
    }

    if (serviceAccount.status === "suspended") {
      return { authenticated: false, reason: "suspended_service_account" }
    }

    const memberships = await storage.serviceAccountGroupMemberships.listForServiceAccount({
      projectId: this.projectId,
      serviceAccountId: serviceAccount.id,
    })

    return {
      authenticated: true,
      credentialSource: "accessToken",
      principal: { type: "serviceAccount", id: serviceAccount.id },
      serviceAccount,
      accessToken,
      groupIds: constrainTokenGroupIds(
        memberships.map((membership) => membership.groupId),
        accessToken
      ),
    }
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

  private async touchAccessTokenLastUsed(
    storage: AuthStorage,
    accessToken: AccessTokenRecord,
    request: Request,
    now: Date
  ): Promise<void> {
    const lastUsed = accessToken.lastUsedAt?.getTime() ?? 0
    if (now.getTime() - lastUsed < ACCESS_TOKEN_TOUCH_INTERVAL_MS) {
      return
    }

    try {
      await storage.accessTokens.touch({
        projectId: this.projectId,
        id: accessToken.id,
        lastUsedAt: now,
        userAgent: request.headers.get("user-agent")?.trim() || undefined,
        ipAddress: resolveRequestIpAddress(request),
      })
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
    const session = await this.getSession(request, { ...options, credentialSource: "session" })
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Sixb] Authentication is required.")
    }

    return session
  }

  async requireUserRequest(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<AuthenticatedUserRequestSession> {
    const session = await this.getSession(request, { ...options, credentialSource: "any" })
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Sixb] Authentication is required.")
    }

    if (!isAuthenticatedUserRequestSession(session)) {
      throw new AuthRuntimeError("authorization_denied", "[Sixb] User authentication is required.")
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
    const session = await this.getSession(request, options)
    if (!session.authenticated) {
      throw new AuthRuntimeError("authentication_required", "[Sixb] Authentication is required.")
    }

    return this.contextFromSession(session)
  }

  /**
   * Build an authorization context from an already-resolved session, so callers
   * that resolve the session themselves (e.g. the server auth guard) don't read
   * the request twice.
   */
  contextFromSession(session: AuthenticatedRequestAuthSession): AuthorizationContext {
    return resolveAuthorizationContext({
      principal: session.principal,
      sessionId: session.credentialSource === "session" ? session.session.id : undefined,
      groupIds: session.groupIds,
      roles: this.security.listResolvedRoles(),
    })
  }

  async listPersonalAccessTokens(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<ListPersonalAccessTokensResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const result = await storage.accessTokens.list({
      projectId: this.projectId,
      kind: "personal",
      subjectType: "user",
      subjectId: session.user.id,
      includeRevoked: true,
      order: "desc",
      limit: 100,
    })

    return { accessTokens: result.accessTokens }
  }

  async createPersonalAccessToken(
    request: Request,
    input: CreatePersonalAccessTokenInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<CreateAccessTokenResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    // A personal token can only carry groups the caller currently belongs to.
    const groupIds = constrainRequestedGroupIds(input.groupIds, session.groupIds, {
      subject: "personal access token",
    })
    const credential = createAccessTokenCredential("personal")
    const accessToken = await storage.accessTokens.create({
      id: credential.tokenId,
      projectId: this.projectId,
      name: input.name,
      kind: "personal",
      subjectType: "user",
      subjectId: session.user.id,
      tokenHash: credential.tokenHash,
      groupIds,
      createdByPrincipal: session.principal,
      createdBySessionId: session.credentialSource === "session" ? session.session.id : undefined,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    })

    return { accessToken, tokenValue: credential.tokenValue }
  }

  async revokePersonalAccessToken(
    request: Request,
    input: RevokePersonalAccessTokenInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<RevokeAccessTokenResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const token = await storage.accessTokens.getById({
      projectId: this.projectId,
      id: input.tokenId,
    })
    // Personal tokens are self-service only. A foreign or missing token id is
    // reported identically so callers cannot probe other principals' tokens.
    if (
      !token ||
      token.kind !== "personal" ||
      token.subjectType !== "user" ||
      token.subjectId !== session.user.id
    ) {
      throw missingAccessTokenError(input.tokenId, this.projectId)
    }

    const accessToken = await storage.accessTokens.revoke({
      projectId: this.projectId,
      id: input.tokenId,
      revokedAt: new Date(),
    })

    return { accessToken }
  }

  async listServiceAccounts(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<ListServiceAccountsResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const result = await storage.serviceAccounts.list({
      projectId: this.projectId,
      order: "desc",
      limit: 100,
    })
    const withGroups = await Promise.all(
      result.serviceAccounts.map(async (serviceAccount) => ({
        serviceAccount,
        groupIds: await this.listServiceAccountGroupIds(storage, serviceAccount.id),
      }))
    )

    // A caller only sees the service accounts it is allowed to manage, so
    // listing never leaks the groups of more-privileged accounts.
    return {
      serviceAccounts: withGroups.filter(({ groupIds }) =>
        callerCanManageServiceAccount(session.groupIds, groupIds)
      ),
    }
  }

  async createServiceAccount(
    request: Request,
    input: CreateServiceAccountInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<CreateServiceAccountResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    // A caller can only place a service account in groups it itself belongs to.
    const groupIds =
      constrainRequestedGroupIds(input.groupIds, session.groupIds, {
        subject: "service account",
      }) ?? []
    const now = new Date()
    const serviceAccount = await storage.serviceAccounts.create({
      id: input.id ?? `svc_${randomUUID()}`,
      projectId: this.projectId,
      name: input.name,
      description: input.description,
      createdByPrincipal: session.principal,
      createdBySessionId: session.credentialSource === "session" ? session.session.id : undefined,
      createdAt: now,
      updatedAt: now,
    })
    const groupMemberships: ServiceAccountGroupMembershipRecord[] = []
    for (const groupId of groupIds) {
      groupMemberships.push(
        await storage.serviceAccountGroupMemberships.upsert({
          projectId: this.projectId,
          serviceAccountId: serviceAccount.id,
          groupId,
          source: "manual",
          createdAt: now,
        })
      )
    }

    return { serviceAccount, groupMemberships }
  }

  async disableServiceAccount(
    request: Request,
    input: DisableServiceAccountInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<DisableServiceAccountResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const { serviceAccount, groupIds } = await this.requireManageableServiceAccount(
      storage,
      session.groupIds,
      input.serviceAccountId
    )
    const updated = await storage.serviceAccounts.update({
      projectId: this.projectId,
      id: serviceAccount.id,
      status: "suspended",
      updatedAt: new Date(),
    })

    return { serviceAccount: updated, groupIds }
  }

  async listServiceAccountAccessTokens(
    request: Request,
    input: ListServiceAccountAccessTokensInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<ListServiceAccountAccessTokensResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const { serviceAccount } = await this.requireManageableServiceAccount(
      storage,
      session.groupIds,
      input.serviceAccountId
    )
    const result = await storage.accessTokens.list({
      projectId: this.projectId,
      kind: "serviceAccount",
      subjectType: "serviceAccount",
      subjectId: serviceAccount.id,
      includeRevoked: true,
      order: "desc",
      limit: 100,
    })

    return { serviceAccount, accessTokens: result.accessTokens }
  }

  async createServiceAccountAccessToken(
    request: Request,
    input: CreateServiceAccountAccessTokenInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<CreateServiceAccountAccessTokenResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const { serviceAccount, groupIds: serviceAccountGroupIds } =
      await this.requireManageableServiceAccount(storage, session.groupIds, input.serviceAccountId)

    if (serviceAccount.status === "suspended") {
      throw new AuthStorageError(
        "suspended_service_account",
        `[Sixb] Service account '${input.serviceAccountId}' is suspended for project '${this.projectId}'.`
      )
    }

    // The token can only carry groups the service account already holds; the
    // manageability check above guarantees those are a subset of the caller's
    // own groups, so the caller can never mint privileges it lacks.
    const groupIds = constrainRequestedGroupIds(input.groupIds, serviceAccountGroupIds, {
      subject: "service account token",
    })
    const credential = createAccessTokenCredential("serviceAccount")
    const accessToken = await storage.accessTokens.create({
      id: credential.tokenId,
      projectId: this.projectId,
      name: input.name,
      kind: "serviceAccount",
      subjectType: "serviceAccount",
      subjectId: serviceAccount.id,
      tokenHash: credential.tokenHash,
      groupIds,
      createdByPrincipal: session.principal,
      createdBySessionId: session.credentialSource === "session" ? session.session.id : undefined,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    })

    return { accessToken, tokenValue: credential.tokenValue, serviceAccount }
  }

  async revokeServiceAccountAccessToken(
    request: Request,
    input: RevokeServiceAccountAccessTokenInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<RevokeServiceAccountAccessTokenResult> {
    const session = await this.requireUserRequest(request, options)
    const storage = this.requireAuthStorage()
    const { serviceAccount } = await this.requireManageableServiceAccount(
      storage,
      session.groupIds,
      input.serviceAccountId
    )
    const token = await storage.accessTokens.getById({
      projectId: this.projectId,
      id: input.tokenId,
    })
    // The token must belong to the service account named in the request.
    if (
      !token ||
      token.kind !== "serviceAccount" ||
      token.subjectType !== "serviceAccount" ||
      token.subjectId !== serviceAccount.id
    ) {
      throw missingAccessTokenError(input.tokenId, this.projectId)
    }

    const accessToken = await storage.accessTokens.revoke({
      projectId: this.projectId,
      id: input.tokenId,
      revokedAt: new Date(),
    })

    return { serviceAccount, accessToken }
  }

  /**
   * Resolve a service account the caller is allowed to manage.
   *
   * A caller may manage a service account only when it belongs to every group
   * the account is in ("you can manage what you could have created"). This
   * confines token minting, disabling, and revocation to privileges the caller
   * already holds and prevents a service-account token from outliving the
   * caller's own access. Missing and non-manageable accounts raise the same
   * error so callers cannot probe which privileged accounts exist.
   */
  private async requireManageableServiceAccount(
    storage: AuthStorage,
    callerGroupIds: readonly string[],
    serviceAccountId: string
  ): Promise<{
    readonly serviceAccount: ServiceAccountRecord
    readonly groupIds: readonly string[]
  }> {
    const serviceAccount = await storage.serviceAccounts.getById({
      projectId: this.projectId,
      id: serviceAccountId,
    })
    const groupIds = serviceAccount
      ? await this.listServiceAccountGroupIds(storage, serviceAccountId)
      : []

    if (!serviceAccount || !callerCanManageServiceAccount(callerGroupIds, groupIds)) {
      throw new AuthStorageError(
        "missing_service_account",
        `[Sixb] Service account '${serviceAccountId}' not found for project '${this.projectId}'.`
      )
    }

    return { serviceAccount, groupIds }
  }

  private async listServiceAccountGroupIds(
    storage: AuthStorage,
    serviceAccountId: string
  ): Promise<readonly string[]> {
    const memberships = await storage.serviceAccountGroupMemberships.listForServiceAccount({
      projectId: this.projectId,
      serviceAccountId,
    })
    return memberships.map((membership) => membership.groupId)
  }

  async getInvitationOptions(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<GetInvitationOptionsResult> {
    const session = await this.requireUser(request, options)
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const inviteScope = scope.operations.invite
    const groups = this.scopedGroupOptions(inviteScope.groupIds)
    const hasInviteMembershipPolicy = inviteScope.policyIds.length > 0

    return {
      groups,
      canInviteWithoutGroups: hasInviteMembershipPolicy,
      capabilities: {
        createInvitation: this.resolveCreateInvitationCapability({
          canInvite: hasInviteMembershipPolicy,
        }),
      },
    }
  }

  async getMembershipOptions(
    request: Request,
    options: AuthSessionResolutionOptions = {}
  ): Promise<GetMembershipOptionsResult> {
    const session = await this.requireUser(request, options)
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)

    return {
      // The member-admin edit-groups dialog assigns from the `assignGroups` scope.
      groups: this.scopedGroupOptions(scope.operations.assignGroups.groupIds),
      capabilities: {
        invite: scope.operations.invite.policyIds.length > 0,
        assignGroups: scope.operations.assignGroups.policyIds.length > 0,
        suspend: scope.operations.suspend.policyIds.length > 0,
      },
    }
  }

  async listMembers(
    request: Request,
    input: ListMembersInput = {},
    options: AuthSessionResolutionOptions = {}
  ): Promise<ListMembersResult> {
    const session = await this.requireUser(request, options)
    const storage = this.requireAuthStorage()
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const { limit, offset } = normalizePagination(input)

    // First slice loads all users, attaches groups, then filters and paginates in
    // memory. Adequate for expected member counts; revisit with indexed queries if
    // projects grow large.
    const result = await storage.users.list({ projectId: this.projectId, order: input.order })

    const members: MemberSummary[] = []
    for (const user of result.users) {
      const groupIds = (
        await storage.groupMemberships.listForUser({ projectId: this.projectId, userId: user.id })
      ).map((membership) => membership.groupId)

      // Visibility is scope-based: a member is listed when the caller can assign
      // groups or suspend over the member's current groups. This keeps out-of-scope
      // users' emails, status, and group shape hidden.
      const canAssignGroups = canPerformMembershipOperation(scope, "assignGroups", groupIds)
      const canSuspendScope = canPerformMembershipOperation(scope, "suspend", groupIds)
      if (!canAssignGroups && !canSuspendScope) {
        continue
      }

      const isSelf = user.id === session.user.id
      members.push({
        user,
        groupIds,
        capabilities: {
          assignGroups: canAssignGroups,
          // A caller cannot suspend themselves; reactivation only applies to a
          // suspended member and never restores sessions.
          suspend: canSuspendScope && !isSelf && user.status === "active",
          reactivate: canSuspendScope && user.status === "suspended",
        },
      })
    }

    const page = paginate(members, { limit, offset })
    return { members: page.page, hasMore: page.hasMore, total: page.total }
  }

  async updateMemberGroups(
    request: Request,
    input: UpdateMemberGroupsInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<UpdateMemberGroupsResult> {
    const session = await this.requireUser(request, options)
    const storage = this.requireAuthStorage()
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const userId = assertNonEmpty(input.userId, "User id")

    // The target must exist and every group it currently holds must be assignable
    // by the caller. Missing and out-of-scope targets raise the same error so a
    // caller cannot probe which users exist.
    const { user, groupIds: currentGroupIds } = await this.requireManageableMember(
      storage,
      scope,
      "assignGroups",
      userId
    )

    const requestedGroupIds = this.resolveMemberGroupIds(input.groupIds)
    // Every requested group must fall within the caller's assign scope.
    const missing = missingMembershipGroupIds(scope, "assignGroups", requestedGroupIds)
    if (missing.length > 0) {
      throw new AuthRuntimeError(
        "authorization_denied",
        `[Sixb] The current user is not allowed to assign group(s): ${missing.join(", ")}.`
      )
    }

    const current = new Set(currentGroupIds)
    const requested = new Set(requestedGroupIds)
    const additions = requestedGroupIds.filter((groupId) => !current.has(groupId))
    const removals = currentGroupIds.filter((groupId) => !requested.has(groupId))

    // Self-protection: a caller may add in-scope groups to themselves but may not
    // remove any of their own current groups, so they cannot lock themselves out.
    if (user.id === session.user.id && removals.length > 0) {
      throw new AuthRuntimeError(
        "authorization_denied",
        "[Sixb] The current user cannot remove their own groups."
      )
    }

    const now = new Date()
    for (const groupId of additions) {
      await storage.groupMemberships.upsert({
        projectId: this.projectId,
        userId: user.id,
        groupId,
        source: "manual",
        createdAt: now,
      })
    }
    for (const groupId of removals) {
      await storage.groupMemberships.remove({
        projectId: this.projectId,
        userId: user.id,
        groupId,
      })
    }

    // The user's cached session carries its old groups; drop it so the next
    // request resolves the updated membership.
    this.invalidateUserSessions(user.id)

    const groupIds = (
      await storage.groupMemberships.listForUser({ projectId: this.projectId, userId: user.id })
    ).map((membership) => membership.groupId)

    return { user, groupIds }
  }

  async suspendMember(
    request: Request,
    input: SuspendMemberInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<SuspendMemberResult> {
    const session = await this.requireUser(request, options)
    const storage = this.requireAuthStorage()
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const userId = assertNonEmpty(input.userId, "User id")
    const { user, groupIds } = await this.requireManageableMember(storage, scope, "suspend", userId)

    if (user.id === session.user.id) {
      throw new AuthRuntimeError(
        "authorization_denied",
        "[Sixb] The current user cannot suspend themselves."
      )
    }

    const suspended = await storage.suspendUserAndRevokeSessions({
      projectId: this.projectId,
      userId: user.id,
      suspendedAt: new Date(),
    })
    // Storage revoked the user's sessions; drop cached copies so the suspended
    // user stops authenticating immediately.
    this.invalidateUserSessions(user.id)

    return { user: suspended, groupIds }
  }

  async reactivateMember(
    request: Request,
    input: ReactivateMemberInput,
    options: AuthSessionResolutionOptions = {}
  ): Promise<ReactivateMemberResult> {
    const session = await this.requireUser(request, options)
    const storage = this.requireAuthStorage()
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const userId = assertNonEmpty(input.userId, "User id")
    const { user, groupIds } = await this.requireManageableMember(storage, scope, "suspend", userId)

    // Reactivation restores access but not sessions; the user signs in again.
    const reactivated = await storage.users.updateStatus({
      projectId: this.projectId,
      id: user.id,
      status: "active",
      updatedAt: new Date(),
    })

    return { user: reactivated, groupIds }
  }

  /** Drop cached sessions for a user after a membership or status change. */
  invalidateUserSessions(userId: string): void {
    this.sessionCache?.invalidateUser(userId)
  }

  private scopedGroupOptions(groupIds: ReadonlySet<string>): InvitationGroupOption[] {
    return this.security
      .listGroups()
      .filter((group) => groupIds.has(group.id))
      .map((group) => ({
        id: group.id,
        ...(group.label !== undefined ? { label: group.label } : {}),
        ...(group.description !== undefined ? { description: group.description } : {}),
      }))
  }

  /**
   * Resolve a member the caller may act on for the given operation.
   *
   * A member is manageable only when every group they currently hold is within
   * the caller's scope for that operation (a group-less member is manageable by
   * any holder of the operation). Missing and out-of-scope members raise the same
   * error so callers cannot probe which users exist or how they are grouped.
   */
  private async requireManageableMember(
    storage: AuthStorage,
    scope: MembershipPolicyScope,
    operation: MembershipOperation,
    userId: string
  ): Promise<{ readonly user: UserRecord; readonly groupIds: readonly string[] }> {
    const user = await storage.users.getById({ projectId: this.projectId, id: userId })
    const groupIds = user
      ? (await storage.groupMemberships.listForUser({ projectId: this.projectId, userId })).map(
          (membership) => membership.groupId
        )
      : []

    if (!user || !canPerformMembershipOperation(scope, operation, groupIds)) {
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${userId}' not found for project '${this.projectId}'.`
      )
    }

    return { user, groupIds }
  }

  private resolveMemberGroupIds(input: readonly string[]): readonly string[] {
    const groupIds = [...new Set(input.map((groupId) => assertNonEmpty(groupId, "Group id")))]
    for (const groupId of groupIds) {
      if (!this.security.getGroupById(groupId)) {
        throw new AuthRuntimeError(
          "invalid_auth_input",
          `[Sixb] Unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }
    return groupIds
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
    const deliveryAudience = resolveAuthSessionAudience(
      options.delivery?.audience ?? options.audience
    )
    this.assertInvitationApplicationAccess(groupIds, deliveryAudience)

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
        audience: deliveryAudience,
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
    const scope = this.resolveMembershipPolicyScopeForUser(session.groupIds)
    const manageable = result.invitations.filter((invitation) =>
      canPerformMembershipOperation(scope, "invite", invitation.groupIds)
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

  private resolveMembershipPolicyScopeForUser(callerGroupIds: readonly string[]) {
    return resolveMembershipPolicyScope({
      membershipPolicies: this.security.listMembershipPolicies(),
      callerGroupIds,
    })
  }

  private resolveCreateInvitationCapability(input: {
    readonly canInvite: boolean
  }): GetInvitationOptionsResult["capabilities"]["createInvitation"] {
    if (!isInvitationDeliveryAuthStrategy(this.getStrategy())) {
      return { state: "disabled", reason: "invitation_delivery_not_supported" }
    }

    if (!input.canInvite) {
      return { state: "disabled", reason: "missing_membership_policy" }
    }

    return { state: "enabled" }
  }

  private assertInvitationApplicationAccess(
    groupIds: readonly string[],
    audience: AuthSessionAudience
  ): void {
    // Check only the groups this invitation assigns. Existing memberships may
    // be outside the caller's policy scope and must not affect this response.
    const roles = this.security.listResolvedRoles()
    const authorization = resolveAuthorizationContext({
      principal: { type: "user", id: "invited-user" },
      groupIds,
      roles,
    })

    if (canAccessApplication(authorization, roles, audience)) return

    throw new AuthRuntimeError(
      "authorization_denied",
      `[Sixb] Invitation groups do not grant access to application '${audience}'.`
    )
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
    const scope = this.resolveMembershipPolicyScopeForUser(callerGroupIds)

    if (canPerformMembershipOperation(scope, "invite", groupIds)) {
      return
    }

    if (groupIds.length === 0) {
      throw new AuthRuntimeError(
        "authorization_denied",
        "[Sixb] The current user is not allowed to create or manage invitations without groups."
      )
    }

    const missing = missingMembershipGroupIds(scope, "invite", groupIds)
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

function isAuthenticatedUserRequestSession(
  session: AuthenticatedRequestAuthSession
): session is AuthenticatedUserRequestSession {
  return session.principal.type === "user"
}

function resolveRequestIpAddress(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    undefined
  )
}

function constrainTokenGroupIds(
  principalGroupIds: readonly string[],
  accessToken: AccessTokenRecord
): readonly string[] {
  if (accessToken.groupIds === undefined) {
    return principalGroupIds
  }

  const allowed = new Set(accessToken.groupIds)
  return principalGroupIds.filter((groupId) => allowed.has(groupId))
}

// A caller may manage a service account only when it belongs to every group the
// account is in, so managing it can never grant more than the caller already
// has. An account with no groups is powerless and therefore freely manageable.
function callerCanManageServiceAccount(
  callerGroupIds: readonly string[],
  serviceAccountGroupIds: readonly string[]
): boolean {
  const callerGroups = new Set(callerGroupIds)
  return serviceAccountGroupIds.every((groupId) => callerGroups.has(groupId))
}

function missingAccessTokenError(tokenId: string, projectId: string): AuthStorageError {
  return new AuthStorageError(
    "missing_access_token",
    `[Sixb] Access token '${tokenId}' not found for project '${projectId}'.`
  )
}

/**
 * Restrict the groups requested for a credential to a set the caller is allowed
 * to grant. Returns undefined when no groups were requested (an unconstrained
 * credential) and throws when a requested group falls outside the allowed set.
 */
function constrainRequestedGroupIds(
  input: readonly string[] | undefined,
  allowedGroupIds: readonly string[],
  options: { readonly subject: string }
): readonly string[] | undefined {
  const groupIds = normalizeRequestedGroupIds(input)
  if (!groupIds) {
    return undefined
  }

  const allowed = new Set(allowedGroupIds)
  for (const groupId of groupIds) {
    if (!allowed.has(groupId)) {
      throw new AuthRuntimeError(
        "authorization_denied",
        `[Sixb] Group '${groupId}' cannot be assigned to this ${options.subject}.`
      )
    }
  }

  return groupIds
}

function normalizeRequestedGroupIds(
  input: readonly string[] | undefined
): readonly string[] | null {
  if (input === undefined) {
    return null
  }

  const groupIds: string[] = []
  for (const raw of input) {
    const groupId = raw.trim()
    if (!groupId) {
      throw new AuthRuntimeError(
        "invalid_auth_input",
        "[Sixb] Group ids cannot be empty when creating auth credentials."
      )
    }
    if (!groupIds.includes(groupId)) {
      groupIds.push(groupId)
    }
  }

  return groupIds
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
