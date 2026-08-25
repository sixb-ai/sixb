import { timingSafeEqual } from "node:crypto"
import { ConnectorConnectionStorageError } from "./errors"
import type {
  ClaimConnectorCredentialMutationInput,
  ClaimConnectorCredentialMutationResult,
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationKey,
  ConnectorAuthorizationRecord,
  ConnectorConnectionKey,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
  ConnectorCredentialMutationFence,
  CreateConnectorAuthorizationAttemptInput,
  CreateConnectorAuthorizationInput,
  FinalizeConnectorReauthorizationInput,
  GetConnectorConnectionInput,
  InitializeConnectorAuthorizationAccountsInput,
  MarkConnectorAuthorizationNeedsReauthorizationInput,
  MarkConnectorCredentialMutationExecutingInput,
  PutConnectorConnectionInput,
  PutConnectorConnectionResult,
  RecoverExpiredConnectorCredentialMutationInput,
  ReleaseConnectorCredentialMutationInput,
  RenewConnectorCredentialMutationInput,
  StageConnectorCredentialMutationCredentialsInput,
  StageConnectorCredentialMutationRevocationInput,
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
    assertPositiveDuration(input.ttlMs, "authorization attempt TTL")
    if (this.attempts.has(input.id)) {
      throw new ConnectorConnectionStorageError(
        "attempt_conflict",
        "[Sixb] Connector authorization attempt already exists."
      )
    }
    const now = this.now()
    const record: ConnectorAuthorizationAttemptRecord = {
      id: input.id,
      projectId: input.projectId,
      connectorId: input.connectorId,
      owner: structuredClone(input.owner),
      slot: input.slot,
      initiatedByExecutionId: input.initiatedByExecutionId,
      stateHash: input.stateHash,
      codeVerifier: structuredClone(input.codeVerifier),
      redirectUri: input.redirectUri,
      ...(input.reauthorizationId === undefined
        ? {}
        : { reauthorizationId: input.reauthorizationId }),
      ...(input.reauthorizationRevision === undefined
        ? {}
        : { reauthorizationRevision: input.reauthorizationRevision }),
      ...(input.reauthorizationConnectionIds === undefined
        ? {}
        : { reauthorizationConnectionIds: [...input.reauthorizationConnectionIds] }),
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
    }
    this.attempts.set(record.id, record)
    return structuredClone(record)
  }

  async consumeAuthorizationAttempt(
    input: Parameters<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>[0]
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    const record = this.attempts.get(input.id)
    if (record && record.expiresAt.getTime() <= this.now().getTime()) {
      this.attempts.delete(record.id)
      throw invalidAttempt()
    }
    if (
      !record ||
      record.projectId !== input.projectId ||
      record.connectorId !== input.connectorId ||
      record.redirectUri !== input.redirectUri ||
      !safeEqual(record.stateHash, input.stateHash)
    ) {
      throw invalidAttempt()
    }

    this.attempts.delete(input.id)
    return structuredClone(record)
  }

  async createAuthorization(
    input: CreateConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    assertPositiveDuration(input.selectionTtlMs, "account selection TTL")
    if (this.authorizations.has(input.id)) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector authorization already exists."
      )
    }
    const now = this.now()
    const record: ConnectorAuthorizationRecord = {
      id: input.id,
      projectId: input.projectId,
      connectorId: input.connectorId,
      authorizedBy: structuredClone(input.authorizedBy),
      credentials: structuredClone(input.credentials),
      ...(input.credentialExpiresAt === undefined
        ? {}
        : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
      scopes: [...input.scopes],
      accounts: structuredClone(input.accounts),
      status: "pending_selection",
      selectionExpiresAt: new Date(now.getTime() + input.selectionTtlMs),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.authorizations.set(record.id, record)
    return structuredClone(record)
  }

  async initializeAuthorizationAccounts(
    input: InitializeConnectorAuthorizationAccountsInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !sameAuthorizationScope(record, input) ||
      record.revision !== input.expectedRevision ||
      record.status !== "pending_selection" ||
      record.credentialMutation
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      accounts: structuredClone(input.accounts),
      revision: record.revision + 1,
      updatedAt: this.now(),
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async getAuthorization(
    input: ConnectorAuthorizationKey
  ): Promise<ConnectorAuthorizationRecord | null> {
    const authorization = this.authorizations.get(input.authorizationId)
    return sameAuthorizationScope(authorization, input) ? structuredClone(authorization) : null
  }

  async claimCredentialMutation(
    input: ClaimConnectorCredentialMutationInput
  ): Promise<ClaimConnectorCredentialMutationResult | null> {
    assertPositiveDuration(input.leaseDurationMs, "credential mutation lease duration")
    assertPositiveDuration(input.operationTimeoutMs, "credential mutation timeout")
    const now = this.now()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !sameAuthorizationScope(record, input) ||
      record.revision !== input.expectedRevision ||
      !canClaimMutation(record.status, input.mutation.kind)
    ) {
      return null
    }

    if (record.credentialMutation) {
      const canReplacePrepared =
        record.credentialMutation.phase === "prepared" &&
        record.credentialMutation.expiresAt.getTime() <= now.getTime()
      if (!canReplacePrepared) return null
    }

    const attached = this.connectedConnectionsForAuthorization(record.id)
    if (
      input.mutation.kind === "reauthorization" &&
      !sameIds(
        attached.map((connection) => connection.id),
        input.expectedConnectionIds ?? []
      )
    ) {
      return null
    }

    const deadlineAt = new Date(now.getTime() + input.operationTimeoutMs)
    const mutation = {
      ...structuredClone(input.mutation),
      phase: "prepared" as const,
      expiresAt: leaseExpiry(now, input.leaseDurationMs, deadlineAt),
      deadlineAt,
      ...(input.mutation.kind === "reauthorization"
        ? { expectedConnectionIds: [...(input.expectedConnectionIds ?? [])] }
        : {}),
    }
    const startsRevocation =
      input.mutation.kind === "revocation" && record.status !== "revocation_pending"
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      status: input.mutation.kind === "revocation" ? "revocation_pending" : record.status,
      selectionExpiresAt:
        input.mutation.kind === "revocation" ? undefined : record.selectionExpiresAt,
      revision: startsRevocation ? record.revision + 1 : record.revision,
      credentialMutation: mutation,
      updatedAt: now,
    }
    this.authorizations.set(record.id, updated)

    const disconnected: ConnectorConnectionRecord[] = []
    if (input.mutation.kind === "revocation") {
      for (const connection of attached) {
        const updated = disconnectConnectionRecord(connection, now)
        this.connections.set(connection.id, updated)
        disconnected.push(structuredClone(updated))
      }
    }
    return { authorization: structuredClone(updated), disconnected }
  }

  async markCredentialMutationExecuting(
    input: MarkConnectorCredentialMutationExecutingInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const now = this.now()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input, input.holderId) ||
      record.credentialMutation.phase !== "prepared" ||
      mutationExpired(record, now)
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentialMutation: { ...record.credentialMutation, phase: "executing" },
      updatedAt: now,
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async renewCredentialMutation(
    input: RenewConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    assertPositiveDuration(input.leaseDurationMs, "credential mutation lease duration")
    const now = this.now()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input, input.holderId) ||
      record.credentialMutation.phase === "result_staged" ||
      mutationExpired(record, now)
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentialMutation: {
        ...record.credentialMutation,
        expiresAt: leaseExpiry(now, input.leaseDurationMs, record.credentialMutation.deadlineAt),
      },
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async stageCredentialMutationCredentials(
    input: StageConnectorCredentialMutationCredentialsInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const now = this.now()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input, input.holderId) ||
      record.credentialMutation.phase !== "executing" ||
      mutationExpired(record, now) ||
      record.credentialMutation.kind === "revocation"
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentialMutation: {
        ...record.credentialMutation,
        phase: "result_staged",
        stagedCredentials: {
          credentials: structuredClone(input.credentials),
          ...(input.credentialExpiresAt === undefined
            ? {}
            : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
          scopes: [...input.scopes],
        },
      },
      updatedAt: now,
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async stageCredentialMutationRevocation(
    input: StageConnectorCredentialMutationRevocationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const now = this.now()
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input, input.holderId) ||
      record.credentialMutation.phase !== "executing" ||
      record.credentialMutation.kind !== "revocation" ||
      mutationExpired(record, now)
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      credentialMutation: { ...record.credentialMutation, phase: "result_staged" },
      updatedAt: now,
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async releaseCredentialMutation(
    input: ReleaseConnectorCredentialMutationInput
  ): Promise<boolean> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input, input.holderId) ||
      record.credentialMutation.phase === "result_staged"
    ) {
      return false
    }
    this.authorizations.set(record.id, {
      ...record,
      credentialMutation: undefined,
      updatedAt: this.now(),
    })
    return true
  }

  async recoverExpiredCredentialMutation(
    input: RecoverExpiredConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (!sameAuthorizationScope(record, input) || !record.credentialMutation) return null
    if (record.credentialMutation.phase === "result_staged") return structuredClone(record)

    const now = this.now()
    if (!mutationExpired(record, now)) return null
    const ambiguous = record.credentialMutation.phase === "executing"
    const failClosed = ambiguous && record.credentialMutation.kind !== "revocation"
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      status: failClosed ? "needs_reauthorization" : record.status,
      selectionExpiresAt: failClosed ? undefined : record.selectionExpiresAt,
      revision: failClosed ? record.revision + 1 : record.revision,
      credentialMutation: undefined,
      updatedAt: now,
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async markNeedsReauthorization(
    input: MarkConnectorAuthorizationNeedsReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (!matchesMutation(record, input)) return null
    const staged = record.credentialMutation.stagedCredentials
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      ...(staged
        ? {
            credentials: structuredClone(staged.credentials),
            credentialExpiresAt:
              staged.credentialExpiresAt === undefined
                ? undefined
                : new Date(staged.credentialExpiresAt),
            scopes: [...staged.scopes],
          }
        : {}),
      status: "needs_reauthorization",
      selectionExpiresAt: undefined,
      revision: record.revision + 1,
      credentialMutation: undefined,
      updatedAt: this.now(),
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async finalizeRefresh(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    const staged = stagedCredentials(record, input, "refresh")
    if (!record || !staged) return null
    const updated = applyStagedCredentials(record, staged, this.now(), {
      status: "active",
      accounts: record.accounts,
    })
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async finalizeReauthorization(
    input: FinalizeConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    const staged = stagedCredentials(record, input, "reauthorization")
    if (!record || !staged || !record.credentialMutation) return null
    const attached = this.connectedConnectionsForAuthorization(record.id)
    if (
      !sameIds(
        attached.map((connection) => connection.id),
        record.credentialMutation.expectedConnectionIds ?? []
      )
    ) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connections attached to the connector authorization changed during reauthorization."
      )
    }
    const accountsById = new Map(input.accounts.map((account) => [account.id, account]))
    if (attached.some((connection) => !accountsById.has(connection.account.id))) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Reauthorized connector grant no longer exposes every attached account."
      )
    }

    const now = this.now()
    const updated = applyStagedCredentials(record, staged, now, {
      status: "active",
      accounts: input.accounts,
    })
    this.authorizations.set(record.id, updated)
    for (const connection of attached) {
      this.connections.set(connection.id, {
        ...connection,
        account: structuredClone(accountsById.get(connection.account.id)!),
        updatedAt: now,
      })
    }
    return structuredClone(updated)
  }

  async finalizeRevocation(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null> {
    const record = this.authorizations.get(input.authorizationId)
    if (
      !matchesMutation(record, input) ||
      record.credentialMutation.kind !== "revocation" ||
      record.credentialMutation.phase !== "result_staged"
    ) {
      return null
    }
    const updated: ConnectorAuthorizationRecord = {
      ...record,
      status: "revoked",
      credentials: undefined,
      credentialExpiresAt: undefined,
      scopes: [],
      accounts: [],
      selectionExpiresAt: undefined,
      revision: record.revision + 1,
      credentialMutation: undefined,
      updatedAt: this.now(),
    }
    this.authorizations.set(record.id, updated)
    return structuredClone(updated)
  }

  async putConnection(input: PutConnectorConnectionInput): Promise<PutConnectorConnectionResult> {
    const now = this.now()
    let authorization = this.authorizations.get(input.authorizationId)
    if (
      !sameAuthorizationScope(authorization, input) ||
      !isSelectable(authorization.status) ||
      authorization.credentialMutation?.kind === "reauthorization"
    ) {
      throw authorizationConflict()
    }
    if (
      authorization.status === "pending_selection" &&
      authorization.selectionExpiresAt!.getTime() <= now.getTime()
    ) {
      authorization = {
        ...authorization,
        status: "revocation_pending",
        selectionExpiresAt: undefined,
        revision: authorization.revision + 1,
        updatedAt: now,
      }
      this.authorizations.set(authorization.id, authorization)
      throw authorizationConflict()
    }
    const account = authorization.accounts.find((candidate) => candidate.id === input.account.id)
    if (!account) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector connection account is not exposed by its authorization."
      )
    }
    const existing = this.findConnectionRecord(input)
    const sameAccount = existing?.account.id === account.id
    if (existing && !sameAccount && !input.replace) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        `[Sixb] Connector slot '${input.slot}' is already connected to another account; explicit replacement is required.`
      )
    }
    if (!existing && this.connections.has(input.id)) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        "[Sixb] Connector connection id already exists."
      )
    }

    let revocationPendingAuthorizationId: string | undefined
    if (existing?.status === "connected" && existing.authorizationId !== authorization.id) {
      const previous = this.authorizations.get(existing.authorizationId)
      if (!previous) {
        throw new ConnectorConnectionStorageError(
          "authorization_conflict",
          "[Sixb] Existing connector connection references an unavailable authorization."
        )
      }
      const remaining = this.connectedConnectionsForAuthorization(previous.id).filter(
        (connection) => connection.id !== existing.id
      )
      this.assertConnectionCanMove(existing, previous, remaining.length === 0)
      if (remaining.length === 0) {
        const pending = markAuthorizationRevocationPending(previous, now)
        this.authorizations.set(previous.id, pending)
        revocationPendingAuthorizationId = previous.id
      }
    } else if (existing?.status === "connected") {
      const previous = this.authorizations.get(existing.authorizationId)
      if (previous) this.assertConnectionCanMove(existing, previous, false)
    }

    const updatedAuthorization: ConnectorAuthorizationRecord =
      authorization.status === "pending_selection"
        ? {
            ...authorization,
            status: "active",
            selectionExpiresAt: undefined,
            revision: authorization.revision + 1,
            updatedAt: now,
          }
        : authorization
    const connection: ConnectorConnectionRecord = existing
      ? {
          ...existing,
          authorizationId: input.authorizationId,
          account: structuredClone(account),
          status: "connected",
          disconnectedAt: undefined,
          updatedAt: now,
        }
      : {
          id: input.id,
          projectId: input.projectId,
          connectorId: input.connectorId,
          owner: structuredClone(input.owner),
          slot: input.slot,
          authorizationId: input.authorizationId,
          account: structuredClone(account),
          status: "connected",
          createdAt: now,
          updatedAt: now,
        }

    if (updatedAuthorization !== authorization) {
      this.authorizations.set(updatedAuthorization.id, updatedAuthorization)
    }
    this.connections.set(connection.id, connection)
    return {
      connection: structuredClone(connection),
      authorization: structuredClone(updatedAuthorization),
      ...(revocationPendingAuthorizationId === undefined
        ? {}
        : { revocationPendingAuthorizationId }),
      created: existing === undefined,
      replaced: existing !== undefined && !sameAccount,
    }
  }

  async getConnection(
    input: GetConnectorConnectionInput
  ): Promise<ConnectorConnectionRecord | null> {
    const connection = this.findConnectionRecord(input)
    return connection?.status === "connected" ? structuredClone(connection) : null
  }

  async getConnectionById(
    input: ConnectorConnectionKey
  ): Promise<ConnectorConnectionRecord | null> {
    const connection = this.connections.get(input.connectionId)
    return sameConnectionScope(connection, input) ? structuredClone(connection) : null
  }

  async listConnections(input: {
    readonly projectId: string
    readonly connectorId: string
  }): Promise<readonly ConnectorConnectionRecord[]> {
    return [...this.connections.values()]
      .filter((connection) => sameConnectionScope(connection, input))
      .map((connection) => structuredClone(connection))
  }

  async getAuthorizationByConnectionId(
    input: ConnectorConnectionKey
  ): Promise<ConnectorAuthorizationRecord | null> {
    const connection = this.connections.get(input.connectionId)
    if (!sameConnectionScope(connection, input)) return null
    const authorization = this.authorizations.get(connection.authorizationId)
    return sameAuthorizationScope(authorization, input) ? structuredClone(authorization) : null
  }

  async listConnectionsByAuthorization(
    input: ConnectorAuthorizationKey
  ): Promise<readonly ConnectorConnectionRecord[]> {
    const authorization = this.authorizations.get(input.authorizationId)
    if (!sameAuthorizationScope(authorization, input)) return []
    return this.connectedConnectionsForAuthorization(input.authorizationId)
      .filter((connection) => sameConnectionScope(connection, input))
      .map((connection) => structuredClone(connection))
  }

  async disconnectConnection(input: ConnectorConnectionKey): Promise<{
    readonly connection: ConnectorConnectionRecord
    readonly authorization: ConnectorAuthorizationRecord
    readonly revocationPendingAuthorizationId?: string
  } | null> {
    const connection = this.connections.get(input.connectionId)
    if (
      !connection ||
      connection.projectId !== input.projectId ||
      connection.connectorId !== input.connectorId
    ) {
      return null
    }
    const authorization = this.authorizations.get(connection.authorizationId)
    if (!sameAuthorizationScope(authorization, input)) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector connection references an unavailable authorization."
      )
    }
    if (connection.status === "disconnected") {
      return {
        connection: structuredClone(connection),
        authorization: structuredClone(authorization),
        ...(authorization.status === "revocation_pending"
          ? { revocationPendingAuthorizationId: authorization.id }
          : {}),
      }
    }

    const now = this.now()
    const remaining = this.connectedConnectionsForAuthorization(authorization.id).filter(
      (candidate) => candidate.id !== connection.id
    )
    this.assertConnectionCanMove(connection, authorization, remaining.length === 0)
    const disconnected = disconnectConnectionRecord(connection, now)
    this.connections.set(connection.id, disconnected)

    const updatedAuthorization =
      remaining.length === 0
        ? markAuthorizationRevocationPending(authorization, now)
        : authorization
    if (updatedAuthorization !== authorization) {
      this.authorizations.set(authorization.id, updatedAuthorization)
    }
    return {
      connection: structuredClone(disconnected),
      authorization: structuredClone(updatedAuthorization),
      ...(updatedAuthorization.status === "revocation_pending" && remaining.length === 0
        ? { revocationPendingAuthorizationId: updatedAuthorization.id }
        : {}),
    }
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

  private now(): Date {
    return new Date(this.options.now?.() ?? new Date())
  }

  private findConnectionRecord(
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

  private connectionRecordsForAuthorization(authorizationId: string): ConnectorConnectionRecord[] {
    return [...this.connections.values()].filter(
      (connection) => connection.authorizationId === authorizationId
    )
  }

  private connectedConnectionsForAuthorization(
    authorizationId: string
  ): ConnectorConnectionRecord[] {
    return this.connectionRecordsForAuthorization(authorizationId).filter(
      (connection) => connection.status === "connected"
    )
  }

  private assertConnectionCanMove(
    _connection: ConnectorConnectionRecord,
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
}

function disconnectConnectionRecord(
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

function markAuthorizationRevocationPending(
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

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
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

function invalidAttempt(): ConnectorConnectionStorageError {
  return new ConnectorConnectionStorageError(
    "attempt_invalid",
    "[Sixb] Connector authorization attempt is invalid, expired, or already used."
  )
}

function authorizationConflict(): ConnectorConnectionStorageError {
  return new ConnectorConnectionStorageError(
    "authorization_conflict",
    "[Sixb] Connector connection requires a selectable authorization from the same project and connector."
  )
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConnectorConnectionStorageError(
      "invalid_input",
      `[Sixb] Connector ${name} must be positive.`
    )
  }
}

function sameAuthorizationScope(
  record: ConnectorAuthorizationRecord | undefined,
  input: { readonly projectId: string; readonly connectorId: string }
): record is ConnectorAuthorizationRecord {
  return (
    record !== undefined &&
    record.projectId === input.projectId &&
    record.connectorId === input.connectorId
  )
}

function sameConnectionScope(
  record: ConnectorConnectionRecord | undefined,
  input: { readonly projectId: string; readonly connectorId: string }
): record is ConnectorConnectionRecord {
  return (
    record !== undefined &&
    record.projectId === input.projectId &&
    record.connectorId === input.connectorId
  )
}

function canClaimMutation(
  status: ConnectorAuthorizationRecord["status"],
  kind: ClaimConnectorCredentialMutationInput["mutation"]["kind"]
): boolean {
  if (kind === "refresh") return status === "active"
  if (kind === "reauthorization") {
    return status === "active" || status === "needs_reauthorization"
  }
  return status !== "revoked"
}

function isSelectable(status: ConnectorAuthorizationRecord["status"]): boolean {
  return status === "pending_selection" || status === "active"
}

function leaseExpiry(now: Date, durationMs: number, deadlineAt: Date): Date {
  return new Date(Math.min(now.getTime() + durationMs, deadlineAt.getTime()))
}

function mutationExpired(record: ConnectorAuthorizationRecord, now: Date): boolean {
  return (
    record.credentialMutation!.expiresAt.getTime() <= now.getTime() ||
    record.credentialMutation!.deadlineAt.getTime() <= now.getTime()
  )
}

function matchesMutation(
  record: ConnectorAuthorizationRecord | undefined,
  input: ConnectorCredentialMutationFence,
  holderId?: string
): record is ConnectorAuthorizationRecord & {
  readonly credentialMutation: NonNullable<ConnectorAuthorizationRecord["credentialMutation"]>
} {
  return (
    sameAuthorizationScope(record, input) &&
    record.revision === input.expectedRevision &&
    record.credentialMutation?.id === input.mutationId &&
    (holderId === undefined || record.credentialMutation.holderId === holderId)
  )
}

function stagedCredentials(
  record: ConnectorAuthorizationRecord | undefined,
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

function applyStagedCredentials(
  record: ConnectorAuthorizationRecord,
  staged: NonNullable<ReturnType<typeof stagedCredentials>>,
  now: Date,
  input: {
    readonly status: "active"
    readonly accounts: readonly ConnectorAuthorizationRecord["accounts"][number][]
  }
): ConnectorAuthorizationRecord {
  return {
    ...record,
    credentials: structuredClone(staged.credentials),
    credentialExpiresAt:
      staged.credentialExpiresAt === undefined ? undefined : new Date(staged.credentialExpiresAt),
    scopes: [...staged.scopes],
    accounts: structuredClone(input.accounts),
    status: input.status,
    selectionExpiresAt: undefined,
    revision: record.revision + 1,
    credentialMutation: undefined,
    updatedAt: now,
  }
}
