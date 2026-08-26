import {
  type ConnectorConnectionPersistence,
  type ConnectorConnectionPersistenceBackend,
  type ConnectorConnectionPersistenceScope,
  DurableConnectorConnectionStorage,
} from "@sixb/core/internal/connector-connection-storage-provider"
import type {
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionRunRecord,
  ConnectorCredentialMutation,
  ConnectorStagedCredentials,
} from "@sixb/core/storage"
import type { SQLClient } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

export class PgConnectorConnectionStorage extends DurableConnectorConnectionStorage {
  private readonly clock: ConnectorConnectionTestClock

  constructor(sql: PgStoreClient) {
    const clock = { offsetMs: 0 }
    super(new PgConnectorConnectionPersistenceBackend(sql, clock))
    this.clock = clock
  }

  /** Internal deterministic clock control used only by the provider contract suite. */
  advanceTimeForTesting(durationMs: number): void {
    this.clock.offsetMs += durationMs
  }
}

class PgConnectorConnectionPersistenceBackend implements ConnectorConnectionPersistenceBackend {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly clock: ConnectorConnectionTestClock
  ) {}

  read<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return run(new PgConnectorConnectionPersistence(this.sql, scope, false, this.clock))
  }

  transaction<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return runPgTransaction(this.sql, async (tx) => {
      if (scope.connectorId) {
        await lockAdvisoryKeys(tx, [
          ["connector-connections", scope.projectId, scope.connectorId].join(":"),
        ])
      }
      return run(new PgConnectorConnectionPersistence(tx, scope, true, this.clock))
    })
  }
}

