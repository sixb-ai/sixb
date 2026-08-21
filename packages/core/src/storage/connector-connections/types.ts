import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { AuthorizablePrincipal } from "../../execution/types"
import type { ObjectRef } from "../../ontology/refs"
import type { SealedEnvelope } from "./envelope"

/**
 * Error codes a connector authorization can persist.
 *
 * `connector.refresh_failed` is retryable and leaves the grant usable; `connector.authorization_invalid`
 * is terminal. `releaseRefreshLease` branches on the catalog's `retryable` policy rather than a
 * separate flag, so the code and the outcome cannot disagree.
 */
export const CONNECTOR_CONNECTION_FAILURE_CODES = [
  "connector.authorization_invalid",
  "connector.refresh_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type ConnectorConnectionFailureCode = (typeof CONNECTOR_CONNECTION_FAILURE_CODES)[number]
export type ConnectorConnectionFailure = SixbFailure<ConnectorConnectionFailureCode>

/**
 * Who a connection belongs to.
 *
 * `AuthorizablePrincipal` rather than `Principal`: a `system` principal cannot consent to an
 * external account, and `execution/authorization.ts` already refuses it runtime authority.
 */
export type ConnectorConnectionOwner =
  | { readonly type: "project" }
  | { readonly type: "principal"; readonly principal: AuthorizablePrincipal }
  | { readonly type: "object"; readonly ref: ObjectRef }

/**
 * A pending authorization round trip.
 *
 * Everything the callback may act on is decided here, under whatever permission check the caller
 * applies at initiation. The callback supplies only `state`, so it can never retarget the owner or
 * the slot — that is what keeps "changing the account in a slot is explicit" enforceable below the
 * redirect handler rather than inside it.
 */
export interface ConnectorAuthorizationAttemptRecord {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  /** SHA-256 of the `state` parameter. The raw value is never persisted. */
  readonly stateHash: string
  readonly requestedBy: AuthorizablePrincipal
  readonly owner: ConnectorConnectionOwner
  readonly slot: string
  /** Exact redirect URI presented to the provider; the callback must match it. */
  readonly redirectUri: string
  readonly scopes: readonly string[]
  /**
   * PKCE S256 verifier, sealed.
   *
   * The sibling `auth_oidc_authorization_attempts.code_verifier` stores this in plaintext. Sealing
   * it here means a leaked row is not a usable second factor for a stolen authorization code.
   */
  readonly codeVerifier: SealedEnvelope
  /** Allowlisted at creation, so the callback only has to honour a decided fact. */
  readonly returnTo?: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date
}

export type CreateConnectorAuthorizationAttemptInput = Omit<
  ConnectorAuthorizationAttemptRecord,
  "consumedAt"
>

export interface ConnectorAuthorizationAttemptStore {
  create(
    input: CreateConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord>

  /**
   * Burns an attempt exactly once.
   *
   * There is deliberately no `getById`: a read that does not consume is a replay window on a
   * CSRF-critical single-use token, and nothing in the callback flow needs one. Rejects unknown,
   * expired, already-consumed, and state-mismatched attempts with
   * `connector.authorization_attempt_invalid`.
   */
  consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<ConnectorAuthorizationAttemptRecord>
}

/**
 * `superseded` means a newer grant replaced this one; `invalid` means the provider rejected it;
 * `revoked` means we withdrew it. All three are terminal but an operator needs to tell them apart,
 * and the vocabulary ends up in a SQL `CHECK` that SQLite cannot widen without a table rebuild.
 */
export type ConnectorAuthorizationStatus = "active" | "superseded" | "invalid" | "revoked"

/**
 * One OAuth grant.
 *
 * Held separately from connections because a single grant may expose several external accounts;
 * those connections share this row rather than duplicating token material.
 */
export interface ConnectorAuthorizationRecord {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly status: ConnectorAuthorizationStatus
  readonly authorizedBy: AuthorizablePrincipal
  /** Scopes the provider actually granted, which may be narrower than those requested. */
  readonly scopes: readonly string[]
  /** Sealed token material. Storage never opens it; only the runtime holds the key. */
  readonly credentials: SealedEnvelope
  readonly credentialsExpireAt?: Date
  /**
   * Counts committed credential versions, and nothing else.
   *
   * Only `commitRefresh` bumps it. If releasing or revoking moved it, every concurrent refresher
   * would lose its compare-and-set and re-refresh a grant that was already rotated.
   */
  readonly revision: number
  readonly refreshLeaseOwner?: string
  readonly refreshLeaseExpiresAt?: Date
  /** The last refresh outcome. Terminal codes are what move `status` to `invalid`. */
  readonly failure?: ConnectorConnectionFailure
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly terminalAt?: Date
}

export type CreateConnectorAuthorizationInput = Pick<
  ConnectorAuthorizationRecord,
  | "id"
  | "projectId"
  | "connectorId"
  | "authorizedBy"
  | "scopes"
  | "credentials"
  | "credentialsExpireAt"
  | "createdAt"
>

/** Outcome of trying to take the single refresh slot for a grant. */
export interface AcquireConnectorRefreshLeaseResult {
  readonly acquired: boolean
  /**
   * The current record either way.
   *
   * A caller that loses the race needs it: the winner may have already rotated the credentials,
   * in which case re-reading is correct and refreshing again is not.
   */
  readonly authorization: ConnectorAuthorizationRecord
}

export interface ConnectorAuthorizationStore {
  create(input: CreateConnectorAuthorizationInput): Promise<ConnectorAuthorizationRecord>

  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ConnectorAuthorizationRecord | null>

  /** Takes the refresh slot when the grant is active and no live lease is held. */
  acquireRefreshLease(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly leaseExpiresAt: Date
    readonly now: Date
  }): Promise<AcquireConnectorRefreshLeaseResult>

  /**
   * Persists rotated credentials and releases the lease as one step.
   *
   * Throws `connector.refresh_conflict` when `expectedRevision` no longer matches, rather than
   * reporting it in a return value. Silently discarding a rotated refresh token is the one failure
   * here that cannot be recovered without the user reconnecting, so it must not be ignorable.
   */
  commitRefresh(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly expectedRevision: number
    readonly credentials: SealedEnvelope
    readonly credentialsExpireAt?: Date
    readonly refreshedAt: Date
  }): Promise<ConnectorAuthorizationRecord>

  /**
   * Releases the lease without rotating.
   *
   * A non-retryable `failure` moves the grant to `invalid`, which every attached connection then
   * reads as `needs_reauthorization` without a single write of its own.
   */
  releaseRefreshLease(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly failure?: ConnectorConnectionFailure
    readonly releasedAt: Date
  }): Promise<ConnectorAuthorizationRecord>

  revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<ConnectorAuthorizationRecord>
}

