import { timingSafeEqual } from "node:crypto"
import { createSixbError, toSixbFailure } from "../../../errors/internal"
import { ConnectorConnectionStorageError } from "../errors"
import type {
  ClaimConnectorCredentialMutationInput,
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionRunProcessingRecord,
  ConnectorConnectionRunRecord,
  ConnectorCredentialMutationFence,
  GetConnectorConnectionInput,
} from "../types"
import { CONNECTOR_CONNECTION_RUN_FAILURE_CODES } from "../types"

export interface ConnectorConnectionPersistenceScope {
  readonly projectId: string
  /** Omitted only while resolving a callback whose public proof intentionally carries no id. */
  readonly connectorId?: string
}

/** Database-specific record access used by the shared connector lifecycle state machine. */
export interface ConnectorConnectionPersistence {
  now(): Promise<Date>

  insertAuthorizationAttempt(record: ConnectorAuthorizationAttemptRecord): Promise<boolean>
  getAuthorizationAttempt(id: string): Promise<ConnectorAuthorizationAttemptRecord | null>
  getAuthorizationAttemptByConnectionRunId(
    connectionRunId: string
  ): Promise<ConnectorAuthorizationAttemptRecord | null>
  deleteAuthorizationAttempt(id: string): Promise<boolean>

  insertConnectionRun(record: ConnectorConnectionRunRecord): Promise<boolean>
  getConnectionRun(id: string): Promise<ConnectorConnectionRunRecord | null>
  updateConnectionRun(record: ConnectorConnectionRunRecord): Promise<void>

  insertAuthorization(record: ConnectorAuthorizationRecord): Promise<boolean>
  getAuthorization(id: string): Promise<ConnectorAuthorizationRecord | null>
  updateAuthorization(record: ConnectorAuthorizationRecord): Promise<void>

  insertConnection(record: ConnectorConnectionRecord): Promise<boolean>
  getConnectionById(id: string): Promise<ConnectorConnectionRecord | null>
  getConnectionBySelector(
    input: Pick<GetConnectorConnectionInput, "owner" | "slot">
  ): Promise<ConnectorConnectionRecord | null>
  listConnections(): Promise<readonly ConnectorConnectionRecord[]>
  listConnectionsByAuthorization(
    authorizationId: string,
    options?: { readonly connectedOnly?: boolean }
  ): Promise<readonly ConnectorConnectionRecord[]>
  updateConnection(record: ConnectorConnectionRecord): Promise<void>
}

/** Transaction and lock boundary supplied by a concrete durable storage provider. */
export interface ConnectorConnectionPersistenceBackend {
  read<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T>
  transaction<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T>
}

export abstract class ConnectorConnectionOperations {
  constructor(private readonly backend: ConnectorConnectionPersistenceBackend) {}

  protected read<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return this.backend.read(scope, run)
  }

  protected write<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return this.backend.transaction(scope, run)
  }
}

export async function currentConnectionRun(
  persistence: ConnectorConnectionPersistence,
  runId: string
): Promise<ConnectorConnectionRunRecord | null> {
  const run = await persistence.getConnectionRun(runId)
  if (!run || (run.status !== "waiting" && run.status !== "running")) return run

  const now = await persistence.now()
  if (run.expiresAt.getTime() > now.getTime()) return run

  if (run.status === "waiting" && run.waitingFor === "provider_authorization") {
    const attempt = await persistence.getAuthorizationAttemptByConnectionRunId(run.id)
    if (attempt) await persistence.deleteAuthorizationAttempt(attempt.id)
  }
  if (run.status === "waiting") {
    if (run.kind === "connect" && run.waitingFor === "account_selection") {
      await markPendingAuthorizationForCleanup(persistence, run.authorizationId, now)
    }
    const expired = expireConnectionRun(run, now)
    await persistence.updateConnectionRun(expired)
    return expired
  }

  if (run.kind === "connect" && run.authorizationId) {
    await markPendingAuthorizationForCleanup(persistence, run.authorizationId, now)
  }
  const failed = failExpiredProcessingRun(run, now)
  await persistence.updateConnectionRun(failed)
  return failed
}

export async function markPendingAuthorizationForCleanup(
  persistence: ConnectorConnectionPersistence,
  authorizationId: string,
  now: Date
): Promise<void> {
  const authorization = await persistence.getAuthorization(authorizationId)
  if (!authorization || authorization.status !== "pending_selection") return
  await persistence.updateAuthorization(markAuthorizationRevocationPending(authorization, now))
}

export function connectionRunBase(record: ConnectorConnectionRunRecord, updatedAt: Date) {
  return {
    id: record.id,
    projectId: record.projectId,
    connectorId: record.connectorId,
    kind: record.kind,
    owner: structuredClone(record.owner),
    slot: record.slot,
    initiatedByExecutionId: record.initiatedByExecutionId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(updatedAt),
  }
}

function expireConnectionRun(
  record: Extract<ConnectorConnectionRunRecord, { readonly status: "waiting" }>,
  now: Date
) {
  return {
    ...connectionRunBase(record, now),
    status: "expired" as const,
    ...(record.waitingFor === "account_selection"
      ? { authorizationId: record.authorizationId }
      : {}),
    finishedAt: new Date(now),
  }
}