class PgConnectorConnectionPersistence implements ConnectorConnectionPersistence {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly scope: ConnectorConnectionPersistenceScope,
    private readonly locking: boolean,
    private readonly clock: ConnectorConnectionTestClock
  ) {}

  async now(): Promise<Date> {
    const [row] = await this.sql<{ readonly now: Date | string }[]>`
      SELECT clock_timestamp() AS now
    `
    if (!row) throw new Error("[SixbPg] Database clock returned no row.")
    return new Date(new Date(row.now).getTime() + this.clock.offsetMs)
  }

  async insertAuthorizationAttempt(record: ConnectorAuthorizationAttemptRecord): Promise<boolean> {
    try {
      await this.sql`
        INSERT INTO connector_authorization_attempts (
          project_id, connector_id, id, slot, initiated_by_execution_id,
          state_hash, code_verifier, redirect_uri, connection_run_id, return_to,
          callback_binding_hash, reauthorization_id, reauthorization_revision,
          reauthorization_connection_ids, created_at, expires_at
        ) VALUES (
          ${record.projectId}, ${record.connectorId}, ${record.id}, ${record.slot},
          ${record.initiatedByExecutionId}, ${record.stateHash},
          ${jsonParameter(this.sql, record.codeVerifier)}, ${record.redirectUri},
          ${record.connectionRunId ?? null}, ${record.returnTo ?? null},
          ${record.callbackBindingHash ?? null}, ${record.reauthorizationId ?? null},
          ${record.reauthorizationRevision ?? null},
          ${
            record.reauthorizationConnectionIds
              ? jsonParameter(this.sql, record.reauthorizationConnectionIds)
              : null
          },
          ${record.createdAt}, ${record.expiresAt}
        )
      `
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async getAuthorizationAttempt(id: string): Promise<ConnectorAuthorizationAttemptRecord | null> {
    const rows = this.scope.connectorId
      ? await this.sql<PgAuthorizationAttemptRow[]>`
          SELECT * FROM connector_authorization_attempts
          WHERE project_id = ${this.scope.projectId}
            AND connector_id = ${this.scope.connectorId}
            AND id = ${id}
          ${this.lockClause()}
        `
      : await this.sql<PgAuthorizationAttemptRow[]>`
          SELECT * FROM connector_authorization_attempts
          WHERE project_id = ${this.scope.projectId} AND id = ${id}
          ${this.lockClause()}
        `
    return rows[0] ? authorizationAttemptFromRow(rows[0]) : null
  }

  async getAuthorizationAttemptByConnectionRunId(
    connectionRunId: string
  ): Promise<ConnectorAuthorizationAttemptRecord | null> {
    if (!this.scope.connectorId) return null
    const rows = await this.sql<PgAuthorizationAttemptRow[]>`
      SELECT * FROM connector_authorization_attempts
      WHERE project_id = ${this.scope.projectId}
        AND connector_id = ${this.scope.connectorId}
        AND connection_run_id = ${connectionRunId}
      ${this.lockClause()}
    `
    return rows[0] ? authorizationAttemptFromRow(rows[0]) : null
  }

  async deleteAuthorizationAttempt(id: string): Promise<boolean> {
    const rows = this.scope.connectorId
      ? await this.sql<{ readonly id: string }[]>`
          DELETE FROM connector_authorization_attempts
          WHERE project_id = ${this.scope.projectId}
            AND connector_id = ${this.scope.connectorId}
            AND id = ${id}
          RETURNING id
        `
      : await this.sql<{ readonly id: string }[]>`
          DELETE FROM connector_authorization_attempts
          WHERE project_id = ${this.scope.projectId} AND id = ${id}
          RETURNING id
        `
    return rows.length === 1
  }

  async insertConnectionRun(record: ConnectorConnectionRunRecord): Promise<boolean> {
    try {
      const values = runValues(record)
      await this.sql`
        INSERT INTO connector_connection_runs (
          project_id, connector_id, id, kind, slot, initiated_by_execution_id,
          status, waiting_for, processing_id, callback_started_at,
          expires_at, authorization_id, cleanup_authorization_id, connections, error,
          created_at, updated_at, finished_at
        ) VALUES (
          ${record.projectId}, ${record.connectorId}, ${record.id}, ${values.kind},
          ${values.slot}, ${values.initiatedByExecutionId}, ${values.status},
          ${values.waitingFor}, ${values.processingId},
          ${values.callbackStartedAt}, ${values.expiresAt}, ${values.authorizationId},
          ${values.cleanupAuthorizationId},
          ${values.connections ? jsonParameter(this.sql, values.connections) : null},
          ${values.error ? jsonParameter(this.sql, values.error) : null},
          ${record.createdAt}, ${record.updatedAt}, ${values.finishedAt}
        )
      `
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async getConnectionRun(id: string): Promise<ConnectorConnectionRunRecord | null> {
    const rows = await this.runById(id)
    return rows[0] ? connectionRunFromRow(rows[0]) : null
  }

  async updateConnectionRun(record: ConnectorConnectionRunRecord): Promise<void> {
    const values = runValues(record)
    const rows = await this.sql<{ readonly id: string }[]>`
      UPDATE connector_connection_runs
      SET kind = ${values.kind}, slot = ${values.slot},
          initiated_by_execution_id = ${values.initiatedByExecutionId}, status = ${values.status},
          waiting_for = ${values.waitingFor},
          processing_id = ${values.processingId}, callback_started_at = ${values.callbackStartedAt},
          expires_at = ${values.expiresAt}, authorization_id = ${values.authorizationId},
          cleanup_authorization_id = ${values.cleanupAuthorizationId},
          connections = ${values.connections ? jsonParameter(this.sql, values.connections) : null},
          error = ${values.error ? jsonParameter(this.sql, values.error) : null},
          updated_at = ${record.updatedAt}, finished_at = ${values.finishedAt}
      WHERE project_id = ${record.projectId} AND connector_id = ${record.connectorId}
        AND id = ${record.id}
      RETURNING id
    `
    assertChanged(rows, "connector connection run", record.id)
  }

  async insertAuthorization(record: ConnectorAuthorizationRecord): Promise<boolean> {
    try {
      const values = authorizationValues(record)
      await this.sql`
        INSERT INTO connector_authorizations (
          project_id, connector_id, id, authorized_by, credentials, credential_expires_at,
          scopes, accounts, status, selection_expires_at, revision, mutation_id, mutation_kind,
          mutation_phase, mutation_holder_id, mutation_expires_at, mutation_deadline_at,
          mutation_expected_connection_ids, staged_credentials, staged_credential_expires_at,
          staged_scopes, created_at, updated_at
        ) VALUES (
          ${record.projectId}, ${record.connectorId}, ${record.id},
          ${jsonParameter(this.sql, record.authorizedBy)},
          ${record.credentials ? jsonParameter(this.sql, record.credentials) : null},
          ${record.credentialExpiresAt ?? null}, ${jsonParameter(this.sql, record.scopes)},
          ${jsonParameter(this.sql, record.accounts)}, ${record.status},
          ${record.selectionExpiresAt ?? null}, ${record.revision}, ${values.mutationId},
          ${values.mutationKind}, ${values.mutationPhase}, ${values.mutationHolderId},
          ${values.mutationExpiresAt}, ${values.mutationDeadlineAt},
          ${
            values.mutationExpectedConnectionIds
              ? jsonParameter(this.sql, values.mutationExpectedConnectionIds)
              : null
          },
          ${values.stagedCredentials ? jsonParameter(this.sql, values.stagedCredentials) : null},
          ${values.stagedCredentialExpiresAt},
          ${values.stagedScopes ? jsonParameter(this.sql, values.stagedScopes) : null},
          ${record.createdAt}, ${record.updatedAt}
        )
      `
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async getAuthorization(id: string): Promise<ConnectorAuthorizationRecord | null> {
    const rows = await this.authorizationById(id)
    return rows[0] ? authorizationFromRow(rows[0]) : null
  }

  async updateAuthorization(record: ConnectorAuthorizationRecord): Promise<void> {
    const values = authorizationValues(record)
    const rows = await this.sql<{ readonly id: string }[]>`
      UPDATE connector_authorizations
      SET authorized_by = ${jsonParameter(this.sql, record.authorizedBy)},
          credentials = ${record.credentials ? jsonParameter(this.sql, record.credentials) : null},
          credential_expires_at = ${record.credentialExpiresAt ?? null},
          scopes = ${jsonParameter(this.sql, record.scopes)},
          accounts = ${jsonParameter(this.sql, record.accounts)}, status = ${record.status},
          selection_expires_at = ${record.selectionExpiresAt ?? null}, revision = ${record.revision},
          mutation_id = ${values.mutationId}, mutation_kind = ${values.mutationKind},
          mutation_phase = ${values.mutationPhase}, mutation_holder_id = ${values.mutationHolderId},
          mutation_expires_at = ${values.mutationExpiresAt},
          mutation_deadline_at = ${values.mutationDeadlineAt},
          mutation_expected_connection_ids = ${
            values.mutationExpectedConnectionIds
              ? jsonParameter(this.sql, values.mutationExpectedConnectionIds)
              : null
          },
          staged_credentials = ${
            values.stagedCredentials ? jsonParameter(this.sql, values.stagedCredentials) : null
          },
          staged_credential_expires_at = ${values.stagedCredentialExpiresAt},
          staged_scopes = ${
            values.stagedScopes ? jsonParameter(this.sql, values.stagedScopes) : null
          },
          updated_at = ${record.updatedAt}
      WHERE project_id = ${record.projectId} AND connector_id = ${record.connectorId}
        AND id = ${record.id}
      RETURNING id
    `
    assertChanged(rows, "connector authorization", record.id)
  }

  async insertConnection(record: ConnectorConnectionRecord): Promise<boolean> {
    try {
      await this.sql`
        INSERT INTO connector_connections (
          project_id, connector_id, id, authorization_id, slot, account,
          account_id, status, disconnected_at, created_at, updated_at
        ) VALUES (
          ${record.projectId}, ${record.connectorId}, ${record.id}, ${record.authorizationId},
          ${record.slot}, ${jsonParameter(this.sql, record.account)},
          ${record.account.id}, ${record.status}, ${record.disconnectedAt ?? null},
          ${record.createdAt}, ${record.updatedAt}
        )
      `
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async getConnectionById(id: string): Promise<ConnectorConnectionRecord | null> {
    const rows = await this.connectionById(id)
    return rows[0] ? connectionFromRow(rows[0]) : null
  }

  async getConnectionBySelector(input: {
    readonly owner: { readonly type: "project" }
    readonly slot: string
  }): Promise<ConnectorConnectionRecord | null> {
    if (!this.scope.connectorId) return null
    const rows = await this.sql<PgConnectionRow[]>`
      SELECT * FROM connector_connections
      WHERE project_id = ${this.scope.projectId} AND connector_id = ${this.scope.connectorId}
        AND slot = ${input.slot}
      ${this.lockClause()}
    `
    return rows[0] ? connectionFromRow(rows[0]) : null
  }

  async listConnections(): Promise<readonly ConnectorConnectionRecord[]> {
    if (!this.scope.connectorId) return []
    const rows = await this.sql<PgConnectionRow[]>`
      SELECT * FROM connector_connections
      WHERE project_id = ${this.scope.projectId} AND connector_id = ${this.scope.connectorId}
      ORDER BY id
      ${this.lockClause()}
    `
    return rows.map(connectionFromRow)
  }

  async listConnectionsByAuthorization(
    authorizationId: string,
    options: { readonly connectedOnly?: boolean } = {}
  ): Promise<readonly ConnectorConnectionRecord[]> {
    if (!this.scope.connectorId) return []
    const rows = options.connectedOnly
      ? await this.sql<PgConnectionRow[]>`
          SELECT * FROM connector_connections
          WHERE project_id = ${this.scope.projectId} AND connector_id = ${this.scope.connectorId}
            AND authorization_id = ${authorizationId} AND status = 'connected'
          ORDER BY id
          ${this.lockClause()}
        `
      : await this.sql<PgConnectionRow[]>`
          SELECT * FROM connector_connections
          WHERE project_id = ${this.scope.projectId} AND connector_id = ${this.scope.connectorId}
            AND authorization_id = ${authorizationId}
          ORDER BY id
          ${this.lockClause()}
        `
    return rows.map(connectionFromRow)
  }

  async updateConnection(record: ConnectorConnectionRecord): Promise<void> {
    const rows = await this.sql<{ readonly id: string }[]>`
      UPDATE connector_connections
      SET authorization_id = ${record.authorizationId}, slot = ${record.slot},
          account = ${jsonParameter(this.sql, record.account)},
          account_id = ${record.account.id}, status = ${record.status},
          disconnected_at = ${record.disconnectedAt ?? null}, updated_at = ${record.updatedAt}
      WHERE project_id = ${record.projectId} AND connector_id = ${record.connectorId}
        AND id = ${record.id}
      RETURNING id
    `
    assertChanged(rows, "connector connection", record.id)
  }

  private runById(id: string): Promise<PgConnectionRunRow[]> {
    return this.scope.connectorId
      ? this.sql<PgConnectionRunRow[]>`
          SELECT * FROM connector_connection_runs
          WHERE project_id = ${this.scope.projectId}
            AND connector_id = ${this.scope.connectorId} AND id = ${id}
          ${this.lockClause()}
        `
      : this.sql<PgConnectionRunRow[]>`
          SELECT * FROM connector_connection_runs
          WHERE project_id = ${this.scope.projectId} AND id = ${id}
          ${this.lockClause()}
        `
  }

  private authorizationById(id: string): Promise<PgAuthorizationRow[]> {
    return this.scope.connectorId
      ? this.sql<PgAuthorizationRow[]>`
          SELECT * FROM connector_authorizations
          WHERE project_id = ${this.scope.projectId}
            AND connector_id = ${this.scope.connectorId} AND id = ${id}
          ${this.lockClause()}
        `
      : this.sql<PgAuthorizationRow[]>`
          SELECT * FROM connector_authorizations
          WHERE project_id = ${this.scope.projectId} AND id = ${id}
          ${this.lockClause()}
        `
  }

  private connectionById(id: string): Promise<PgConnectionRow[]> {
    return this.scope.connectorId
      ? this.sql<PgConnectionRow[]>`
          SELECT * FROM connector_connections
          WHERE project_id = ${this.scope.projectId}
            AND connector_id = ${this.scope.connectorId} AND id = ${id}
          ${this.lockClause()}
        `
      : this.sql<PgConnectionRow[]>`
          SELECT * FROM connector_connections
          WHERE project_id = ${this.scope.projectId} AND id = ${id}
          ${this.lockClause()}
        `
  }

  private lockClause() {
    return this.locking ? this.sql`FOR UPDATE` : this.sql``
  }
}

function authorizationAttemptFromRow(
  row: PgAuthorizationAttemptRow
): ConnectorAuthorizationAttemptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    owner: { type: "project" },
    slot: row.slot,
    initiatedByExecutionId: row.initiated_by_execution_id,
    stateHash: row.state_hash,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    ...(row.connection_run_id === null ? {} : { connectionRunId: row.connection_run_id }),
    ...(row.return_to === null ? {} : { returnTo: row.return_to }),
    ...(row.callback_binding_hash === null
      ? {}
      : { callbackBindingHash: row.callback_binding_hash }),
    ...(row.reauthorization_id === null ? {} : { reauthorizationId: row.reauthorization_id }),
    ...(row.reauthorization_revision === null
      ? {}
      : { reauthorizationRevision: row.reauthorization_revision }),
    ...(row.reauthorization_connection_ids === null
      ? {}
      : { reauthorizationConnectionIds: row.reauthorization_connection_ids }),
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
  }
}

function runValues(record: ConnectorConnectionRunRecord) {
  return {
    kind: record.kind,
    slot: record.slot,
    initiatedByExecutionId: record.initiatedByExecutionId,
    status: record.status,
    waitingFor: record.status === "waiting" ? record.waitingFor : null,
    processingId: record.status === "running" ? record.processingId : null,
    callbackStartedAt: record.status === "running" ? record.callbackStartedAt : null,
    expiresAt: record.status === "waiting" || record.status === "running" ? record.expiresAt : null,
    authorizationId: "authorizationId" in record ? (record.authorizationId ?? null) : null,
    cleanupAuthorizationId:
      record.status === "succeeded" ? (record.cleanupAuthorizationId ?? null) : null,
    connections: record.status === "succeeded" ? record.connections : null,
    error: record.status === "failed" ? record.error : null,
    finishedAt:
      record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "cancelled" ||
      record.status === "expired"
        ? record.finishedAt
        : null,
  }
}

function connectionRunFromRow(row: PgConnectionRunRow): ConnectorConnectionRunRecord {
  const base = {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    kind: row.kind,
    owner: { type: "project" as const },
    slot: row.slot,
    initiatedByExecutionId: row.initiated_by_execution_id,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
  if (row.status === "waiting" && row.waiting_for === "provider_authorization") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "provider_authorization",
      expiresAt: date(required(row.expires_at, "run expiry")),
    }
  }
  if (row.status === "waiting" && row.waiting_for === "account_selection") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "account_selection",
      authorizationId: required(row.authorization_id, "authorization id"),
      expiresAt: date(required(row.expires_at, "run expiry")),
    }
  }
  if (row.status === "running") {
    return {
      ...base,
      status: "running",
      processingId: required(row.processing_id, "processing id"),
      callbackStartedAt: date(required(row.callback_started_at, "callback start")),
      expiresAt: date(required(row.expires_at, "run expiry")),
      ...(row.authorization_id === null ? {} : { authorizationId: row.authorization_id }),
    }
  }
  const finishedAt = date(required(row.finished_at, "run finish"))
  if (row.status === "succeeded") {
    return {
      ...base,
      status: "succeeded",
      authorizationId: required(row.authorization_id, "authorization id"),
      ...(row.cleanup_authorization_id === null
        ? {}
        : { cleanupAuthorizationId: row.cleanup_authorization_id }),
      connections: required(row.connections, "connections").map(connectionFromSerialized),
      finishedAt,
    }
  }
  if (row.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: required(row.error, "run error"),
      ...(row.authorization_id === null ? {} : { authorizationId: row.authorization_id }),
      finishedAt,
    }
  }
  if (row.status === "cancelled") {
    return {
      ...base,
      status: "cancelled",
      ...(row.authorization_id === null ? {} : { authorizationId: row.authorization_id }),
      finishedAt,
    }
  }
  if (row.status === "expired") {
    return {
      ...base,
      status: "expired",
      ...(row.authorization_id === null ? {} : { authorizationId: row.authorization_id }),
      finishedAt,
    }
  }
  throw new Error(`[SixbPg] Stored connector connection run status '${row.status}' is invalid.`)
}

function authorizationValues(record: ConnectorAuthorizationRecord) {
  const mutation = record.credentialMutation
  return {
    mutationId: mutation?.id ?? null,
    mutationKind: mutation?.kind ?? null,
    mutationPhase: mutation?.phase ?? null,
    mutationHolderId: mutation?.holderId ?? null,
    mutationExpiresAt: mutation?.expiresAt ?? null,
    mutationDeadlineAt: mutation?.deadlineAt ?? null,
    mutationExpectedConnectionIds: mutation?.expectedConnectionIds ?? null,
    stagedCredentials: mutation?.stagedCredentials?.credentials ?? null,
    stagedCredentialExpiresAt: mutation?.stagedCredentials?.credentialExpiresAt ?? null,
    stagedScopes: mutation?.stagedCredentials?.scopes ?? null,
  }
}

function authorizationFromRow(row: PgAuthorizationRow): ConnectorAuthorizationRecord {
  const mutation = mutationFromRow(row)
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    authorizedBy: row.authorized_by,
    ...(row.credentials === null ? {} : { credentials: row.credentials }),
    ...(row.credential_expires_at === null
      ? {}
      : { credentialExpiresAt: date(row.credential_expires_at) }),
    scopes: row.scopes,
    accounts: row.accounts,
    status: row.status,
    ...(row.selection_expires_at === null
      ? {}
      : { selectionExpiresAt: date(row.selection_expires_at) }),
    revision: row.revision,
    ...(mutation === undefined ? {} : { credentialMutation: mutation }),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

function mutationFromRow(row: PgAuthorizationRow): ConnectorCredentialMutation | undefined {
  if (row.mutation_id === null) return undefined
  const stagedCredentials: ConnectorStagedCredentials | undefined =
    row.staged_credentials === null
      ? undefined
      : {
          credentials: row.staged_credentials,
          ...(row.staged_credential_expires_at === null
            ? {}
            : { credentialExpiresAt: date(row.staged_credential_expires_at) }),
          scopes: required(row.staged_scopes, "staged credential scopes"),
        }
  return {
    id: row.mutation_id,
    kind: required(row.mutation_kind, "credential mutation kind"),
    phase: required(row.mutation_phase, "credential mutation phase"),
    holderId: required(row.mutation_holder_id, "credential mutation holder"),
    expiresAt: date(required(row.mutation_expires_at, "credential mutation expiry")),
    deadlineAt: date(required(row.mutation_deadline_at, "credential mutation deadline")),
    ...(row.mutation_expected_connection_ids === null
      ? {}
      : { expectedConnectionIds: row.mutation_expected_connection_ids }),
    ...(stagedCredentials === undefined ? {} : { stagedCredentials }),
  }
}

function connectionFromRow(row: PgConnectionRow): ConnectorConnectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    authorizationId: row.authorization_id,
    owner: { type: "project" },
    slot: row.slot,
    account: row.account,
    status: row.status,
    ...(row.disconnected_at === null ? {} : { disconnectedAt: date(row.disconnected_at) }),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

type SerializedConnectorConnection = Omit<
  ConnectorConnectionRecord,
  "createdAt" | "updatedAt" | "disconnectedAt"
> & {
  readonly createdAt: string
  readonly updatedAt: string
  readonly disconnectedAt?: string
}

function connectionFromSerialized(
  record: SerializedConnectorConnection
): ConnectorConnectionRecord {
  const { createdAt, updatedAt, disconnectedAt, ...connection } = record
  return {
    ...connection,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    ...(disconnectedAt === undefined ? {} : { disconnectedAt: new Date(disconnectedAt) }),
  }
}

type PgJsonValue = Parameters<SQLClient["json"]>[0]

function jsonParameter(sql: PgStoreClient, value: unknown): ReturnType<PgStoreClient["json"]> {
  return sql.json(value as PgJsonValue)
}

function date(value: Date | string): Date {
  return new Date(value)
}

function required<T>(value: T | null, label: string): T {
  if (value !== null) return value
  throw new Error(`[SixbPg] Stored ${label} is missing.`)
}

function assertChanged(rows: readonly unknown[], label: string, id: string): void {
  if (rows.length === 1) return
  throw new Error(`[SixbPg] Stored ${label} '${id}' is unavailable.`)
}

interface ConnectorConnectionTestClock {
  offsetMs: number
}

interface PgAuthorizationAttemptRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly slot: string
  readonly initiated_by_execution_id: string
  readonly state_hash: string
  readonly code_verifier: ConnectorAuthorizationAttemptRecord["codeVerifier"]
  readonly redirect_uri: string
  readonly connection_run_id: string | null
  readonly return_to: string | null
  readonly callback_binding_hash: string | null
  readonly reauthorization_id: string | null
  readonly reauthorization_revision: number | null
  readonly reauthorization_connection_ids: readonly string[] | null
  readonly created_at: Date | string
  readonly expires_at: Date | string
}

interface PgConnectionRunRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly kind: ConnectorConnectionRunRecord["kind"]
  readonly slot: string
  readonly initiated_by_execution_id: string
  readonly status: ConnectorConnectionRunRecord["status"]
  readonly waiting_for: "provider_authorization" | "account_selection" | null
  readonly processing_id: string | null
  readonly callback_started_at: Date | string | null
  readonly expires_at: Date | string | null
  readonly authorization_id: string | null
  readonly cleanup_authorization_id: string | null
  readonly connections: readonly SerializedConnectorConnection[] | null
  readonly error: Extract<ConnectorConnectionRunRecord, { status: "failed" }>["error"] | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
  readonly finished_at: Date | string | null
}