/**
 * Derived from the connection and its grant, never stored.
 *
 * Storing it would make a terminal refresh failure a fan-out write over every attached connection,
 * with a crash window in the middle and a lasting way for the two to disagree. Deriving costs one
 * join and cannot drift.
 */
export type ConnectorConnectionStatus =
  | "connected"
  | "needs_reauthorization"
  | "revoked"
  | "disconnected"

/** One external account, bound to a Sixb owner and slot. */
export interface ConnectorConnectionRecord {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly owner: ConnectorConnectionOwner
  /** Application-defined stable role, such as `"social"`. */
  readonly slot: string
  readonly authorizationId: string
  readonly externalAccountId: string
  /** Display label for a connect UI. Never a secret. */
  readonly externalAccountLabel?: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly disconnectedAt?: Date
}

export interface UpsertConnectorConnectionInput {
  /**
   * Used only when the slot is empty.
   *
   * Reconnecting the same account keeps the existing id, which is what makes reauthorization
   * transparent to an application already holding one.
   */
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly owner: ConnectorConnectionOwner
  readonly slot: string
  readonly authorizationId: string
  readonly externalAccountId: string
  readonly externalAccountLabel?: string
  readonly at: Date
}

export interface ConnectorConnectionStore {
  /** Keyed by `(projectId, connectorId, owner, slot)` — at most one live connection each. */
  upsert(input: UpsertConnectorConnectionInput): Promise<ConnectorConnectionRecord>

  /** Returns disconnected rows too; the caller derives status with `connectorConnectionStatus`. */
  getBySlot(params: {
    readonly projectId: string
    readonly connectorId: string
    readonly owner: ConnectorConnectionOwner
    readonly slot: string
  }): Promise<ConnectorConnectionRecord | null>

  /**
   * Every connection sharing one grant.
   *
   * Revoking or reauthorizing a shared grant affects all of them, and a UI cannot honestly confirm
   * either action without being able to name them.
   */
  listByAuthorization(params: {
    readonly projectId: string
    readonly authorizationId: string
  }): Promise<readonly ConnectorConnectionRecord[]>

  /** Retires one connection. The grant is untouched, so accounts sharing it keep working. */
  disconnect(params: {
    readonly projectId: string
    readonly id: string
    readonly disconnectedAt: Date
  }): Promise<ConnectorConnectionRecord>
}

/**
 * Persistent connector connections.
 *
 * Named for the durable rows, not for `ConnectorService`'s in-process client cache, which is a
 * different thing entirely despite the overlapping vocabulary.
 */
export interface ConnectorConnectionStorage {
  readonly attempts: ConnectorAuthorizationAttemptStore
  readonly authorizations: ConnectorAuthorizationStore
  readonly connections: ConnectorConnectionStore
}
