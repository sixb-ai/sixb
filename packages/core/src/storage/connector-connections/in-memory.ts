import { createSixbError, parseSixbFailure } from "../../errors/internal"
import { connectorConnectionOwnerKey } from "./keys"
import {
  type AcquireConnectorRefreshLeaseResult,
  CONNECTOR_CONNECTION_FAILURE_CODES,
  type ConnectorAuthorizationAttemptRecord,
  type ConnectorAuthorizationAttemptStore,
  type ConnectorAuthorizationRecord,
  type ConnectorAuthorizationStore,
  type ConnectorConnectionFailure,
  type ConnectorConnectionOwner,
  type ConnectorConnectionRecord,
  type ConnectorConnectionStorage,
  type ConnectorConnectionStore,
  type CreateConnectorAuthorizationAttemptInput,
  type CreateConnectorAuthorizationInput,
  type UpsertConnectorConnectionInput,
} from "./types"

export interface InMemoryConnectorConnectionStorageSnapshot {
  readonly attempts: Map<string, ConnectorAuthorizationAttemptRecord>
  readonly authorizations: Map<string, ConnectorAuthorizationRecord>
  readonly connections: Map<string, ConnectorConnectionRecord>
}

function recordKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function slotKey(
  projectId: string,
  connectorId: string,
  owner: ConnectorConnectionOwner,
  slot: string
): string {
  return JSON.stringify([projectId, connectorId, connectorConnectionOwnerKey(owner), slot])
}

class InMemoryConnectorAuthorizationAttempts implements ConnectorAuthorizationAttemptStore {
  constructor(private readonly attempts: Map<string, ConnectorAuthorizationAttemptRecord>) {}

  async create(
    input: CreateConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    // Attempts are short-lived and never listed, so the cheapest place to reap them is the next
    // write. `InMemoryFileUploadSessions.create` takes the same approach rather than run a sweeper.
    this.reapExpired(input.createdAt)

    const record: ConnectorAuthorizationAttemptRecord = structuredClone({
      ...input,
    })
    this.attempts.set(recordKey(record.projectId, record.id), record)
    return structuredClone(record)
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<ConnectorAuthorizationAttemptRecord> {
    const key = recordKey(params.projectId, params.id)
    const attempt = this.attempts.get(key)

    if (!attempt) throw attemptInvalid(params, "not_found")
    if (attempt.consumedAt !== undefined) throw attemptInvalid(params, "already_consumed")
    if (attempt.expiresAt.getTime() <= params.consumedAt.getTime()) {
      throw attemptInvalid(params, "expired")
    }
    if (attempt.stateHash !== params.stateHash) throw attemptInvalid(params, "state_mismatch")

    const consumed: ConnectorAuthorizationAttemptRecord = {
      ...attempt,
      consumedAt: params.consumedAt,
    }
    this.attempts.set(key, structuredClone(consumed))
    return structuredClone(consumed)
  }

  private reapExpired(now: Date): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.expiresAt.getTime() <= now.getTime()) {
        this.attempts.delete(key)
      }
    }
  }
}

class InMemoryConnectorAuthorizations implements ConnectorAuthorizationStore {
  constructor(private readonly authorizations: Map<string, ConnectorAuthorizationRecord>) {}

  async create(input: CreateConnectorAuthorizationInput): Promise<ConnectorAuthorizationRecord> {
    const record: ConnectorAuthorizationRecord = {
      ...input,
      status: "active",
      revision: 1,
      updatedAt: input.createdAt,
    }
    this.authorizations.set(recordKey(record.projectId, record.id), structuredClone(record))
    return structuredClone(record)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(recordKey(params.projectId, params.id))
    return record ? structuredClone(record) : null
  }

