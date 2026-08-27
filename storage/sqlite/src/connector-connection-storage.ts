import type { Database, SQLQueryBindings } from "bun:sqlite"
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
} from "@sixb/core/storage"
import { isUniqueConstraintError } from "./storage-errors"
import { runImmediateTransactionAsync, type SqliteStoreConnection } from "./transactions"

export class SqliteConnectorConnectionStorage extends DurableConnectorConnectionStorage {
  private readonly clock: ConnectorConnectionTestClock

  constructor(connection: SqliteStoreConnection) {
    const clock = { offsetMs: 0 }
    super(new SqliteConnectorConnectionPersistenceBackend(connection.db, clock))
    this.clock = clock
  }

  /** Internal deterministic clock control used only by the provider contract suite. */
  advanceTimeForTesting(durationMs: number): void {
    this.clock.offsetMs += durationMs
  }
}

class SqliteConnectorConnectionPersistenceBackend implements ConnectorConnectionPersistenceBackend {
  constructor(
    private readonly db: Database,
    private readonly clock: ConnectorConnectionTestClock
  ) {}

  read<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return run(new SqliteConnectorConnectionPersistence(this.db, scope, this.clock))
  }

  transaction<T>(
    scope: ConnectorConnectionPersistenceScope,
    run: (persistence: ConnectorConnectionPersistence) => Promise<T>
  ): Promise<T> {
    return runImmediateTransactionAsync(this.db, () =>
      run(new SqliteConnectorConnectionPersistence(this.db, scope, this.clock))
    )
  }
}

class SqliteConnectorConnectionPersistence implements ConnectorConnectionPersistence {
  constructor(
    private readonly db: Database,
    private readonly scope: ConnectorConnectionPersistenceScope,
    private readonly clock: ConnectorConnectionTestClock
  ) {}

  async now(): Promise<Date> {
    const row = this.db.query("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as {
      readonly now: string
    }
    return new Date(new Date(row.now).getTime() + this.clock.offsetMs)
  }

