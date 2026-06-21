import { randomUUID } from "node:crypto"
import type {
  AuthStorage,
  GroupDefinition,
  InvitationDeliveryInput,
  InvitationRecipientInput,
  InvitationRecipientResult,
  InviteDeliveryResult,
  OidcAuthStrategy,
  OidcCallbackInput,
  OidcCallbackResult,
  OidcStartSignInInput,
  OidcStartSignInResult,
} from "@sixb/core"
import { resolveOidcProfile } from "./claims"
import { defaultOidcClientAdapter, type OidcClientAdapter } from "./client"
import { createOidcInvitationEmail, type SendOidcInvitationInput } from "./email"
import { OidcAuthError } from "./errors"
import { createOpaqueSecret, formatOidcState, parseOidcState, sha256 } from "./state"

const DEFAULT_OIDC_ATTEMPT_TTL_MS = 10 * 60 * 1000
const DEFAULT_SCOPE = "openid email profile"

export type OidcGroupRef = string | GroupDefinition

export interface OidcOptions {
  readonly id?: string
  readonly issuer: string | URL
  readonly clientId: string
  readonly clientSecret: string
  readonly allowedDomains?: readonly string[]
  readonly bootstrapUsers?: readonly string[]
  readonly bootstrapGroups?: readonly OidcGroupRef[]
  readonly publicUrl?: string
  readonly scope?: string
  readonly authorizationParams?: Readonly<Record<string, string>>
  readonly sendInvitation?: (message: SendOidcInvitationInput) => Promise<void>
  readonly from?: string
  readonly subject?: string
  /** Test hook for deterministic strategy tests. */
  readonly clientAdapter?: OidcClientAdapter
}

export function oidc(options: OidcOptions): OidcAuthStrategy {
  return new OidcAuthStrategyImpl(options)
}

class OidcAuthStrategyImpl implements OidcAuthStrategy {
  readonly kind = "oidc"
  readonly id: string
  readonly bootstrapGroupIds: readonly string[]

  private readonly issuer: URL
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly allowedDomains?: ReadonlySet<string>
  private readonly bootstrapUsers: ReadonlySet<string>
  private readonly publicOrigin?: string
  private readonly scope: string
  private readonly authorizationParams: Readonly<Record<string, string>>
  private readonly sendInvitation?: (message: SendOidcInvitationInput) => Promise<void>
  private readonly from?: string
  private readonly subject: string
  private readonly client: OidcClientAdapter
  private discoveryPromise: Promise<unknown> | null = null

  constructor(options: OidcOptions) {
    this.id = normalizeStrategyId(options.id)
    this.issuer = normalizeHttpUrl(options.issuer, "OIDC issuer")
    this.clientId = assertNonEmpty(options.clientId, "OIDC clientId")
    this.clientSecret = assertNonEmpty(options.clientSecret, "OIDC clientSecret")
    const allowedDomains = normalizeAllowedDomains(options.allowedDomains)
    this.allowedDomains = allowedDomains.length > 0 ? new Set(allowedDomains) : undefined
    this.bootstrapUsers = new Set((options.bootstrapUsers ?? []).map(normalizeEmail))
    this.bootstrapGroupIds = normalizeGroupRefs(options.bootstrapGroups)
    this.publicOrigin = options.publicUrl
      ? normalizeHttpUrl(options.publicUrl, "OIDC publicUrl").origin
      : undefined
    this.scope = normalizeScope(options.scope)
    this.authorizationParams = options.authorizationParams ?? {}
    this.sendInvitation = options.sendInvitation
    this.from = options.from
    this.subject = options.subject ?? "You are invited to Sixb"
    this.client = options.clientAdapter ?? defaultOidcClientAdapter
  }

  async startOidcSignIn(input: OidcStartSignInInput): Promise<OidcStartSignInResult> {
    const now = input.now ? new Date(input.now) : new Date()
    const attemptId = `oidc_${randomUUID()}`
    const stateSecret = createOpaqueSecret()
    const nonce = createOpaqueSecret()
    const state = formatOidcState({
      attemptId,
      nonce,
      secret: stateSecret,
    })
    const codeVerifier = this.client.randomPKCECodeVerifier()
    const codeChallenge = await this.client.calculatePKCECodeChallenge(codeVerifier)

    await input.authStorage.oidcAuthorizationAttempts.create({
      id: attemptId,
      projectId: input.projectId,
      strategyId: this.id,
      audience: input.audience,
      stateHash: sha256(state),
      nonceHash: sha256(nonce),
      codeVerifier,
      returnTo: input.returnTo,
      createdAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_OIDC_ATTEMPT_TTL_MS),
    })