  async acquireRefreshLease(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly leaseExpiresAt: Date
    readonly now: Date
  }): Promise<AcquireConnectorRefreshLeaseResult> {
    const authorization = this.require(params.projectId, params.id, "acquire a refresh lease")

    const heldUntil = authorization.refreshLeaseExpiresAt?.getTime()
    const held = heldUntil !== undefined && heldUntil > params.now.getTime()
    if (authorization.status !== "active" || held) {
      return { acquired: false, authorization: structuredClone(authorization) }
    }

    const leased: ConnectorAuthorizationRecord = {
      ...authorization,
      refreshLeaseOwner: params.leaseOwner,
      refreshLeaseExpiresAt: params.leaseExpiresAt,
      updatedAt: params.now,
    }
    this.write(leased)
    return { acquired: true, authorization: structuredClone(leased) }
  }

  async commitRefresh(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly expectedRevision: number
    readonly credentials: ConnectorAuthorizationRecord["credentials"]
    readonly credentialsExpireAt?: Date
    readonly refreshedAt: Date
  }): Promise<ConnectorAuthorizationRecord> {
    const authorization = this.require(params.projectId, params.id, "commit a refresh")

    // Both halves of the compare-and-set: the caller must still hold the lease, and the credential
    // version it read must still be current. Either one failing means another process already
    // rotated, and continuing would overwrite a newer refresh token with an older one.
    if (
      authorization.refreshLeaseOwner !== params.leaseOwner ||
      authorization.revision !== params.expectedRevision
    ) {
      throw createSixbError(
        "connector.refresh_conflict",
        "[Sixb] Connector credentials changed while refreshing.",
        {
          details: {
            projectId: params.projectId,
            authorizationId: params.id,
            expectedRevision: params.expectedRevision,
            actualRevision: authorization.revision,
          },
        }
      )
    }

    const committed: ConnectorAuthorizationRecord = {
      ...authorization,
      credentials: params.credentials,
      revision: authorization.revision + 1,
      updatedAt: params.refreshedAt,
      ...(params.credentialsExpireAt === undefined
        ? {}
        : { credentialsExpireAt: params.credentialsExpireAt }),
    }
    // The rotated material and the lease release land together, so there is no window in which a
    // second refresher can take the lease while the new token is still unpersisted.
    this.write(withoutLease(withoutFailure(committed)))
    return structuredClone(this.require(params.projectId, params.id, "commit a refresh"))
  }

  async releaseRefreshLease(params: {
    readonly projectId: string
    readonly id: string
    readonly leaseOwner: string
    readonly failure?: ConnectorConnectionFailure
    readonly releasedAt: Date
  }): Promise<ConnectorAuthorizationRecord> {
    const authorization = this.require(params.projectId, params.id, "release a refresh lease")
    if (authorization.refreshLeaseOwner !== params.leaseOwner) {
      return structuredClone(authorization)
    }

    const failure =
      params.failure === undefined
        ? undefined
        : parseSixbFailure(params.failure, CONNECTOR_CONNECTION_FAILURE_CODES)

    // Terminality is read off the catalog policy the code already carries, so a separate flag
    // cannot contradict the code that was recorded.
    const terminal = failure !== undefined && !failure.retryable

    const released: ConnectorAuthorizationRecord = {
      ...withoutLease(authorization),
      updatedAt: params.releasedAt,
      ...(failure === undefined ? {} : { failure }),
      ...(terminal ? { status: "invalid" as const, terminalAt: params.releasedAt } : {}),
    }
    this.write(released)
    return structuredClone(released)
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<ConnectorAuthorizationRecord> {
    const authorization = this.require(params.projectId, params.id, "revoke")
    if (authorization.status === "revoked") {
      return structuredClone(authorization)
    }

    const revoked: ConnectorAuthorizationRecord = {
      ...withoutLease(authorization),
      status: "revoked",
      terminalAt: params.revokedAt,
      updatedAt: params.revokedAt,
    }
    this.write(revoked)
    return structuredClone(revoked)
  }

  private require(projectId: string, id: string, operation: string): ConnectorAuthorizationRecord {
    const record = this.authorizations.get(recordKey(projectId, id))
    if (!record) {
      throw createSixbError(
        "connector.authorization_invalid",
        `[Sixb] Connector authorization '${id}' was not found and cannot ${operation}.`,
        { details: { projectId, authorizationId: id } }
      )
    }
    return record
  }

  private write(record: ConnectorAuthorizationRecord): void {
    this.authorizations.set(recordKey(record.projectId, record.id), structuredClone(record))
  }
}

class InMemoryConnectorConnections implements ConnectorConnectionStore {
  constructor(private readonly connections: Map<string, ConnectorConnectionRecord>) {}

  async upsert(input: UpsertConnectorConnectionInput): Promise<ConnectorConnectionRecord> {
    const existing = this.findLive(input.projectId, input.connectorId, input.owner, input.slot)

    // Reconnecting an occupied slot keeps the original id and creation instant, which is what makes
    // reauthorization invisible to an application already holding the id.
    const record: ConnectorConnectionRecord = {
      id: existing?.id ?? input.id,
      projectId: input.projectId,
      connectorId: input.connectorId,
      owner: input.owner,
      slot: input.slot,
      authorizationId: input.authorizationId,
      externalAccountId: input.externalAccountId,
      createdAt: existing?.createdAt ?? input.at,
      updatedAt: input.at,
      ...(input.externalAccountLabel === undefined
        ? {}
        : { externalAccountLabel: input.externalAccountLabel }),
    }

    this.connections.set(recordKey(record.projectId, record.id), structuredClone(record))
    return structuredClone(record)
  }

