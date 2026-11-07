import type { Database } from "bun:sqlite"
import {
  type DatasetIngestDeliveryRecord,
  type DatasetIngestPendingCounts,
  type DatasetIngestPersistence,
  type DatasetIngestPersistenceBackend,
  type DatasetIngestRejectionRecord,
  type DatasetIngestState,
  DurableDatasetIngestStorage,
  initialDatasetIngestState,
} from "@sixb/core/internal/dataset-ingest-storage-provider"
import type { DatasetIngestDelivery } from "@sixb/core/storage"
import { runImmediateTransactionAsync, type SqliteStoreConnection } from "./transactions"

export class SqliteDatasetIngestStorage extends DurableDatasetIngestStorage {
  constructor(connection: SqliteStoreConnection) {
    super(new SqliteDatasetIngestBackend(connection.db))
  }
}

class SqliteDatasetIngestBackend implements DatasetIngestPersistenceBackend {
  private readonly persistence: DatasetIngestPersistence

  constructor(private readonly db: Database) {
    this.persistence = new SqliteDatasetIngestPersistence(db)
  }

  read<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    return run(this.persistence)
  }

  // SQLite has one writer: `BEGIN IMMEDIATE` orders every request against every batch.
  transaction<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    return runImmediateTransactionAsync(this.db, () => run(this.persistence))
  }
}

interface SqliteStateRow {
  readonly datasetId: string
  readonly request: number
  readonly requestedAt: string | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: string | null
  readonly flushId: string | null
  readonly flushStartedAt: string | null
  readonly failureStreak: number
  readonly lastFlushedAt: string | null
}

interface SqliteDeliveryRow {
  readonly id: number
  readonly datasetId: string
  readonly executionId: string
  readonly correlationId: string
  readonly receivedAt: string
  readonly changeCount: number
  readonly definitionHash: string
}

interface SqliteRejectionRow extends SqliteDeliveryRow {
  readonly changes: string
  readonly rejectedAt: string
  readonly rejection: string
}

const SELECT_STATE = `
  SELECT dataset_id AS datasetId, request, requested_at AS requestedAt, lease_owner AS leaseOwner,
    lease_expires_at AS leaseExpiresAt, flush_id AS flushId, flush_started_at AS flushStartedAt,
    failure_streak AS failureStreak, last_flushed_at AS lastFlushedAt
  FROM dataset_ingest_state`

const SELECT_DELIVERY = `
  SELECT id, dataset_id AS datasetId, execution_id AS executionId,
    correlation_id AS correlationId, received_at AS receivedAt, change_count AS changeCount,
    definition_hash AS definitionHash
  FROM dataset_ingest_deliveries`

class SqliteDatasetIngestPersistence implements DatasetIngestPersistence {
  constructor(private readonly db: Database) {}

  async now(): Promise<Date> {
    const row = this.db.query("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as {
      readonly now: string
    }
    return new Date(row.now)
  }

  async lockState(projectId: string, datasetId: string): Promise<DatasetIngestState> {
    this.db
      .query(
        `INSERT INTO dataset_ingest_state (project_id, dataset_id) VALUES (?, ?)
         ON CONFLICT (project_id, dataset_id) DO NOTHING`
      )
      .run(projectId, datasetId)

    const row = this.db
      .query(`${SELECT_STATE} WHERE project_id = ? AND dataset_id = ?`)
      .get(projectId, datasetId) as SqliteStateRow | null
    return row ? stateFromRow(row) : initialDatasetIngestState(datasetId)
  }

  async writeState(projectId: string, state: DatasetIngestState): Promise<void> {
    this.db
      .query(
        `UPDATE dataset_ingest_state
         SET request = ?, requested_at = ?, lease_owner = ?, lease_expires_at = ?, flush_id = ?,
           flush_started_at = ?, failure_streak = ?, last_flushed_at = ?
         WHERE project_id = ? AND dataset_id = ?`
      )
      .run(
        state.request,
        state.requestedAt?.toISOString() ?? null,
        state.leaseOwner,
        state.leaseExpiresAt?.toISOString() ?? null,
        state.flushId,
        state.flushStartedAt?.toISOString() ?? null,
        state.failureStreak,
        state.lastFlushedAt?.toISOString() ?? null,
        projectId,
        state.datasetId
      )
  }