    const redirectTo = this.client.buildAuthorizationUrl(await this.getConfiguration(), {
      ...this.authorizationParams,
      redirect_uri: this.callbackUrl(input.requestOrigin),
      response_type: "code",
      scope: this.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    })

    return { redirectTo: redirectTo.toString() }
  }

  async completeOidcSignIn(input: OidcCallbackInput): Promise<OidcCallbackResult> {
    const now = input.now ? new Date(input.now) : new Date()
    const callbackUrl = new URL(input.requestUrl)
    const parsedState = parseOidcState(callbackUrl.searchParams.get("state"))
    if (!parsedState) {
      throw new OidcAuthError("OIDC callback state is invalid or missing.")
    }

    const attempt = await input.authStorage.oidcAuthorizationAttempts.getById({
      projectId: input.projectId,
      id: parsedState.attemptId,
    })
    if (!attempt) {
      throw new OidcAuthError("OIDC sign-in attempt is invalid or expired.")
    }

    const stateHash = sha256(parsedState.state)
    if (attempt.stateHash !== stateHash || attempt.expiresAt <= now || attempt.consumedAt) {
      throw new OidcAuthError("OIDC sign-in attempt is invalid or expired.")
    }

    try {
      const tokens = await this.client.authorizationCodeGrant(
        await this.getConfiguration(),
        this.externalCallbackUrl({
          requestOrigin: input.requestOrigin,
          requestUrl: input.requestUrl,
        }),
        {
          pkceCodeVerifier: attempt.codeVerifier,
          expectedState: parsedState.state,
          expectedNonce: parsedState.nonce,
          idTokenExpected: true,
        }
      )
      const idTokenClaims = tokens.claims()
      if (!idTokenClaims) {
        throw new OidcAuthError("OIDC token response is missing id token claims.")
      }

      const idTokenSubject = claimString(idTokenClaims, "sub")
      if (!idTokenSubject) {
        throw new OidcAuthError("OIDC id token is missing a subject.")
      }

      const userInfo = tokens.access_token
        ? await this.client.fetchUserInfo(
            await this.getConfiguration(),
            tokens.access_token,
            idTokenSubject
          )
        : undefined
      const profile = resolveOidcProfile({ idTokenClaims, userInfo })
      if (!profile.nonce || sha256(profile.nonce) !== attempt.nonceHash) {
        throw new OidcAuthError("OIDC id token nonce is invalid.")
      }

      const email = normalizeEmail(profile.email)
      if (!this.isAllowedEmail(email)) {
        throw new OidcAuthError("OIDC email domain is not allowed.")
      }

      // Every verified email in the configured bootstrap allowlist may
      // self-provision without an invitation — at any time, not only as the
      // first user. The allowlist itself is the trust boundary.
      const canBootstrap = profile.emailVerified && this.bootstrapUsers.has(email)
      const signIn = await input.authStorage.completeOidcSignIn({
        projectId: input.projectId,
        oidcAuthorizationAttemptId: attempt.id,
        stateHash,
        completedAt: now,
        subject: profile.subject,
        email,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        claims: profile.claims,
        autoLinkByVerifiedEmail: profile.emailVerified,
        allowUserCreationWithoutInvitation: canBootstrap,
        requireNoActiveUsersForUserCreation: false,
        manualGroupIds: canBootstrap ? this.bootstrapGroupIds : [],
        newUserId: `usr_${randomUUID()}`,
        session: {
          ...input.session,
          audience: attempt.audience,
        },
      })

      return {
        ...signIn,
        audience: attempt.audience,
        returnTo: attempt.returnTo ?? "/",
      }
    } catch (error) {
      await this.consumeAttemptIfPossible({
        authStorage: input.authStorage,
        projectId: input.projectId,
        id: attempt.id,
        stateHash,
        consumedAt: now,
      })
      throw error
    }
  }

  async validateInvitationRecipient(
    input: InvitationRecipientInput
  ): Promise<InvitationRecipientResult> {
    const email = normalizeInvitationEmail(input.email)
    if (!email) {
      return { status: "invalid_email" }
    }

    if (!this.isAllowedEmail(email)) {
      return { status: "disallowed_domain", email }
    }

    const user = await input.authStorage.users.getByEmail({
      projectId: input.projectId,
      email,
    })
    if (user?.status === "suspended") {
      return { status: "suspended_user", email }
    }

    return { status: "allowed", email }
  }

  async deliverInvitation(input: InvitationDeliveryInput): Promise<InviteDeliveryResult> {
    if (!this.sendInvitation) {
      return { status: "not_supported" }
    }

    await this.sendInvitation(
      createOidcInvitationEmail({
        email: input.invitation.email,
        from: this.from,
        url: this.createSignInUrl({
          audience: input.audience,
          requestOrigin: input.requestOrigin,
          returnTo: input.returnTo,
        }),
        subject: this.subject,
      })
    )

    return { status: "sent" }
  }

  private async getConfiguration(): Promise<unknown> {
    this.discoveryPromise ??= this.client.discovery(this.issuer, this.clientId, this.clientSecret)
    return this.discoveryPromise
  }

  private callbackUrl(requestOrigin: string): string {
    const origin =
      this.publicOrigin ?? normalizeHttpUrl(requestOrigin, "OIDC request origin").origin
    return new URL("/auth/callback", origin).toString()
  }

  private externalCallbackUrl(input: {
    readonly requestOrigin: string
    readonly requestUrl: string
  }): URL {
    const url = new URL(this.callbackUrl(input.requestOrigin))
    url.search = new URL(input.requestUrl).search
    return url
  }

  private createSignInUrl(input: {
    readonly audience: string
    readonly requestOrigin: string
    readonly returnTo: string
  }): string {
    const origin =
      this.publicOrigin ?? normalizeHttpUrl(input.requestOrigin, "OIDC request origin").origin
    const url = new URL("/auth/sign-in", origin)
    url.searchParams.set("audience", input.audience)
    url.searchParams.set("returnTo", input.returnTo)
    return url.toString()
  }

  private isAllowedEmail(email: string): boolean {
    if (!this.allowedDomains) {
      return true
    }

    const domain = emailDomain(email)
    return domain ? this.allowedDomains.has(domain) : false
  }

  private async consumeAttemptIfPossible(input: {
    readonly authStorage: AuthStorage
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<void> {
    await input.authStorage.oidcAuthorizationAttempts.consume(input).catch(() => undefined)
  }
}

function normalizeStrategyId(value: string | undefined): string {
  return assertNonEmpty(value?.trim() || "oidc", "OIDC auth id")
}

function normalizeAllowedDomains(domains: readonly string[] | undefined): readonly string[] {
  const normalized = [
    ...new Set((domains ?? []).map((domain) => domain.trim().toLowerCase())),
  ].filter(Boolean)

  for (const domain of normalized) {
    if (domain.includes("@") || domain.includes("/") || domain.includes(":")) {
      throw new OidcAuthError(`OIDC allowed domain '${domain}' is invalid.`)
    }
  }

  return normalized
}

function normalizeGroupRefs(groups: readonly OidcGroupRef[] | undefined): readonly string[] {
  const groupIds = (groups ?? []).map((group) => {
    const groupId = typeof group === "string" ? group : group.id
    return assertNonEmpty(groupId, "OIDC bootstrap group id")
  })

  return [...new Set(groupIds)]
}

function normalizeScope(value: string | undefined): string {
  const scope = value?.trim() || DEFAULT_SCOPE
  const parts = scope.split(/\s+/).filter(Boolean)
  if (!parts.includes("openid")) {
    throw new OidcAuthError("OIDC scope must include 'openid'.")
  }

  return parts.join(" ")
}

function normalizeHttpUrl(value: string | URL, label: string): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OidcAuthError(`${label} must use http or https.`)
  }

  return url
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!email || !email.includes("@")) {
    throw new OidcAuthError(`OIDC email '${value}' is invalid.`)
  }

  return email
}

function normalizeInvitationEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  return email.includes("@") ? email : null
}

function emailDomain(email: string): string | null {
  const index = email.lastIndexOf("@")
  return index === -1 ? null : email.slice(index + 1).toLowerCase()
}

function claimString(claims: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = claims[key]
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function assertNonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new OidcAuthError(`${label} is required.`)
  }

  return normalized
}