  async insertAuthorizationAttempt(record: ConnectorAuthorizationAttemptRecord): Promise<boolean> {
    try {
      this.db
        .query(
          `
          INSERT INTO connector_authorization_attempts (
            project_id, connector_id, id, slot, initiated_by_execution_id,
            state_hash, code_verifier, redirect_uri, connection_run_id, return_to,
            callback_binding_hash, reauthorization_id, reauthorization_revision,
            reauthorization_connection_ids, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          record.projectId,
          record.connectorId,
          record.id,
          record.slot,
          record.initiatedByExecutionId,
          record.stateHash,
          json(record.codeVerifier),
          record.redirectUri,
          record.connectionRunId ?? null,
          record.returnTo ?? null,
          record.callbackBindingHash ?? null,
          record.reauthorizationId ?? null,
          record.reauthorizationRevision ?? null,
          record.reauthorizationConnectionIds ? json(record.reauthorizationConnectionIds) : null,
          iso(record.createdAt),
          iso(record.expiresAt)
        )
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  }

  async getAuthorizationAttempt(id: string): Promise<ConnectorAuthorizationAttemptRecord | null> {
    const row = this.getById<SqliteAuthorizationAttemptRow>("connector_authorization_attempts", id)
    return row ? authorizationAttemptFromRow(row) : null
  }

  async getAuthorizationAttemptByConnectionRunId(
    connectionRunId: string
  ): Promise<ConnectorAuthorizationAttemptRecord | null> {
    if (!this.scope.connectorId) return null
    const row = this.db
      .query(
        `
        SELECT * FROM connector_authorization_attempts
        WHERE project_id = ? AND connector_id = ? AND connection_run_id = ?
      `
      )
      .get(
        this.scope.projectId,
        this.scope.connectorId,
        connectionRunId
      ) as SqliteAuthorizationAttemptRow | null
    return row ? authorizationAttemptFromRow(row) : null
  }

  async deleteAuthorizationAttempt(id: string): Promise<boolean> {
    return this.deleteById("connector_authorization_attempts", id)
  }

  async insertConnectionRun(record: ConnectorConnectionRunRecord): Promise<boolean> {
    try {
      this.insertRun(record)
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  }

  async getConnectionRun(id: string): Promise<ConnectorConnectionRunRecord | null> {
    const row = this.getById<SqliteConnectionRunRow>("connector_connection_runs", id)
    return row ? connectionRunFromRow(row) : null
  }

  async updateConnectionRun(record: ConnectorConnectionRunRecord): Promise<void> {
    const values = runValues(record)
    const result = this.db
      .query(
        `
        UPDATE connector_connection_runs
        SET kind = ?, slot = ?, initiated_by_execution_id = ?, status = ?,
            waiting_for = ?, processing_id = ?,
            callback_started_at = ?, expires_at = ?, authorization_id = ?,
            cleanup_authorization_id = ?, connections = ?, error = ?, updated_at = ?, finished_at = ?
        WHERE project_id = ? AND connector_id = ? AND id = ?
      `
      )
      .run(...values, record.projectId, record.connectorId, record.id)
    assertChanged(result.changes, "connector connection run", record.id)
  }

  async insertAuthorization(record: ConnectorAuthorizationRecord): Promise<boolean> {
    try {
      this.insertAuthorizationRow(record)
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  }

  async getAuthorization(id: string): Promise<ConnectorAuthorizationRecord | null> {
    const row = this.getById<SqliteAuthorizationRow>("connector_authorizations", id)
    return row ? authorizationFromRow(row) : null
  }

  async updateAuthorization(record: ConnectorAuthorizationRecord): Promise<void> {
    const result = this.db
      .query(
        `
        UPDATE connector_authorizations
        SET authorized_by = ?, credentials = ?, credential_expires_at = ?, scopes = ?, accounts = ?,
            status = ?, selection_expires_at = ?, revision = ?, mutation_id = ?, mutation_kind = ?,
            mutation_phase = ?, mutation_holder_id = ?, mutation_expires_at = ?,
            mutation_deadline_at = ?, mutation_expected_connection_ids = ?, staged_credentials = ?,
            staged_credential_expires_at = ?, staged_scopes = ?, updated_at = ?
        WHERE project_id = ? AND connector_id = ? AND id = ?
      `
      )
      .run(...authorizationValues(record), record.projectId, record.connectorId, record.id)
    assertChanged(result.changes, "connector authorization", record.id)
  }

  async insertConnection(record: ConnectorConnectionRecord): Promise<boolean> {
    try {
      this.db
        .query(
          `
          INSERT INTO connector_connections (
            project_id, connector_id, id, authorization_id, slot, account,
            account_id, status, disconnected_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          record.projectId,
          record.connectorId,
          record.id,
          record.authorizationId,
          record.slot,
          json(record.account),
          record.account.id,
          record.status,
          optionalIso(record.disconnectedAt),
          iso(record.createdAt),
          iso(record.updatedAt)
        )
      return true
    } catch (error) {
      if (isUniqueConstraintError(error)) return false
      throw error
    }
  }

  async getConnectionById(id: string): Promise<ConnectorConnectionRecord | null> {
    const row = this.getById<SqliteConnectionRow>("connector_connections", id)
    return row ? connectionFromRow(row) : null
  }

  async getConnectionBySelector(input: {
    readonly owner: { readonly type: "project" }
    readonly slot: string
  }): Promise<ConnectorConnectionRecord | null> {
    if (!this.scope.connectorId) return null
    const row = this.db
      .query(
        `
        SELECT * FROM connector_connections
        WHERE project_id = ? AND connector_id = ? AND slot = ?
      `
      )
      .get(this.scope.projectId, this.scope.connectorId, input.slot) as SqliteConnectionRow | null
    return row ? connectionFromRow(row) : null
  }

  async listConnections(): Promise<readonly ConnectorConnectionRecord[]> {
    if (!this.scope.connectorId) return []
    const rows = this.db
      .query(
        `
        SELECT * FROM connector_connections
        WHERE project_id = ? AND connector_id = ?
        ORDER BY id
      `
      )
      .all(this.scope.projectId, this.scope.connectorId) as SqliteConnectionRow[]
    return rows.map(connectionFromRow)
  }

  async listConnectionsByAuthorization(
    authorizationId: string,
    options: { readonly connectedOnly?: boolean } = {}
  ): Promise<readonly ConnectorConnectionRecord[]> {
    if (!this.scope.connectorId) return []
    const rows = options.connectedOnly
      ? (this.db
          .query(
            `
            SELECT * FROM connector_connections
            WHERE project_id = ? AND connector_id = ? AND authorization_id = ?
              AND status = 'connected'
            ORDER BY id
          `
          )
          .all(
            this.scope.projectId,
            this.scope.connectorId,
            authorizationId
          ) as SqliteConnectionRow[])
      : (this.db
          .query(
            `
            SELECT * FROM connector_connections
            WHERE project_id = ? AND connector_id = ? AND authorization_id = ?
            ORDER BY id
          `
          )
          .all(
            this.scope.projectId,
            this.scope.connectorId,
            authorizationId
          ) as SqliteConnectionRow[])
    return rows.map(connectionFromRow)
  }

  async updateConnection(record: ConnectorConnectionRecord): Promise<void> {
    const result = this.db
      .query(
        `
        UPDATE connector_connections
        SET authorization_id = ?, slot = ?, account = ?, account_id = ?,
            status = ?, disconnected_at = ?, updated_at = ?
        WHERE project_id = ? AND connector_id = ? AND id = ?
      `
      )
      .run(
        record.authorizationId,
        record.slot,
        json(record.account),
        record.account.id,
        record.status,
        optionalIso(record.disconnectedAt),
        iso(record.updatedAt),
        record.projectId,
        record.connectorId,
        record.id
      )
    assertChanged(result.changes, "connector connection", record.id)
  }

  private insertRun(record: ConnectorConnectionRunRecord): void {
    const values = runValues(record)
    this.db
      .query(
        `
        INSERT INTO connector_connection_runs (
          project_id, connector_id, id, kind, slot, initiated_by_execution_id,
          status, waiting_for, processing_id, callback_started_at,
          expires_at, authorization_id, cleanup_authorization_id, connections, error,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        record.projectId,
        record.connectorId,
        record.id,
        ...values.slice(0, -2),
        iso(record.createdAt),
        ...values.slice(-2)
      )
  }

  private insertAuthorizationRow(record: ConnectorAuthorizationRecord): void {
    const values = authorizationValues(record)
    this.db
      .query(
        `
        INSERT INTO connector_authorizations (
          project_id, connector_id, id, authorized_by, credentials, credential_expires_at,
          scopes, accounts, status, selection_expires_at, revision, mutation_id, mutation_kind,
          mutation_phase, mutation_holder_id, mutation_expires_at, mutation_deadline_at,
          mutation_expected_connection_ids, staged_credentials, staged_credential_expires_at,
          staged_scopes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        record.projectId,
        record.connectorId,
        record.id,
        ...values.slice(0, -1),
        iso(record.createdAt),
        ...values.slice(-1)
      )
  }

  private getById<TRow>(table: ConnectorTable, id: string): TRow | null {
    if (this.scope.connectorId) {
      return this.db
        .query(`SELECT * FROM ${table} WHERE project_id = ? AND connector_id = ? AND id = ?`)
        .get(this.scope.projectId, this.scope.connectorId, id) as TRow | null
    }
    return this.db
      .query(`SELECT * FROM ${table} WHERE project_id = ? AND id = ?`)
      .get(this.scope.projectId, id) as TRow | null
  }

  private deleteById(table: ConnectorTable, id: string): boolean {
    const result = this.scope.connectorId
      ? this.db
          .query(`DELETE FROM ${table} WHERE project_id = ? AND connector_id = ? AND id = ?`)
          .run(this.scope.projectId, this.scope.connectorId, id)
      : this.db
          .query(`DELETE FROM ${table} WHERE project_id = ? AND id = ?`)
          .run(this.scope.projectId, id)
    return result.changes === 1
  }
}

type ConnectorTable =
  | "connector_authorization_attempts"
  | "connector_connection_runs"
  | "connector_authorizations"
  | "connector_connections"

function authorizationAttemptFromRow(
  row: SqliteAuthorizationAttemptRow
): ConnectorAuthorizationAttemptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    owner: { type: "project" },
    slot: row.slot,
    initiatedByExecutionId: row.initiated_by_execution_id,
    stateHash: row.state_hash,
    codeVerifier: parseJson(row.code_verifier),
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
      : { reauthorizationConnectionIds: parseJson(row.reauthorization_connection_ids) }),
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  }
}

