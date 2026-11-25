import { createHash, randomBytes } from "node:crypto"
import type { SessionCredential } from "../auth/sessions"
import type { SixbAuthConfig } from "../auth/types"
import type { SixbHostView } from "../runtime/host"

/**
 * How a person signs into a branch production runs: production checks the grant, and asks the
 * branch, with the branch's key, to let that person in. The branch answers with a code that the
 * person's browser trades on the branch's own origin for a session of the branch's: a native
 * session, so CSRF, guards and attribution work as they do anywhere. A code is good once, for one
 * person, for a minute, and only on the branch that issued it. The branch signs nobody in any
 * other way.
 */

/** How long a code lasts. */
export const BRANCH_HANDOVER_CODE_TTL_MS = 60_000

/** Where the branch prepares a code, behind its front: production calls it with the key. */
export const BRANCH_HANDOVER_PREPARE_PATH = "/api/branch-handover"

/** Where a browser trades a code for the branch's session. */
export const BRANCH_HANDOVER_SIGN_IN_PATH = "/auth/branch-handover"

/** The strategy a branch production runs signs in with: none but the handover. */
export const BRANCH_HANDOVER_STRATEGY_ID = "branch-handover"

/**
 * The longest a branch's session lasts, however active: production checks the grant only at the
 * handover, so losing it, or being suspended, takes effect on the branch within this.
 */
export const BRANCH_SESSION_MAX_MS = 4 * 60 * 60_000

/**
 * The auth a branch production runs serves: the project's sessions and cookies, but a strategy
 * that signs nobody in, so the handover is the only way in. Its sessions end within
 * {@link BRANCH_SESSION_MAX_MS}. Its cookies stay on the branch's own origin, whatever domain
 * production's span, and are `Secure` when that origin is https: its API sees plain http from the
 * front, so it cannot tell by itself.
 */
export function branchHandoverAuth(
  config: SixbAuthConfig | undefined,
  publicOrigin: string | undefined
): SixbAuthConfig {
  const options = config && "strategy" in config ? config : undefined
  const session = options?.session
  const absoluteTimeoutMs = Math.min(
    session?.absoluteTimeoutMs ?? BRANCH_SESSION_MAX_MS,
    BRANCH_SESSION_MAX_MS
  )
  // A session's idle limit and renewal window fit inside its lifetime.
  const idleTimeoutMs = Math.min(session?.idleTimeoutMs ?? absoluteTimeoutMs, absoluteTimeoutMs)
  const renewalWindowMs = Math.min(session?.renewalWindowMs ?? idleTimeoutMs / 4, idleTimeoutMs / 4)
  const https = publicOrigin?.startsWith("https://") ?? false

  return {
    strategy: { id: BRANCH_HANDOVER_STRATEGY_ID, kind: "dev" },
    session: { ...session, absoluteTimeoutMs, idleTimeoutMs, renewalWindowMs },
    cookies: { ...options?.cookies, cookieDomain: undefined, ...(https ? { secure: true } : {}) },
  }
}

/** The person production lets into the branch, as production knows them. */
export interface BranchHandoverPerson {
  readonly id: string
  readonly email: string
  readonly displayName: string | null
  /** Their groups in production: the branch holds them in the same ones. */
  readonly groupIds: readonly string[]
}

/** Codes one branch issued, until they are used or expire. */
export class BranchHandover {
  private readonly codes = new Map<
    string,
    { readonly userId: string; readonly expiresAt: number }
  >()

  constructor(private readonly host: SixbHostView) {}

  /**
   * A code for `person`, made an active member of the branch's copy when the copy predates them
   * or holds them otherwise, and given exactly their groups.
   */
  async prepare(
    person: BranchHandoverPerson
  ): Promise<{ readonly code: string; readonly expiresAt: Date }> {
    await this.ensureMember(person)

    const now = Date.now()
    this.sweep(now)
    const code = randomBytes(32).toString("base64url")
    const expiresAt = now + BRANCH_HANDOVER_CODE_TTL_MS
    this.codes.set(hashCode(code), { userId: person.id, expiresAt })
    return { code, expiresAt: new Date(expiresAt) }
  }

  /** The branch's session for a code's person, once: null for a code used, expired or unknown. */
  async exchange(
    code: string,
    device: { readonly userAgent?: string; readonly ipAddress?: string } = {}
  ): Promise<{ readonly credential: SessionCredential; readonly expiresAt: Date } | null> {
    const key = hashCode(code)
    const entry = this.codes.get(key)
    this.codes.delete(key)
    if (!entry || entry.expiresAt <= Date.now()) return null

    return this.host.auth.startSession({ userId: entry.userId, now: new Date(), ...device })
  }

  private async ensureMember(person: BranchHandoverPerson): Promise<void> {
    const auth = this.host.storage.auth
    if (!auth) throw new Error("[Sixb] A branch signs people in through storage.auth.")
    const projectId = this.host.projectId

    // Production let them in as an active member: the copy, taken earlier, may say otherwise.
    const existing = await auth.users.getById({ projectId, id: person.id })
    if (!existing) {
      await auth.users.create({
        projectId,
        id: person.id,
        email: person.email,
        ...(person.displayName ? { displayName: person.displayName } : {}),
      })
    } else if (existing.status !== "active") {
      await auth.users.updateStatus({ projectId, id: person.id, status: "active" })
    }

    // Their groups as production has them now: none the copy kept, none it lacks.
    const wanted = new Set(person.groupIds)
    const held = await auth.groupMemberships.listForUser({ projectId, userId: person.id })
    for (const membership of held) {
      if (wanted.has(membership.groupId)) continue
      await auth.groupMemberships.remove({
        projectId,
        userId: person.id,
        groupId: membership.groupId,
      })
    }
    for (const groupId of wanted) {
      await auth.groupMemberships.upsert({
        projectId,
        userId: person.id,
        groupId,
        source: "manual",
      })
    }
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(key)
    }
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}
