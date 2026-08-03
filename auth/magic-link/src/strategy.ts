import { randomUUID } from "node:crypto"
import type { GroupDefinition } from "@sixb/core"
import type {
  InvitationDeliveryInput,
  InviteDeliveryResult,
  MagicLinkAuthStrategy,
  MagicLinkCallbackInput,
  MagicLinkCallbackResult,
  MagicLinkInvitationRecipientInput,
  MagicLinkInvitationRecipientResult,
  MagicLinkPeekInput,
  MagicLinkPeekResult,
  MagicLinkRequestInput,
  MagicLinkRequestResult,
} from "@sixb/core/auth/strategy"
import { SixbError } from "@sixb/core/errors"
import type { AuthStorage } from "@sixb/core/storage"
import { createMagicLinkEmail, type SendMagicLinkInput } from "./email"
import { magicLinkError } from "./errors"
import {
  MagicLinkRateLimiter,
  type MagicLinkRateLimitOptions,
  resolveRateLimitOptions,
} from "./rate-limit"
import { createMagicLinkCredential, hashMagicLinkToken } from "./tokens"

export type MagicLinkGroupRef = string | GroupDefinition

export interface MagicLinkOptions {
  readonly id?: string
  readonly allowedDomains: readonly string[]
  readonly bootstrapUsers?: readonly string[]
  readonly bootstrapGroups?: readonly MagicLinkGroupRef[]
  readonly publicUrl?: string
  readonly magicLinkTtlMs?: number
  /**
   * Request rate limit, or `false` to disable. The limiter is keyed per email and
   * shared across every audience served by one API process. A user signing into
   * Atlas and a custom app back-to-back draws from the same per-email bucket. Set
   * `perMinute` to at least the number of browser roles a user signs into.
   * Defaults to `{ perMinute: 5, perHour: 20 }`.
   */
  readonly rateLimit?: false | Partial<MagicLinkRateLimitOptions>
  readonly sendMagicLink: (message: SendMagicLinkInput) => Promise<void>
  readonly from?: string
  readonly subject?: string
}

export function magicLink(options: MagicLinkOptions): MagicLinkAuthStrategy {
  return new MagicLinkAuthStrategyImpl(options)
}

class MagicLinkAuthStrategyImpl implements MagicLinkAuthStrategy {
  readonly kind = "magicLink"
  readonly id: string
  readonly bootstrapGroupIds: readonly string[]

  readonly magicLinkTtlMs: number

  private readonly allowedDomains: ReadonlySet<string>
  private readonly bootstrapUsers: ReadonlySet<string>
  private readonly publicOrigin?: string
  private readonly rateLimiter: MagicLinkRateLimiter
  private readonly sendMagicLink: (message: SendMagicLinkInput) => Promise<void>
  private readonly from?: string
  private readonly subject: string

  constructor(options: MagicLinkOptions) {
    this.id = normalizeStrategyId(options.id)
    this.allowedDomains = new Set(normalizeAllowedDomains(options.allowedDomains))
    this.bootstrapUsers = new Set((options.bootstrapUsers ?? []).map(assertEmail))
    this.bootstrapGroupIds = normalizeGroupRefs(options.bootstrapGroups)
    this.publicOrigin = options.publicUrl ? normalizePublicOrigin(options.publicUrl) : undefined
    this.magicLinkTtlMs = normalizeMagicLinkTtlMs(options.magicLinkTtlMs)
    this.rateLimiter = new MagicLinkRateLimiter(resolveRateLimitOptions(options.rateLimit))
    this.sendMagicLink = options.sendMagicLink
    this.from = options.from
    this.subject = options.subject ?? "Sign in to Sixb"
  }