  async insertDelivery(projectId: string, record: DatasetIngestDeliveryRecord): Promise<string> {
    const result = this.db
      .query(
        `INSERT INTO dataset_ingest_deliveries (
          project_id, dataset_id, execution_id, correlation_id, received_at, change_count,
          definition_hash, changes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        record.datasetId,
        record.executionId,
        record.correlationId,
        record.receivedAt.toISOString(),
        record.changeCount,
        record.definitionHash,
        record.changes
      )
    return String(result.lastInsertRowid)
  }

  async listUntaken(
    projectId: string,
    datasetId: string,
    limit: number
  ): Promise<readonly DatasetIngestDelivery[]> {
    const rows = this.db
      .query(
        `${SELECT_DELIVERY}
         WHERE project_id = ? AND dataset_id = ? AND flush_id IS NULL AND rejected_at IS NULL
         ORDER BY id
         LIMIT ?`
      )
      .all(projectId, datasetId, limit) as SqliteDeliveryRow[]
    return rows.map(deliveryFromRow)
  }

  async take(
    projectId: string,
    datasetId: string,
    deliveryIds: readonly string[],
    flushId: string
  ): Promise<void> {
    const statement = this.db.query(
      `UPDATE dataset_ingest_deliveries SET flush_id = ?
       WHERE project_id = ? AND dataset_id = ? AND id = ?`
    )
    for (const id of deliveryIds) statement.run(flushId, projectId, datasetId, Number(id))
  }

  async listFlush(
    projectId: string,
    datasetId: string,
    flushId: string
  ): Promise<readonly DatasetIngestDelivery[]> {
    const rows = this.db
      .query(
        `${SELECT_DELIVERY}
         WHERE project_id = ? AND dataset_id = ? AND flush_id = ?
         ORDER BY id`
      )
      .all(projectId, datasetId, flushId) as SqliteDeliveryRow[]
    return rows.map(deliveryFromRow)
  }

  async readFlush(
    projectId: string,
    datasetId: string,
    flushId: string,
    page: { readonly afterId: string | null; readonly limit: number }
  ): Promise<readonly { readonly delivery: DatasetIngestDelivery; readonly changes: string }[]> {
    const rows = this.db
      .query(
        `SELECT id, dataset_id AS datasetId, execution_id AS executionId,
           correlation_id AS correlationId, received_at AS receivedAt,
           change_count AS changeCount, definition_hash AS definitionHash, changes
         FROM dataset_ingest_deliveries
         WHERE project_id = ? AND dataset_id = ? AND flush_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      )
      .all(
        projectId,
        datasetId,
        flushId,
        Number(page.afterId ?? 0),
        page.limit
      ) as (SqliteDeliveryRow & { readonly changes: string })[]
    return rows.map((row) => ({ delivery: deliveryFromRow(row), changes: row.changes }))
  }

  async deleteFlush(projectId: string, datasetId: string, flushId: string): Promise<void> {
    this.db
      .query(
        "DELETE FROM dataset_ingest_deliveries WHERE project_id = ? AND dataset_id = ? AND flush_id = ?"
      )
      .run(projectId, datasetId, flushId)
  }

  async rejectDelivery(
    projectId: string,
    datasetId: string,
    flushId: string,
    deliveryId: string,
    rejection: { readonly rejectedAt: Date; readonly reason: string }
  ): Promise<void> {
    this.db
      .query(
        `UPDATE dataset_ingest_deliveries
         SET flush_id = NULL, rejected_at = ?, rejection = ?
         WHERE project_id = ? AND dataset_id = ? AND flush_id = ? AND id = ?`
      )
      .run(
        rejection.rejectedAt.toISOString(),
        rejection.reason,
        projectId,
        datasetId,
        flushId,
        Number(deliveryId)
      )
  }

