import { timingSafeEqual } from "node:crypto"
import { ConnectorConnectionStorageError } from "./errors"
import type {
  ClaimConnectorRefreshLeaseInput,
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
  CreateConnectorAuthorizationAttemptInput,
  CreateConnectorAuthorizationInput,
  DisconnectConnectorConnectionInput,
  GetConnectorConnectionInput,
  MarkConnectorAuthorizationInput,
  PutConnectorConnectionInput,
  PutConnectorConnectionResult,
  ReauthorizeConnectorAuthorizationInput,
  ReleaseConnectorRefreshLeaseInput,
  RevokeConnectorAuthorizationInput,
  RevokeConnectorAuthorizationResult,
  UpdateConnectorAuthorizationCredentialsInput,
} from "./types"

export interface InMemoryConnectorConnectionStorageSnapshot {
  readonly attempts: Map<string, ConnectorAuthorizationAttemptRecord>
  readonly authorizations: Map<string, ConnectorAuthorizationRecord>
  readonly connections: Map<string, ConnectorConnectionRecord>
}

export interface InMemoryConnectorConnectionStorageOptions {
  /** Storage-authoritative clock. Durable implementations should use their database clock. */
  readonly now?: () => Date
}

export class InMemoryConnectorConnectionStorage implements ConnectorConnectionStorage {
  readonly durability = "ephemeral" as const
  private readonly attempts = new Map<string, ConnectorAuthorizationAttemptRecord>()
  private readonly authorizations = new Map<string, ConnectorAuthorizationRecord>()
  private readonly connections = new Map<string, ConnectorConnectionRecord>()

  constructor(private readonly options: InMemoryConnectorConnectionStorageOptions = {}) {}

  async createAuthorizationAttempt(
    input: CreateConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    if (this.attempts.has(input.id)) {
      throw new ConnectorConnectionStorageError(
        "attempt_conflict",
        "[Sixb] Connector authorization attempt already exists."
      )
    }
    const record = snapshotAttempt(input)
    this.attempts.set(record.id, record)
    return structuredClone(record)
  }

  async consumeAuthorizationAttempt(
    input: Parameters<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>[0]
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    const record = this.attempts.get(input.id)
    if (record && record.expiresAt.getTime() <= input.now.getTime()) {
      this.attempts.delete(record.id)
      throw new ConnectorConnectionStorageError(
        "attempt_invalid",
        "[Sixb] Connector authorization attempt is invalid, expired, or already used."
      )
    }
    if (
      !record ||
      record.projectId !== input.projectId ||
      record.connectorId !== input.connectorId ||
      record.redirectUri !== input.redirectUri ||
      !samePrincipal(record.authorizedBy, input.authorizedBy) ||
      !sameCredential(record.credential, input.credential) ||
      !safeEqual(record.stateHash, input.stateHash)
    ) {
      throw new ConnectorConnectionStorageError(
        "attempt_invalid",
        "[Sixb] Connector authorization attempt is invalid, expired, or already used."
      )
    }

    this.attempts.delete(input.id)
    return structuredClone(record)
  }

