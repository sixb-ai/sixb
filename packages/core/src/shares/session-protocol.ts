import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { formatSessionCookieValue, parseSessionCookieValue } from "../auth/sessions"
import { type RuntimeAccessPlan, snapshotRuntimeAccessPlan } from "../authorization"
import type { SixbHostView } from "../runtime"
import type { ShareGrantRecord, ShareSessionRecord, Storage } from "../storage"
import { ShareSessionStorageError } from "../storage"
import { compileShareAccessPlan } from "./compiler"
import { intersectShareAccessPlans } from "./intersection"

export const DEFAULT_SHARED_SESSION_INACTIVITY_TTL_MS = 15 * 60_000

const MAX_CREATE_ATTEMPTS = 5
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface SharedSessionContext {
  readonly grantId: string
  readonly sessionId: string
  readonly destinationPath: string
  readonly access: RuntimeAccessPlan
  readonly expiresAt: Date
  readonly absoluteExpiresAt: Date
}

export interface SharedSessionCredential {
  readonly context: SharedSessionContext
  /** Opaque value for the HttpOnly shared-session cookie. */
  readonly cookieValue: string
}

export interface SharedSessionProtocolOptions {
  readonly host: SixbHostView
  readonly inactivityTtlMs?: number
  readonly now?: () => Date
}

/**
 * Framework-owned shared-session lifecycle.
 *
 * Link and session secrets are verified here. Callers receive only an effective access plan built
 * from the issued snapshot intersected with the Share definition registered now.
 */
export class SharedSessionProtocol {
  private readonly host: SixbHostView
  private readonly inactivityTtlMs: number
  private readonly now: () => Date

  constructor(options: SharedSessionProtocolOptions) {
    if (!options.host.storage.shareGrants || !options.host.storage.shareSessions) {
      throw new Error("[Sixb] Shared sessions require share grant and session storage.")
    }
    const inactivityTtlMs = options.inactivityTtlMs ?? DEFAULT_SHARED_SESSION_INACTIVITY_TTL_MS
    if (!Number.isSafeInteger(inactivityTtlMs) || inactivityTtlMs <= 0) {
      throw new Error("[Sixb] Shared session inactivity TTL must be a positive integer.")
    }
    this.host = options.host
    this.inactivityTtlMs = inactivityTtlMs
    this.now = options.now ?? (() => new Date())
  }

  async exchange(grantId: string, secret: string): Promise<SharedSessionCredential | null> {
    if (!validIdentifier(grantId) || !validSecret(secret)) return null
    const now = this.currentTime()

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const sessionSecret = randomBytes(32).toString("base64url")
      const sessionId = `shs_${randomUUID()}`
      try {
        const result = await this.host.storage.transaction(async (tx) => {
          const grant = await activeGrant(tx, this.host.projectId, grantId, now)
          const secretMatches = secretMatchesHash(secret, grant?.tokenHash ?? "")
          if (!grant || !secretMatches) return null
          const sessions = requireSessions(tx)
          const absoluteExpiresAt = new Date(grant.expiresAt)
          const session = await sessions.create({
            id: sessionId,
            projectId: this.host.projectId,
            grantId: grant.id,
            tokenHash: sha256(sessionSecret),
            createdAt: now,
            expiresAt: inactivityDeadline(now, absoluteExpiresAt, this.inactivityTtlMs),
            absoluteExpiresAt,
          })
          return { grant, session }
        })
        if (!result) return null
        return {
          context: this.context(result.grant, result.session),
          cookieValue: formatSessionCookieValue(sessionId, sessionSecret),
        }
      } catch (error) {
        if (
          error instanceof ShareSessionStorageError &&
          error.code === "duplicate" &&
          attempt < MAX_CREATE_ATTEMPTS - 1
        ) {
          continue
        }
        throw error
      }
    }