function runValues(record: ConnectorConnectionRunRecord): readonly SQLQueryBindings[] {
  const waitingFor = record.status === "waiting" ? record.waitingFor : null
  const processingId = record.status === "running" ? record.processingId : null
  const callbackStartedAt = record.status === "running" ? iso(record.callbackStartedAt) : null
  const expiresAt =
    record.status === "waiting" || record.status === "running" ? iso(record.expiresAt) : null
  const authorizationId = "authorizationId" in record ? (record.authorizationId ?? null) : null
  const cleanupAuthorizationId =
    record.status === "succeeded" ? (record.cleanupAuthorizationId ?? null) : null
  const connections = record.status === "succeeded" ? json(record.connections) : null
  const error = record.status === "failed" ? json(record.error) : null
  const finishedAt =
    record.status === "succeeded" ||
    record.status === "failed" ||
    record.status === "cancelled" ||
    record.status === "expired"
      ? iso(record.finishedAt)
      : null
  return [
    record.kind,
    record.slot,
    record.initiatedByExecutionId,
    record.status,
    waitingFor,
    processingId,
    callbackStartedAt,
    expiresAt,
    authorizationId,
    cleanupAuthorizationId,
    connections,
    error,
    iso(record.updatedAt),
    finishedAt,
  ]
}