function failExpiredProcessingRun(record: ConnectorConnectionRunProcessingRecord, now: Date) {
  return {
    ...connectionRunBase(record, now),
    status: "failed" as const,
    ...(record.authorizationId === undefined ? {} : { authorizationId: record.authorizationId }),
    error: toSixbFailure(
      createSixbError(
        "internal.unexpected",
        "[Sixb] Connector callback processing did not complete before its deadline."
      ),
      { allowedCodes: CONNECTOR_CONNECTION_RUN_FAILURE_CODES, at: now }
    ),
    finishedAt: new Date(now),
  }
}

export function disconnectConnectionRecord(
  connection: ConnectorConnectionRecord,
  now: Date
): ConnectorConnectionRecord {
  return {
    ...connection,
    status: "disconnected",
    disconnectedAt: new Date(now),
    updatedAt: new Date(now),
  }
}

export function markAuthorizationRevocationPending(
  authorization: ConnectorAuthorizationRecord,
  now: Date
): ConnectorAuthorizationRecord {
  if (authorization.status === "revocation_pending" || authorization.status === "revoked") {
    return authorization
  }
  if (authorization.credentialMutation) {
    throw new ConnectorConnectionStorageError(
      "authorization_conflict",
      "[Sixb] Connector authorization cannot begin revocation while credentials are being mutated."
    )
  }
  return {
    ...authorization,
    status: "revocation_pending",
    selectionExpiresAt: undefined,
    revision: authorization.revision + 1,
    updatedAt: new Date(now),
  }
}

export function assertConnectionCanMove(
  authorization: ConnectorAuthorizationRecord,
  removingLastConnection = true
): void {
  const mutation = authorization.credentialMutation
  if (mutation?.kind === "reauthorization") {
    throw new ConnectorConnectionStorageError(
      "authorization_conflict",
      "[Sixb] Connections cannot change while their connector authorization is being reauthorized."
    )
  }
  if (removingLastConnection && mutation) {
    throw new ConnectorConnectionStorageError(
      "authorization_conflict",
      "[Sixb] The last connector connection cannot be removed while credentials are being mutated."
    )
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function invalidRun(): ConnectorConnectionStorageError {
  return new ConnectorConnectionStorageError(
    "run_invalid",
    "[Sixb] Connector connection run is invalid, expired, or already used."
  )
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  )
}

export function invalidAttempt(): ConnectorConnectionStorageError {
  return new ConnectorConnectionStorageError(
    "attempt_invalid",
    "[Sixb] Connector authorization attempt is invalid, expired, or already used."
  )
}

export function authorizationConflict(): ConnectorConnectionStorageError {
  return new ConnectorConnectionStorageError(
    "authorization_conflict",
    "[Sixb] Connector connection requires a selectable authorization from the same project and connector."
  )
}

export function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConnectorConnectionStorageError(
      "invalid_input",
      `[Sixb] Connector ${name} must be positive.`
    )
  }
}

export function canClaimMutation(
  status: ConnectorAuthorizationRecord["status"],
  kind: ClaimConnectorCredentialMutationInput["mutation"]["kind"]
): boolean {
  if (kind === "refresh") return status === "active"
  if (kind === "reauthorization") {
    return status === "active" || status === "needs_reauthorization"
  }
  return status !== "revoked"
}

export function isSelectable(status: ConnectorAuthorizationRecord["status"]): boolean {
  return status === "pending_selection" || status === "active"
}

export function leaseExpiry(now: Date, durationMs: number, deadlineAt: Date): Date {
  return new Date(Math.min(now.getTime() + durationMs, deadlineAt.getTime()))
}

export function mutationExpired(record: ConnectorAuthorizationRecord, now: Date): boolean {
  return (
    record.credentialMutation!.expiresAt.getTime() <= now.getTime() ||
    record.credentialMutation!.deadlineAt.getTime() <= now.getTime()
  )
}

export function matchesMutation(
  record: ConnectorAuthorizationRecord | null,
  input: ConnectorCredentialMutationFence,
  holderId?: string
): record is ConnectorAuthorizationRecord & {
  readonly credentialMutation: NonNullable<ConnectorAuthorizationRecord["credentialMutation"]>
} {
  return (
    record !== null &&
    record.revision === input.expectedRevision &&
    record.credentialMutation?.id === input.mutationId &&
    (holderId === undefined || record.credentialMutation.holderId === holderId)
  )
}

export function stagedCredentials(
  record: ConnectorAuthorizationRecord | null,
  input: ConnectorCredentialMutationFence,
  kind: "refresh" | "reauthorization"
) {
  if (
    !matchesMutation(record, input) ||
    record.credentialMutation.kind !== kind ||
    record.credentialMutation.phase !== "result_staged"
  ) {
    return null
  }
  return record.credentialMutation.stagedCredentials ?? null
}

export function applyStagedCredentials(
  record: ConnectorAuthorizationRecord,
  staged: NonNullable<ReturnType<typeof stagedCredentials>>,
  now: Date,
  input: { readonly accounts: readonly ConnectorAuthorizationRecord["accounts"][number][] }
): ConnectorAuthorizationRecord {
  return {
    ...record,
    credentials: structuredClone(staged.credentials),
    credentialExpiresAt:
      staged.credentialExpiresAt === undefined ? undefined : new Date(staged.credentialExpiresAt),
    scopes: [...staged.scopes],
    accounts: structuredClone(input.accounts),
    status: "active",
    selectionExpiresAt: undefined,
    revision: record.revision + 1,
    credentialMutation: undefined,
    updatedAt: now,
  }
}