  async requestMagicLink(input: MagicLinkRequestInput): Promise<MagicLinkRequestResult> {
    const now = input.now ? new Date(input.now) : new Date()
    const email = normalizeEmail(input.email)
    if (!email || !this.isAllowedEmail(email)) {
      return { status: "skipped" }
    }

    const eligible = await this.canRequestMagicLink({
      email,
      now,
      projectId: input.projectId,
      storage: input.authStorage,
    })
    if (!eligible) {
      return { status: "skipped" }
    }

    if (!this.rateLimiter.tryConsume(email, now)) {
      return { status: "rate_limited" }
    }

    const credential = createMagicLinkCredential()
    const magicLinkId = `ml_${randomUUID()}`
    await input.authStorage.magicLinks.create({
      id: magicLinkId,
      projectId: input.projectId,
      strategyId: this.id,
      audience: input.audience,
      email,
      tokenHash: credential.tokenHash,
      returnTo: input.returnTo,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.magicLinkTtlMs),
    })

    const link = this.createCallbackUrl({
      magicLinkId,
      requestOrigin: input.requestOrigin,
      token: credential.token,
      requesterHash: input.requesterHash,
    })

    try {
      await this.sendMagicLink(
        createMagicLinkEmail({
          email,
          from: this.from,
          link,
          subject: this.subject,
        })
      )
    } catch (error) {
      await input.authStorage.magicLinks.revokeActiveForEmail({
        projectId: input.projectId,
        email,
        revokedAt: now,
      })
      throw error
    }

    return { status: "sent" }
  }

  async deliverInvitation(input: InvitationDeliveryInput): Promise<InviteDeliveryResult> {
    return this.requestMagicLink({
      projectId: input.projectId,
      authStorage: input.authStorage,
      email: input.invitation.email,
      audience: input.audience,
      returnTo: input.returnTo,
      requestOrigin: input.requestOrigin,
      now: input.now,
    })
  }

  async validateInvitationRecipient(
    input: MagicLinkInvitationRecipientInput
  ): Promise<MagicLinkInvitationRecipientResult> {
    const now = input.now ? new Date(input.now) : new Date()
    const email = normalizeEmail(input.email)
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

    if (!this.rateLimiter.canConsume(email, now)) {
      return { status: "rate_limited", email }
    }

    return { status: "allowed", email }
  }

  // Read-only twin of completeMagicLinkSignIn's validity rules: same record
  // checks plus token verification, but never consumes the token. Keeps the
  // "can this link still sign in?" logic in one package so the server's GET
  // handler cannot drift from the rules applied on completion.
  async peekMagicLink(input: MagicLinkPeekInput): Promise<MagicLinkPeekResult | null> {
    const now = input.now ? new Date(input.now) : new Date()
    const magicLink = await input.authStorage.magicLinks.getById({
      projectId: input.projectId,
      id: input.magicLinkId,
    })

    if (
      !magicLink ||
      !this.isAllowedEmail(magicLink.email) ||
      magicLink.consumedAt ||
      magicLink.revokedAt ||
      magicLink.expiresAt.getTime() <= now.getTime() ||
      hashMagicLinkToken(input.token) !== magicLink.tokenHash
    ) {
      return null
    }

    return { email: magicLink.email }
  }

  async completeMagicLinkSignIn(input: MagicLinkCallbackInput): Promise<MagicLinkCallbackResult> {
    const now = input.now ? new Date(input.now) : new Date()
    const magicLink = await input.authStorage.magicLinks.getById({
      projectId: input.projectId,
      id: input.magicLinkId,
    })

    if (!magicLink || !this.isAllowedEmail(magicLink.email)) {
      // Not `magicLinkError`: every other throw in this package is a wrong `magicLink(...)` option,
      // which is `runtime.invalid_definition`. This one is a person clicking a stale link, so it is
      // a credential failure — and a code that claims the project's definition is wrong would send
      // whoever reads the failure looking in the wrong place.
      throw new SixbError("auth.invalid_credentials", "[Sixb] Magic link is invalid or expired.")
    }

    // Every email in the configured bootstrap allowlist may self-provision
    // without an invitation — at any time, not only as the first user. The
    // allowlist itself is the trust boundary. Applied on every sign-in (not just
    // creation), so the configured bootstrap groups stay reconciled for existing
    // bootstrap users; user creation itself is still gated by storage, which only
    // creates when no user exists for the email.
    const canBootstrap = this.bootstrapUsers.has(magicLink.email)

    const signIn = await input.authStorage.completeMagicLinkSignIn({
      projectId: input.projectId,
      magicLinkId: input.magicLinkId,
      tokenHash: hashMagicLinkToken(input.token),
      completedAt: now,
      newUserId: `usr_${randomUUID()}`,
      allowUserCreationWithoutInvitation: canBootstrap,
      requireNoActiveUsersForUserCreation: false,
      manualGroupIds: canBootstrap ? this.bootstrapGroupIds : [],
      session: {
        ...input.session,
        audience: magicLink.audience,
      },
    })

    return {
      ...signIn,
      audience: magicLink.audience,
      returnTo: magicLink.returnTo ?? "/",
    }
  }

  private async canRequestMagicLink(input: {
    readonly email: string
    readonly now: Date
    readonly projectId: string
    readonly storage: AuthStorage
  }): Promise<boolean> {
    const user = await input.storage.users.getByEmail({
      projectId: input.projectId,
      email: input.email,
    })

    if (user) {
      return user.status === "active"
    }

    const invitation = await input.storage.invitations.getActiveByEmail({
      projectId: input.projectId,
      email: input.email,
      now: input.now,
    })
    if (invitation) {
      return true
    }

    return this.bootstrapUsers.has(input.email)
  }

  private createCallbackUrl(input: {
    readonly magicLinkId: string
    readonly requestOrigin: string
    readonly token: string
    readonly requesterHash?: string
  }): string {
    const origin = this.publicOrigin ?? normalizePublicOrigin(input.requestOrigin)
    const url = new URL("/auth/callback", origin)
    url.searchParams.set("magicLinkId", input.magicLinkId)
    url.searchParams.set("token", input.token)
    if (input.requesterHash) {
      url.searchParams.set("requester", input.requesterHash)
    }
    return url.toString()
  }

  private isAllowedEmail(email: string): boolean {
    const domain = emailDomain(email)
    return domain ? this.allowedDomains.has(domain) : false
  }
}