interface PgAuthorizationRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly authorized_by: ConnectorAuthorizationRecord["authorizedBy"]
  readonly credentials: ConnectorAuthorizationRecord["credentials"] | null
  readonly credential_expires_at: Date | string | null
  readonly scopes: readonly string[]
  readonly accounts: ConnectorAuthorizationRecord["accounts"]
  readonly status: ConnectorAuthorizationRecord["status"]
  readonly selection_expires_at: Date | string | null
  readonly revision: number
  readonly mutation_id: string | null
  readonly mutation_kind: ConnectorCredentialMutation["kind"] | null
  readonly mutation_phase: ConnectorCredentialMutation["phase"] | null
  readonly mutation_holder_id: string | null
  readonly mutation_expires_at: Date | string | null
  readonly mutation_deadline_at: Date | string | null
  readonly mutation_expected_connection_ids: readonly string[] | null
  readonly staged_credentials: ConnectorStagedCredentials["credentials"] | null
  readonly staged_credential_expires_at: Date | string | null
  readonly staged_scopes: readonly string[] | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

interface PgConnectionRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly authorization_id: string
  readonly slot: string
  readonly account: ConnectorConnectionRecord["account"]
  readonly status: ConnectorConnectionRecord["status"]
  readonly disconnected_at: Date | string | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}
