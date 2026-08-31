import type { Principal } from "../../auth"
import type { RuntimeAccessPlan } from "../../authorization/access-plan"
import type { AuthorizablePrincipal } from "../../execution/types"
import type { ObjectRef } from "../../ontology"

/** First durable encoding of the exact authority captured when a Share is issued. */
export interface ShareAuthoritySnapshotV1 {
  readonly version: 1
  readonly access: RuntimeAccessPlan
}

/** Versioned so persisted grants can fail closed when a future encoding is introduced. */
export type ShareAuthoritySnapshot = ShareAuthoritySnapshotV1

/** Durable audit and authority record for one issued Share link. */
export interface ShareGrantRecord {
  readonly id: string
  readonly projectId: string
  readonly definitionId: string
  readonly target: ObjectRef
  /** Audit attribution only. The issuer never contributes ambient authority to the Share. */
  readonly issuedBy: AuthorizablePrincipal
  readonly authoritySnapshot: ShareAuthoritySnapshot
  /** SHA-256 of the canonical authority snapshot. */
  readonly authorityDigest: string
  /** SHA-256 of the one-time link secret. The plaintext secret is never durable. */
  readonly tokenHash: string
  readonly destinationPath: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
  readonly revokedBy?: Principal
}

/** Create input omits fields derived by storage or written only by revocation. */
export type CreateShareGrantInput = Omit<
  ShareGrantRecord,
  "authorityDigest" | "revokedAt" | "revokedBy"
>

export interface GetShareGrantByIdInput {
  readonly projectId: string
  readonly id: string
}

export interface ListShareGrantsInput {
  readonly projectId: string
  readonly definitionId?: string
  readonly target?: ObjectRef
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
  /** Explicit clock keeps expiry semantics deterministic across providers. */
  readonly now: Date
  readonly limit?: number
  readonly offset?: number
}

export interface NormalizedListShareGrantsInput {
  readonly projectId: string
  readonly definitionId?: string
  readonly target?: ObjectRef
  readonly includeRevoked: boolean
  readonly includeExpired: boolean
  readonly now: Date
  readonly limit: number
  readonly offset: number
}

export interface ListShareGrantsResult {
  readonly grants: readonly ShareGrantRecord[]
  /** Matching rows before offset/limit are applied. */
  readonly total: number
  /** True when at least one matching row remains after this page. */
  readonly hasMore: boolean
}

export interface RevokeShareGrantInput {
  readonly projectId: string
  readonly id: string
  readonly revokedAt: Date
  readonly revokedBy: Principal
}

/**
 * Persistence only. Secret generation, verification, and current-definition intersection are
 * Core. Every returned record must be detached from provider state; deeply immutable records also
 * satisfy that isolation contract.
 */
export interface ShareGrantStorage {
  /**
   * Persist a normalized grant, deriving `authorityDigest`. The `(projectId, id)` and
   * `(projectId, tokenHash)` pairs must both be unique; either collision reports `duplicate`.
   */
  create(input: CreateShareGrantInput): Promise<ShareGrantRecord>

  /** Load one project-scoped grant, including expired or revoked grants, or return null. */
  getById(input: GetShareGrantByIdInput): Promise<ShareGrantRecord | null>

  /**
   * List in deterministic `createdAt DESC, id DESC` order. Expired and revoked rows are excluded
   * unless requested; `total` is computed after filtering and before pagination. A root call may
   * be weakly consistent with concurrent writes; callers that need one snapshot use
   * `Storage.transaction`.
   */
  list(input: ListShareGrantsInput): Promise<ListShareGrantsResult>

  /**
   * Atomically preserve the first revocation. Repeating a revocation returns that first record;
   * a missing grant returns null.
   */
  revoke(input: RevokeShareGrantInput): Promise<ShareGrantRecord | null>
}