function normalizeStrategyId(value: string | undefined): string {
  const id = value?.trim() || "magic-link"
  if (!id) {
    throw magicLinkError("Magic-link auth id is required.")
  }
  return id
}

function normalizeAllowedDomains(domains: readonly string[]): readonly string[] {
  const normalized = [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].filter(
    Boolean
  )
  if (normalized.length === 0) {
    throw magicLinkError("Magic-link auth allowedDomains must contain at least one domain.")
  }
  for (const domain of normalized) {
    if (domain.includes("@") || domain.includes("/") || domain.includes(":")) {
      throw magicLinkError(`Magic-link auth allowed domain '${domain}' is invalid.`)
    }
  }
  return normalized
}

function normalizeGroupRefs(groups: readonly MagicLinkGroupRef[] | undefined): readonly string[] {
  const groupIds = (groups ?? []).map((group) => {
    const groupId = typeof group === "string" ? group : group.id
    const normalized = groupId.trim()
    if (!normalized) {
      throw magicLinkError("Magic-link auth bootstrapGroups must be non-empty.")
    }
    return normalized
  })

  return [...new Set(groupIds)]
}

function normalizeMagicLinkTtlMs(value: number | undefined): number {
  const ttlMs = value ?? 15 * 60_000
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw magicLinkError("Magic-link auth magicLinkTtlMs must be positive.")
  }
  return ttlMs
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw magicLinkError("Magic-link auth publicUrl must use http or https.")
  }
  return url.origin
}

function assertEmail(value: string): string {
  const email = normalizeEmail(value)
  if (!email) {
    throw magicLinkError(`Magic-link auth address '${value}' is invalid.`)
  }
  return email
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  if (!email || /\s/.test(email)) {
    return null
  }

  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1 || email.indexOf("@") !== at) {
    return null
  }

  return email
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) {
    return null
  }
  return email.slice(at + 1)
}