    return null
  }

  async resolve(
    grantId: string,
    cookieValue: string | undefined,
    options: { readonly activity?: "background" | "foreground" } = {}
  ): Promise<SharedSessionContext | null> {
    if (!validIdentifier(grantId) || !validCookieValue(cookieValue)) return null
    const credential = parseSessionCookieValue(cookieValue)
    if (
      !credential ||
      !validIdentifier(credential.sessionId) ||
      !validSecret(credential.sessionSecret)
    ) {
      return null
    }
    const now = this.currentTime()
    const tokenHash = sha256(credential.sessionSecret)

    const result = await this.host.storage.transaction(async (tx) => {
      const sessions = requireSessions(tx)
      const current = await sessions.getById({
        projectId: this.host.projectId,
        id: credential.sessionId,
      })
      const secretMatches = secretMatchesHash(credential.sessionSecret, current?.tokenHash ?? "")
      if (
        !current ||
        current.grantId !== grantId ||
        current.revokedAt !== undefined ||
        current.expiresAt.getTime() <= now.getTime() ||
        current.absoluteExpiresAt.getTime() <= now.getTime() ||
        !secretMatches
      ) {
        return null
      }

      const grant = await activeGrant(tx, this.host.projectId, grantId, now)
      if (!grant || current.absoluteExpiresAt.getTime() !== grant.expiresAt.getTime()) {
        return null
      }

      if (options.activity !== "foreground") return { grant, session: current }

      const renewed = await sessions.renewIfValid({
        projectId: this.host.projectId,
        id: current.id,
        grantId,
        tokenHash,
        now,
        expiresAt: inactivityDeadline(now, current.absoluteExpiresAt, this.inactivityTtlMs),
      })
      return renewed ? { grant, session: renewed } : null
    })

    return result ? this.context(result.grant, result.session) : null
  }

  async revoke(context: Pick<SharedSessionContext, "grantId" | "sessionId">): Promise<void> {
    const revokedAt = this.currentTime()
    await this.host.storage.transaction(async (tx) => {
      const session = await requireSessions(tx).getById({
        projectId: this.host.projectId,
        id: context.sessionId,
      })
      if (!session || session.grantId !== context.grantId) return
      await requireSessions(tx).revoke({
        projectId: this.host.projectId,
        id: context.sessionId,
        revokedAt,
      })
    })
  }

  private context(grant: ShareGrantRecord, session: ShareSessionRecord): SharedSessionContext {
    return {
      grantId: grant.id,
      sessionId: session.id,
      destinationPath: grant.destinationPath,
      access: effectiveAccess(this.host, grant),
      expiresAt: new Date(session.expiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
    }
  }

  private currentTime(): Date {
    const now = this.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("[Sixb] Shared session clock returned an invalid date.")
    }
    return new Date(now)
  }
}

function effectiveAccess(host: SixbHostView, grant: ShareGrantRecord): RuntimeAccessPlan {
  const definition = host.definitions.shares.getById(grant.definitionId)
  if (!definition || definition.target.objectTypeId !== grant.target.objectTypeId) {
    return snapshotRuntimeAccessPlan({ grants: [] })
  }
  const current = compileShareAccessPlan({
    share: definition,
    target: grant.target,
    ontology: host.definitions.ontology,
    actions: host.definitions.actions,
  })
  return intersectShareAccessPlans(grant.authoritySnapshot.access, current)
}

async function activeGrant(
  storage: Storage,
  projectId: string,
  grantId: string,
  now: Date
): Promise<ShareGrantRecord | null> {
  const grant = await storage.shareGrants?.getById({ projectId, id: grantId })
  return !grant || grant.revokedAt !== undefined || grant.expiresAt.getTime() <= now.getTime()
    ? null
    : grant
}

function requireSessions(storage: Storage): NonNullable<Storage["shareSessions"]> {
  if (!storage.shareSessions) {
    throw new Error("[Sixb] Shared session storage is not configured.")
  }
  return storage.shareSessions
}

function inactivityDeadline(now: Date, absolute: Date, ttlMs: number): Date {
  return new Date(Math.min(absolute.getTime(), now.getTime() + ttlMs))
}

function secretMatchesHash(secret: string, expectedHash: string): boolean {
  const actual = createHash("sha256").update(secret).digest()
  const expected = /^[0-9a-f]{64}$/.test(expectedHash)
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(actual.length)
  return timingSafeEqual(actual, expected)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
  )
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value)
}

function validCookieValue(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256
}