  async getBySlot(params: {
    readonly projectId: string
    readonly connectorId: string
    readonly owner: ConnectorConnectionOwner
    readonly slot: string
  }): Promise<ConnectorConnectionRecord | null> {
    const live = this.findLive(params.projectId, params.connectorId, params.owner, params.slot)
    if (live) return structuredClone(live)

    const target = slotKey(params.projectId, params.connectorId, params.owner, params.slot)
    for (const record of this.connections.values()) {
      if (this.keyOf(record) === target) return structuredClone(record)
    }
    return null
  }

  async listByAuthorization(params: {
    readonly projectId: string
    readonly authorizationId: string
  }): Promise<readonly ConnectorConnectionRecord[]> {
    const matches: ConnectorConnectionRecord[] = []
    for (const record of this.connections.values()) {
      if (
        record.projectId === params.projectId &&
        record.authorizationId === params.authorizationId
      ) {
        matches.push(structuredClone(record))
      }
    }
    return matches
  }

  async disconnect(params: {
    readonly projectId: string
    readonly id: string
    readonly disconnectedAt: Date
  }): Promise<ConnectorConnectionRecord> {
    const key = recordKey(params.projectId, params.id)
    const record = this.connections.get(key)
    if (!record) {
      throw createSixbError(
        "connector.authorization_invalid",
        `[Sixb] Connector connection '${params.id}' was not found and cannot be disconnected.`,
        { details: { projectId: params.projectId, connectionId: params.id } }
      )
    }
    if (record.disconnectedAt !== undefined) {
      return structuredClone(record)
    }

    const disconnected: ConnectorConnectionRecord = {
      ...record,
      disconnectedAt: params.disconnectedAt,
      updatedAt: params.disconnectedAt,
    }
    this.connections.set(key, structuredClone(disconnected))
    return structuredClone(disconnected)
  }

  private findLive(
    projectId: string,
    connectorId: string,
    owner: ConnectorConnectionOwner,
    slot: string
  ): ConnectorConnectionRecord | undefined {
    const target = slotKey(projectId, connectorId, owner, slot)
    for (const record of this.connections.values()) {
      if (record.disconnectedAt === undefined && this.keyOf(record) === target) {
        return record
      }
    }
    return undefined
  }

  private keyOf(record: ConnectorConnectionRecord): string {
    return slotKey(record.projectId, record.connectorId, record.owner, record.slot)
  }
}

/**
 * In-memory {@link ConnectorConnectionStorage} for development and tests.
 *
 * Every I/O method carries the `async` keyword on purpose: `createOperationScopedFacade` classifies
 * methods by `constructor.name`, so a method that merely returns a promise would slip out of the
 * storage lock and quietly break transaction atomicity. `snapshot`/`restore` stay synchronous for
 * the same reason inverted — they run inside the lock.
 */
export class InMemoryConnectorConnectionStorage implements ConnectorConnectionStorage {
  private readonly attemptRecords = new Map<string, ConnectorAuthorizationAttemptRecord>()
  private readonly authorizationRecords = new Map<string, ConnectorAuthorizationRecord>()
  private readonly connectionRecords = new Map<string, ConnectorConnectionRecord>()

  readonly attempts = new InMemoryConnectorAuthorizationAttempts(this.attemptRecords)
  readonly authorizations = new InMemoryConnectorAuthorizations(this.authorizationRecords)
  readonly connections = new InMemoryConnectorConnections(this.connectionRecords)

  snapshot(): InMemoryConnectorConnectionStorageSnapshot {
    return {
      attempts: structuredClone(this.attemptRecords),
      authorizations: structuredClone(this.authorizationRecords),
      connections: structuredClone(this.connectionRecords),
    }
  }

  restore(snapshot: InMemoryConnectorConnectionStorageSnapshot): void {
    restoreInto(this.attemptRecords, snapshot.attempts)
    restoreInto(this.authorizationRecords, snapshot.authorizations)
    restoreInto(this.connectionRecords, snapshot.connections)
  }
}

function restoreInto<T>(target: Map<string, T>, snapshot: Map<string, T>): void {
  target.clear()
  for (const [key, record] of structuredClone(snapshot)) {
    target.set(key, record)
  }
}

function withoutLease(record: ConnectorAuthorizationRecord): ConnectorAuthorizationRecord {
  const { refreshLeaseOwner: _owner, refreshLeaseExpiresAt: _expiresAt, ...rest } = record
  return rest
}

function withoutFailure(record: ConnectorAuthorizationRecord): ConnectorAuthorizationRecord {
  const { failure: _failure, ...rest } = record
  return rest
}

function attemptInvalid(
  params: { readonly projectId: string; readonly id: string },
  reason: string
) {
  return createSixbError(
    "connector.authorization_attempt_invalid",
    "[Sixb] Connector authorization attempt is not usable.",
    { details: { projectId: params.projectId, attemptId: params.id, reason } }
  )
}