  async createAuthorization(
    input: CreateConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    if (this.authorizations.has(input.id)) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector authorization already exists."
      )
    }
    const record: ConnectorAuthorizationRecord = {
      ...structuredClone(input),
      scopes: [...input.scopes],
      accounts: structuredClone(input.accounts),
      status: "active",
      revision: 0,
      updatedAt: new Date(input.createdAt),
    }
    this.authorizations.set(record.id, record)
    return structuredClone(record)
  }

  async getAuthorization(authorizationId: string): Promise<ConnectorAuthorizationRecord | null> {
    return cloneOrNull(this.authorizations.get(authorizationId))
  }

  async claimRefreshLease(
    input: ClaimConnectorRefreshLeaseInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
      throw new ConnectorConnectionStorageError(
        "invalid_input",
        "[Sixb] Connector refresh lease duration must be positive."
      )
    }
    const now = this.options.now?.() ?? new Date()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !record ||
      record.status !== "active" ||
      record.revision !== input.expectedRevision ||
      (record.refreshLease && record.refreshLease.expiresAt.getTime() > now.getTime())
    ) {
      return null
    }
    const updated = {
      ...record,
      refreshLease: {
        ...structuredClone(input.lease),
        expiresAt: new Date(now.getTime() + input.durationMs),
      },
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async updateAuthorizationCredentials(
    input: UpdateConnectorAuthorizationCredentialsInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !record ||
      record.status !== "active" ||
      record.revision !== input.expectedRevision ||
      record.refreshLease?.id !== input.leaseId
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentials: structuredClone(input.credentials),
      ...(input.credentialExpiresAt === undefined
        ? { credentialExpiresAt: undefined }
        : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
      scopes: [...input.scopes],
      revision: record.revision + 1,
      refreshLease: undefined,
      updatedAt: new Date(input.updatedAt),
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async reauthorizeAuthorization(
    input: ReauthorizeConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (!record || record.revision !== input.expectedRevision || record.status === "revoked") {
      return null
    }
    const accountsById = new Map(input.accounts.map((account) => [account.id, account]))
    const attached = [...this.connections.values()].filter(
      (connection) => connection.authorizationId === record.id
    )
    if (
      !sameIds(
        attached.map((connection) => connection.id),
        input.expectedConnectionIds
      )
    ) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connections attached to the connector authorization changed during reauthorization."
      )
    }
    if (attached.some((connection) => !accountsById.has(connection.account.id))) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Reauthorized connector grant no longer exposes every attached account."
      )
    }

    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentials: structuredClone(input.credentials),
      ...(input.credentialExpiresAt === undefined
        ? { credentialExpiresAt: undefined }
        : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
      scopes: [...input.scopes],
      accounts: structuredClone(input.accounts),
      status: "active",
      revision: record.revision + 1,
      refreshLease: undefined,
      updatedAt: new Date(input.updatedAt),
    }
    this.authorizations.set(record.id, updated)
    for (const connection of attached) {
      this.connections.set(connection.id, {
        ...connection,
        account: structuredClone(accountsById.get(connection.account.id)!),
        updatedAt: new Date(input.updatedAt),
      })
    }
    return structuredClone(updated)
  }

  async releaseRefreshLease(input: ReleaseConnectorRefreshLeaseInput): Promise<boolean> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !record ||
      record.revision !== input.expectedRevision ||
      record.refreshLease?.id !== input.leaseId
    ) {
      return false
    }
    this.authorizations.set(record.id, {
      ...record,
      refreshLease: undefined,
      updatedAt: new Date(input.updatedAt),
    })
    return true
  }

  async markNeedsReauthorization(
    input: MarkConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !record ||
      record.revision !== input.expectedRevision ||
      record.status !== "active" ||
      (input.leaseId !== undefined && record.refreshLease?.id !== input.leaseId)
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      status: "needs_reauthorization",
      revision: record.revision + 1,
      refreshLease: undefined,
      updatedAt: new Date(input.updatedAt),
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async putConnection(input: PutConnectorConnectionInput): Promise<PutConnectorConnectionResult> {
    const authorization = this.authorizations.get(input.authorizationId)
    if (
      !authorization ||
      authorization.projectId !== input.projectId ||
      authorization.connectorId !== input.connectorId ||
      authorization.status !== "active"
    ) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector connection requires an active authorization from the same project and connector."
      )
    }
    const account = authorization.accounts.find((candidate) => candidate.id === input.account.id)
    if (!account) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector connection account is not exposed by its authorization."
      )
    }
    const existing = this.findConnection(input)
    if (!existing) {
      if (this.connections.has(input.id)) {
        throw new ConnectorConnectionStorageError(
          "connection_conflict",
          "[Sixb] Connector connection id already exists."
        )
      }
      const connection: ConnectorConnectionRecord = {
        id: input.id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        owner: structuredClone(input.owner),
        slot: input.slot,
        authorizationId: input.authorizationId,
        account: structuredClone(account),
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      }
      this.connections.set(connection.id, connection)
      return { connection: structuredClone(connection), created: true, replaced: false }
    }

    const sameAccount = existing.account.id === account.id
    if (!sameAccount && !input.replace) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        `[Sixb] Connector slot '${input.slot}' is already connected to another account; explicit replacement is required.`
      )
    }
    const connection: ConnectorConnectionRecord = {
      ...existing,
      authorizationId: input.authorizationId,
      account: structuredClone(account),
      updatedAt: new Date(input.now),
    }
    this.connections.set(connection.id, connection)
    return {
      connection: structuredClone(connection),
      created: false,
      replaced: !sameAccount,
    }
  }

  async getConnection(
    input: GetConnectorConnectionInput
  ): Promise<ConnectorConnectionRecord | null> {
    return cloneOrNull(this.findConnection(input))
  }

  async getConnectionById(connectionId: string): Promise<ConnectorConnectionRecord | null> {
    return cloneOrNull(this.connections.get(connectionId))
  }

  async listConnectionsByAuthorization(
    authorizationId: string
  ): Promise<readonly ConnectorConnectionRecord[]> {
    return [...this.connections.values()]
      .filter((connection) => connection.authorizationId === authorizationId)
      .map((connection) => structuredClone(connection))
  }

  async disconnectConnection(
    input: DisconnectConnectorConnectionInput
  ): Promise<ConnectorConnectionRecord | null> {
    const connection = this.connections.get(input.connectionId)
    if (
      !connection ||
      connection.projectId !== input.projectId ||
      connection.connectorId !== input.connectorId
    ) {
      return null
    }
    this.connections.delete(connection.id)
    return structuredClone(connection)
  }

  async revokeAuthorization(
    input: RevokeConnectorAuthorizationInput
  ): Promise<RevokeConnectorAuthorizationResult | null> {
    const authorization = this.authorizations.get(input.authorizationId)
    if (
      !authorization ||
      authorization.projectId !== input.projectId ||
      authorization.connectorId !== input.connectorId ||
      authorization.revision !== input.expectedRevision ||
      authorization.status === "revoked"
    ) {
      return null
    }
    const revoked: ConnectorAuthorizationRecord = {
      ...authorization,
      status: "revoked",
      revision: authorization.revision + 1,
      refreshLease: undefined,
      updatedAt: new Date(input.revokedAt),
    }
    this.authorizations.set(revoked.id, revoked)
    const disconnected: ConnectorConnectionRecord[] = []
    for (const connection of this.connections.values()) {
      if (connection.authorizationId !== revoked.id) continue
      disconnected.push(structuredClone(connection))
      this.connections.delete(connection.id)
    }
    return { authorization: structuredClone(revoked), disconnected }
  }

  snapshot(): InMemoryConnectorConnectionStorageSnapshot {
    return {
      attempts: structuredClone(this.attempts),
      authorizations: structuredClone(this.authorizations),
      connections: structuredClone(this.connections),
    }
  }

  restore(snapshot: InMemoryConnectorConnectionStorageSnapshot): void {
    replaceMap(this.attempts, snapshot.attempts)
    replaceMap(this.authorizations, snapshot.authorizations)
    replaceMap(this.connections, snapshot.connections)
  }

  private findConnection(
    input: GetConnectorConnectionInput
  ): ConnectorConnectionRecord | undefined {
    for (const connection of this.connections.values()) {
      if (
        connection.projectId === input.projectId &&
        connection.connectorId === input.connectorId &&
        connection.owner.type === input.owner.type &&
        connection.slot === input.slot
      ) {
        return connection
      }
    }
    return undefined
  }
}

function snapshotAttempt(
  input: CreateConnectorAuthorizationAttemptInput
): ConnectorAuthorizationAttemptRecord {
  return structuredClone(input)
}

function samePrincipal(
  left: ConnectorAuthorizationAttemptRecord["authorizedBy"],
  right: ConnectorAuthorizationAttemptRecord["authorizedBy"]
): boolean {
  return left.type === right.type && left.id === right.id
}

function sameCredential(
  left: ConnectorAuthorizationAttemptRecord["credential"],
  right: ConnectorAuthorizationAttemptRecord["credential"]
): boolean {
  return left.type === right.type && left.id === right.id
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value)
}

function replaceMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear()
  for (const [key, value] of structuredClone(source)) target.set(key, value)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  )
}
