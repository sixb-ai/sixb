/** Durable server-side session created after a Share link secret is exchanged. */
export interface ShareSessionRecord {
  readonly id: string
  readonly projectId: string
  readonly grantId: string
  /** SHA-256 of the bearer session secret. The plaintext secret is never durable. */
  readonly tokenHash: string
  readonly createdAt: Date
  /** Sliding inactivity deadline. */
  readonly expiresAt: Date
  /** Immutable upper bound, normally inherited from the Share grant expiry. */
  readonly absoluteExpiresAt: Date
  readonly revokedAt?: Date
}

export type CreateShareSessionInput = Omit<ShareSessionRecord, "revokedAt">

export interface GetShareSessionByIdInput {
  readonly projectId: string
  readonly id: string
}

export interface RenewShareSessionIfValidInput {
  readonly projectId: string
  readonly id: string
  readonly grantId: string
  readonly tokenHash: string
  /** Explicit clock keeps expiry semantics deterministic across providers. */
  readonly now: Date
  /** Requested sliding inactivity deadline. Storage clamps it to the absolute deadline. */
  readonly expiresAt: Date
}

export interface RevokeShareSessionInput {
  readonly projectId: string
  readonly id: string
  readonly revokedAt: Date
}

/** Persistence contract for short-lived Share access sessions. */
export interface ShareSessionStorage {
  /** `(projectId, id)` and `(projectId, tokenHash)` must both be unique. */
  create(input: CreateShareSessionInput): Promise<ShareSessionRecord>

  /** Load one project-scoped session, including expired or revoked sessions, or return null. */
  getById(input: GetShareSessionByIdInput): Promise<ShareSessionRecord | null>

  /**
   * Atomically authenticate and renew an active session. Mismatched, expired, or revoked sessions
   * return null. A renewal never shortens the current deadline and never exceeds
   * `absoluteExpiresAt`.
   */
  renewIfValid(input: RenewShareSessionIfValidInput): Promise<ShareSessionRecord | null>

  /** Preserve and return the first revocation; a missing session returns null. */
  revoke(input: RevokeShareSessionInput): Promise<ShareSessionRecord | null>
}