function connectionRunFromRow(row: SqliteConnectionRunRow): ConnectorConnectionRunRecord {
  const base = {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    kind: row.kind,
    owner: { type: "project" as const },
    slot: row.slot,
    initiatedByExecutionId: row.initiated_by_execution_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
  if (row.status === "waiting" && row.waiting_for === "provider_authorization") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "provider_authorization",
      expiresAt: new Date(required(row.expires_at, "run expiry")),
    }
  }
  if (row.status === "waiting" && row.waiting_for === "account_selection") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "account_selection",
      authorizationId: required(row.authorization_id, "authorization id"),
      expiresAt: new Date(required(row.expires_at, "run expiry")),
    }
  }
  if (row.status === "running") {
    return {
      ...base,
      status: "running",
      processingId: required(row.processing_id, "processing id"),
      callbackStartedAt: new Date(required(row.callback_started_at, "callback start")),
      expiresAt: new Date(required(row.expires_at, "run expiry")),
      ...(row.authorization_id === null ? {} : { authorizationId: row.authorization_id }),
    }
  }
  const finishedAt = new Date(required(row.finished_at, "run finish"))
  if (row.status === "succeeded") {
    return {
      ...base,
      status: "succeeded",
      authorizationId: required(row.authorization_id, "authorization id"),
      ...(row.cleanup_authorization_id === null
        ? {}
        : { cleanupAuthorizationId: row.cleanup_authorization_id }),
      connections: parseJson<readonly SerializedConnectorConnection[]>(
        required(row.connections, "connections")
      ).map(connectionFromSerialized),
      finishedAt,
    }
  }
  if (row.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: parseJson(required(row.error, "run error")),
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
  throw invalidStoredValue("connector connection run status", row.status)
}

function authorizationValues(record: ConnectorAuthorizationRecord): readonly SQLQueryBindings[] {
  const mutation = record.credentialMutation
  const staged = mutation?.stagedCredentials
  return [
    json(record.authorizedBy),
    record.credentials ? json(record.credentials) : null,
    optionalIso(record.credentialExpiresAt),
    json(record.scopes),
    json(record.accounts),
    record.status,
    optionalIso(record.selectionExpiresAt),
    record.revision,
    mutation?.id ?? null,
    mutation?.kind ?? null,
    mutation?.phase ?? null,
    mutation?.holderId ?? null,
    optionalIso(mutation?.expiresAt),
    optionalIso(mutation?.deadlineAt),
    mutation?.expectedConnectionIds ? json(mutation.expectedConnectionIds) : null,
    staged ? json(staged.credentials) : null,
    optionalIso(staged?.credentialExpiresAt),
    staged ? json(staged.scopes) : null,
    iso(record.updatedAt),
  ]
}