  async listRejected(
    projectId: string,
    datasetId: string | undefined,
    limit: number
  ): Promise<readonly DatasetIngestRejectionRecord[]> {
    const rows = this.db
      .query(
        `SELECT id, dataset_id AS datasetId, execution_id AS executionId,
           correlation_id AS correlationId, received_at AS receivedAt,
           change_count AS changeCount, definition_hash AS definitionHash, changes,
           rejected_at AS rejectedAt, rejection
         FROM dataset_ingest_deliveries
         WHERE project_id = ? AND rejected_at IS NOT NULL AND (? IS NULL OR dataset_id = ?)
         ORDER BY rejected_at DESC, id DESC
         LIMIT ?`
      )
      .all(projectId, datasetId ?? null, datasetId ?? null, limit) as SqliteRejectionRow[]

    return rows.map((row) => ({
      delivery: deliveryFromRow(row),
      rejectedAt: new Date(row.rejectedAt),
      reason: row.rejection,
      changes: row.changes,
    }))
  }

  async deleteRejected(projectId: string, before: Date): Promise<void> {
    this.db
      .query(`DELETE FROM dataset_ingest_deliveries WHERE project_id = ? AND rejected_at < ?`)
      .run(projectId, before.toISOString())
  }

  async listStates(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestState[]> {
    const rows = this.db
      .query(`${SELECT_STATE} WHERE project_id = ?`)
      .all(projectId) as SqliteStateRow[]
    return rows.filter((row) => wanted(datasetIds, row.datasetId)).map(stateFromRow)
  }

  async countPending(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestPendingCounts[]> {
    const rows = this.db
      .query(
        `SELECT dataset_id AS datasetId,
           count(*) FILTER (WHERE rejected_at IS NULL) AS deliveries,
           coalesce(sum(change_count) FILTER (WHERE rejected_at IS NULL), 0) AS changes,
           min(received_at) FILTER (WHERE rejected_at IS NULL) AS oldest,
           count(*) FILTER (WHERE rejected_at IS NOT NULL) AS rejected
         FROM dataset_ingest_deliveries
         WHERE project_id = ?
         GROUP BY dataset_id`
      )
      .all(projectId) as {
      readonly datasetId: string
      readonly deliveries: number
      readonly changes: number
      readonly oldest: string | null
      readonly rejected: number
    }[]

    return rows
      .filter((row) => wanted(datasetIds, row.datasetId))
      .map((row) => ({
        datasetId: row.datasetId,
        pendingDeliveries: row.deliveries,
        pendingChanges: row.changes,
        oldestReceivedAt: row.oldest === null ? null : new Date(row.oldest),
        rejectedDeliveries: row.rejected,
      }))
  }
}

function wanted(datasetIds: readonly string[] | undefined, datasetId: string): boolean {
  return datasetIds === undefined || datasetIds.includes(datasetId)
}

function stateFromRow(row: SqliteStateRow): DatasetIngestState {
  return {
    datasetId: row.datasetId,
    request: row.request,
    requestedAt: row.requestedAt === null ? null : new Date(row.requestedAt),
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt),
    flushId: row.flushId,
    flushStartedAt: row.flushStartedAt === null ? null : new Date(row.flushStartedAt),
    failureStreak: row.failureStreak,
    lastFlushedAt: row.lastFlushedAt === null ? null : new Date(row.lastFlushedAt),
  }
}

function deliveryFromRow(row: SqliteDeliveryRow): DatasetIngestDelivery {
  return {
    id: String(row.id),
    datasetId: row.datasetId,
    executionId: row.executionId,
    correlationId: row.correlationId,
    receivedAt: new Date(row.receivedAt),
    changeCount: row.changeCount,
    definitionHash: row.definitionHash,
  }
}
