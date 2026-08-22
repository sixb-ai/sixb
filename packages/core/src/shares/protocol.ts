import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { formatSessionCookieValue, parseSessionCookieValue } from "../auth/sessions"
import type { SharedAccessPrincipal } from "../execution"
import type { DefinitionCatalog } from "../runtime/definitions"
import type { SharedAccessGrantRecord, SharedAccessSessionRecord, Storage } from "../storage"
import type { SharedAccessGrantRef } from "../storage/share-grants"
import type { ShareTypeDefinition } from "./types"
import { snapshotShareTypeGrants } from "./validation"

export const DEFAULT_SHARED_ACCESS_SESSION_TTL_MS = 15 * 60_000

export type { SharedAccessPrincipal } from "../execution"

export interface SharedAccessSessionContext {
  readonly principal: SharedAccessPrincipal
  /** Immutable authority recorded when the link was issued. */
  readonly grant: SharedAccessGrantRecord
  /** Issued authority narrowed by the currently registered ShareType. */
  readonly effectiveGrants: readonly SharedAccessGrantRef[]
  readonly session: SharedAccessSessionRecord
}

interface ActiveSharedAccessGrant {
  readonly record: SharedAccessGrantRecord
  readonly effectiveGrants: readonly SharedAccessGrantRef[]
}

export interface SharedAccessSessionCredential {
  readonly context: SharedAccessSessionContext
  /** Opaque value for the HttpOnly shared-session cookie. */
  readonly cookieValue: string
}

export interface SharedAccessProtocolOptions {
  readonly projectId: string
  readonly shareTypes: DefinitionCatalog<ShareTypeDefinition>
  readonly storage: Pick<Storage, "shareGrants" | "shareSessions">
  readonly sessionTtlMs?: number
}

/** Framework-owned exchange and session lifecycle, independent from normal auth sessions. */
export class SharedAccessProtocol {
  private readonly projectId: string
  private readonly shareTypes: DefinitionCatalog<ShareTypeDefinition>
  private readonly grants: NonNullable<Storage["shareGrants"]>
  private readonly sessions: NonNullable<Storage["shareSessions"]>
  private readonly sessionTtlMs: number

  constructor(options: SharedAccessProtocolOptions) {
    if (!options.storage.shareGrants || !options.storage.shareSessions) {
      throw new Error(
        "[Sixb] Shared access protocol requires share grant and share session storage."
      )
    }
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SHARED_ACCESS_SESSION_TTL_MS
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new Error("[Sixb] Shared access session TTL must be a positive finite duration.")
    }

    this.projectId = options.projectId
    this.shareTypes = options.shareTypes
    this.grants = options.storage.shareGrants
    this.sessions = options.storage.shareSessions
    this.sessionTtlMs = sessionTtlMs
  }

  async exchange(
    grantId: string,
    secret: string,
    now = new Date()
  ): Promise<SharedAccessSessionCredential | null> {
    if (!isNonEmpty(grantId) || !isNonEmpty(secret) || !isValidDate(now)) return null

    const activeGrant = await this.getActiveGrant(grantId, now)
    if (!activeGrant || !secretMatchesDigest(secret, activeGrant.record.tokenDigest)) return null

    const sessionSecret = randomBytes(32).toString("base64url")
    const sessionId = `shs_${randomUUID()}`
    const session = await this.sessions.create({
      id: sessionId,
      projectId: this.projectId,
      grantId: activeGrant.record.id,
      tokenDigest: digest(sessionSecret),
      createdAt: new Date(now),
      expiresAt: new Date(
        Math.min(activeGrant.record.expiresAt.getTime(), now.getTime() + this.sessionTtlMs)
      ),
    })

    return {
      context: toContext(activeGrant, session),
      cookieValue: formatSessionCookieValue(session.id, sessionSecret),
    }
  }

  async resolve(
    grantId: string,
    cookieValue: string | undefined,
    now = new Date()
  ): Promise<SharedAccessSessionContext | null> {
    if (!isNonEmpty(grantId) || !isValidDate(now)) return null
    const credential = parseSessionCookieValue(cookieValue)
    if (!credential) return null

    const session = await this.sessions.get({
      projectId: this.projectId,
      sessionId: credential.sessionId,
    })
    if (
      !session ||
      session.grantId !== grantId ||
      session.revokedAt !== undefined ||
      session.expiresAt.getTime() <= now.getTime() ||
      !secretMatchesDigest(credential.sessionSecret, session.tokenDigest)
    ) {
      return null
    }

    const activeGrant = await this.getActiveGrant(grantId, now)
    return activeGrant ? toContext(activeGrant, session) : null
  }

  async revoke(
    context: SharedAccessSessionContext,
    revokedAt = new Date()
  ): Promise<SharedAccessSessionRecord | null> {
    if (!isValidDate(revokedAt)) {
      throw new Error("[Sixb] Shared access session revocation time must be a valid date.")
    }
    return this.sessions.revoke({
      projectId: this.projectId,
      sessionId: context.session.id,
      revokedAt,
    })
  }

  private async getActiveGrant(
    grantId: string,
    now: Date
  ): Promise<ActiveSharedAccessGrant | null> {
    const grant = await this.grants.get({ projectId: this.projectId, grantId })
    if (!grant || grant.revokedAt !== undefined || grant.expiresAt.getTime() <= now.getTime()) {
      return null
    }

    const shareType = this.shareTypes.getById(grant.shareTypeId)
    if (!shareType || shareType.target.id !== grant.target.objectTypeId) return null
    return {
      record: grant,
      effectiveGrants: intersectGrantRefs(grant.grants, snapshotShareTypeGrants(shareType)),
    }
  }
}

function toContext(
  activeGrant: ActiveSharedAccessGrant,
  session: SharedAccessSessionRecord
): SharedAccessSessionContext {
  return {
    principal: {
      type: "sharedAccess",
      grantId: activeGrant.record.id,
      sessionId: session.id,
    },
    grant: activeGrant.record,
    effectiveGrants: activeGrant.effectiveGrants,
    session,
  }
}

function intersectGrantRefs(
  issued: readonly SharedAccessGrantRef[],
  current: readonly SharedAccessGrantRef[]
): readonly SharedAccessGrantRef[] {
  const currentKeys = new Set(current.map(grantRefKey))
  return issued
    .filter((grant) => currentKeys.has(grantRefKey(grant)))
    .map((grant) => ({ ...grant }))
}

function grantRefKey(grant: SharedAccessGrantRef): string {
  return grant.capability === "view" ? `view:${grant.objectTypeId}` : `apply:${grant.actionId}`
}

function secretMatchesDigest(secret: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digest(secret), "base64url")
  let expected: Buffer
  try {
    expected = Buffer.from(expectedDigest, "base64url")
  } catch {
    return false
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}