function authorizationFromRow(row: SqliteAuthorizationRow): ConnectorAuthorizationRecord {
  const mutation = mutationFromRow(row)
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    authorizedBy: parseJson(row.authorized_by),
    ...(row.credentials === null ? {} : { credentials: parseJson(row.credentials) }),
    ...(row.credential_expires_at === null
      ? {}
      : { credentialExpiresAt: new Date(row.credential_expires_at) }),
    scopes: parseJson(row.scopes),
    accounts: parseJson(row.accounts),
    status: row.status,
    ...(row.selection_expires_at === null
      ? {}
      : { selectionExpiresAt: new Date(row.selection_expires_at) }),
    revision: row.revision,
    ...(mutation === undefined ? {} : { credentialMutation: mutation }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mutationFromRow(row: SqliteAuthorizationRow): ConnectorCredentialMutation | undefined {
  if (row.mutation_id === null) return undefined
  const kind = required(row.mutation_kind, "credential mutation kind")
  const phase = required(row.mutation_phase, "credential mutation phase")
  const stagedCredentials: ConnectorCredentialMutation["stagedCredentials"] =
    row.staged_credentials === null
      ? undefined
      : {
          credentials: parseJson<
            NonNullable<ConnectorCredentialMutation["stagedCredentials"]>["credentials"]
          >(row.staged_credentials),
          ...(row.staged_credential_expires_at === null
            ? {}
            : { credentialExpiresAt: new Date(row.staged_credential_expires_at) }),
          scopes: parseJson<readonly string[]>(
            required(row.staged_scopes, "staged credential scopes")
          ),
        }
  return {
    id: row.mutation_id,
    kind,
    phase,
    holderId: required(row.mutation_holder_id, "credential mutation holder"),
    expiresAt: new Date(required(row.mutation_expires_at, "credential mutation expiry")),
    deadlineAt: new Date(required(row.mutation_deadline_at, "credential mutation deadline")),
    ...(row.mutation_expected_connection_ids === null
      ? {}
      : {
          expectedConnectionIds: parseJson<readonly string[]>(row.mutation_expected_connection_ids),
        }),
    ...(stagedCredentials === undefined ? {} : { stagedCredentials }),
  }
}

function connectionFromRow(row: SqliteConnectionRow): ConnectorConnectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    authorizationId: row.authorization_id,
    owner: { type: "project" },
    slot: row.slot,
    account: parseJson(row.account),
    status: row.status,
    ...(row.disconnected_at === null ? {} : { disconnectedAt: new Date(row.disconnected_at) }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
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

function json(value: unknown): string {
  return JSON.stringify(value)
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function iso(value: Date): string {
  return value.toISOString()
}

function optionalIso(value: Date | undefined): string | null {
  return value?.toISOString() ?? null
}

function required<T>(value: T | null, label: string): T {
  if (value !== null) return value
  throw new Error(`[SixbSqlite] Stored ${label} is missing.`)
}

function invalidStoredValue(label: string, value: unknown): Error {
  return new Error(`[SixbSqlite] Stored ${label} '${String(value)}' is invalid.`)
}

function assertChanged(changes: number, label: string, id: string): void {
  if (changes === 1) return
  throw new Error(`[SixbSqlite] Stored ${label} '${id}' is unavailable.`)
}

interface SqliteAuthorizationAttemptRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly slot: string
  readonly initiated_by_execution_id: string
  readonly state_hash: string
  readonly code_verifier: string
  readonly redirect_uri: string
  readonly connection_run_id: string | null
  readonly return_to: string | null
  readonly callback_binding_hash: string | null
  readonly reauthorization_id: string | null
  readonly reauthorization_revision: number | null
  readonly reauthorization_connection_ids: string | null
  readonly created_at: string
  readonly expires_at: string
}

interface SqliteConnectionRunRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly kind: ConnectorConnectionRunRecord["kind"]
  readonly slot: string
  readonly initiated_by_execution_id: string
  readonly status: ConnectorConnectionRunRecord["status"]
  readonly waiting_for: "provider_authorization" | "account_selection" | null
  readonly processing_id: string | null
  readonly callback_started_at: string | null
  readonly expires_at: string | null
  readonly authorization_id: string | null
  readonly cleanup_authorization_id: string | null
  readonly connections: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly finished_at: string | null
}

interface SqliteAuthorizationRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly authorized_by: string
  readonly credentials: string | null
  readonly credential_expires_at: string | null
  readonly scopes: string
  readonly accounts: string
  readonly status: ConnectorAuthorizationRecord["status"]
  readonly selection_expires_at: string | null
  readonly revision: number
  readonly mutation_id: string | null
  readonly mutation_kind: ConnectorCredentialMutation["kind"] | null
  readonly mutation_phase: ConnectorCredentialMutation["phase"] | null
  readonly mutation_holder_id: string | null
  readonly mutation_expires_at: string | null
  readonly mutation_deadline_at: string | null
  readonly mutation_expected_connection_ids: string | null
  readonly staged_credentials: string | null
  readonly staged_credential_expires_at: string | null
  readonly staged_scopes: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface SqliteConnectionRow {
  readonly project_id: string
  readonly connector_id: string
  readonly id: string
  readonly authorization_id: string
  readonly slot: string
  readonly account: string
  readonly account_id: string
  readonly status: ConnectorConnectionRecord["status"]
  readonly disconnected_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface ConnectorConnectionTestClock {
  offsetMs: number
}
