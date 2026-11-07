import {
  type DatasetIngestDeliveryRecord,
  type DatasetIngestPendingCounts,
  type DatasetIngestPersistence,
  type DatasetIngestPersistenceBackend,
  type DatasetIngestState,
  DurableDatasetIngestStorage,
  initialDatasetIngestState,
} from "@sixb/core/internal/dataset-ingest-storage-provider"
import type { DatasetIngestDelivery } from "@sixb/core/storage"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgDatasetIngestStorage extends DurableDatasetIngestStorage {
  constructor(sql: PgStoreClient) {
    super(new PgDatasetIngestBackend(sql))
  }
}

class PgDatasetIngestBackend implements DatasetIngestPersistenceBackend {
  constructor(private readonly sql: PgStoreClient) {}

  read<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    return run(new PgDatasetIngestPersistence(this.sql))
  }

  transaction<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    return runPgTransaction(this.sql, (tx) => run(new PgDatasetIngestPersistence(tx)))
  }
}

interface PgStateRow {
  readonly dataset_id: string
  readonly request: string
  readonly requested_at: Date | null
  readonly lease_owner: string | null
  readonly lease_expires_at: Date | null
  readonly flush_id: string | null
  readonly flush_started_at: Date | null
  readonly failure_streak: number
  readonly last_flushed_at: Date | null
}

interface PgDeliveryRow {
  readonly id: string
  readonly dataset_id: string
  readonly execution_id: string
  readonly correlation_id: string
  readonly received_at: Date
  readonly change_count: number
}

class PgDatasetIngestPersistence implements DatasetIngestPersistence {
  constructor(private readonly sql: PgStoreClient) {}

  async now(): Promise<Date> {
    const [row] = await this.sql<{ readonly now: Date }[]>`SELECT clock_timestamp() AS now`
    if (!row) throw new Error("[SixbPg] Database clock returned no row.")
    return new Date(row.now)
  }

  async lockState(projectId: string, datasetId: string): Promise<DatasetIngestState> {
    await this.sql`
      INSERT INTO dataset_ingest_state (project_id, dataset_id)
      VALUES (${projectId}, ${datasetId})
      ON CONFLICT (project_id, dataset_id) DO NOTHING
    `

    // Read committed: this statement runs once the lock is ours, so it sees every delivery and
    // request committed before.
    const [row] = await this.sql<PgStateRow[]>`
      SELECT dataset_id, request::text AS request, requested_at, lease_owner, lease_expires_at,
        flush_id, flush_started_at, failure_streak, last_flushed_at
      FROM dataset_ingest_state
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId}
      FOR UPDATE
    `
    return row ? stateFromRow(row) : initialDatasetIngestState(datasetId)
  }

  async writeState(projectId: string, state: DatasetIngestState): Promise<void> {
    await this.sql`
      UPDATE dataset_ingest_state
      SET request = ${state.request},
        requested_at = ${state.requestedAt},
        lease_owner = ${state.leaseOwner},
        lease_expires_at = ${state.leaseExpiresAt},
        flush_id = ${state.flushId},
        flush_started_at = ${state.flushStartedAt},
        failure_streak = ${state.failureStreak},
        last_flushed_at = ${state.lastFlushedAt}
      WHERE project_id = ${projectId} AND dataset_id = ${state.datasetId}
    `
  }

  async insertDelivery(projectId: string, record: DatasetIngestDeliveryRecord): Promise<string> {
    const [row] = await this.sql<{ readonly id: string }[]>`
      INSERT INTO dataset_ingest_deliveries (
        project_id, dataset_id, execution_id, correlation_id, received_at, change_count, changes
      ) VALUES (
        ${projectId}, ${record.datasetId}, ${record.executionId}, ${record.correlationId},
        ${record.receivedAt}, ${record.changeCount}, ${record.changes}
      )
      RETURNING id::text AS id
    `
    if (!row) throw new Error("[SixbPg] Dataset ingest delivery insert returned no id.")
    return row.id
  }

  async listUntaken(
    projectId: string,
    datasetId: string,
    limit: number
  ): Promise<readonly DatasetIngestDelivery[]> {
    const rows = await this.sql<PgDeliveryRow[]>`
      -- The id is read as text: ORDER BY names the table's column, not that alias.
      SELECT id::text AS id, dataset_id, execution_id, correlation_id, received_at, change_count
      FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId} AND flush_id IS NULL
      ORDER BY dataset_ingest_deliveries.id
      LIMIT ${limit}
    `
    return rows.map(deliveryFromRow)
  }

  async take(
    projectId: string,
    datasetId: string,
    deliveryIds: readonly string[],
    flushId: string
  ): Promise<void> {
    await this.sql`
      UPDATE dataset_ingest_deliveries
      SET flush_id = ${flushId}
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId}
        AND id = ANY(${this.sql.array([...deliveryIds])}::bigint[])
    `
  }

  async listFlush(
    projectId: string,
    datasetId: string,
    flushId: string
  ): Promise<readonly DatasetIngestDelivery[]> {
    const rows = await this.sql<PgDeliveryRow[]>`
      SELECT id::text AS id, dataset_id, execution_id, correlation_id, received_at, change_count
      FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId} AND flush_id = ${flushId}
      ORDER BY dataset_ingest_deliveries.id
    `
    return rows.map(deliveryFromRow)
  }

  async readFlush(
    projectId: string,
    datasetId: string,
    flushId: string,
    page: { readonly afterId: string | null; readonly limit: number }
  ): Promise<readonly { readonly delivery: DatasetIngestDelivery; readonly changes: string }[]> {
    const rows = await this.sql<(PgDeliveryRow & { readonly changes: string })[]>`
      SELECT id::text AS id, dataset_id, execution_id, correlation_id, received_at, change_count,
        changes
      FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId} AND flush_id = ${flushId}
        AND id > ${page.afterId ?? "0"}::bigint
      ORDER BY dataset_ingest_deliveries.id
      LIMIT ${page.limit}
    `
    return rows.map((row) => ({ delivery: deliveryFromRow(row), changes: row.changes }))
  }

  async deleteFlush(projectId: string, datasetId: string, flushId: string): Promise<void> {
    await this.sql`
      DELETE FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId} AND flush_id = ${flushId}
    `
  }

  async deleteDeliveries(
    projectId: string,
    datasetId: string,
    flushId: string,
    deliveryIds: readonly string[]
  ): Promise<void> {
    await this.sql`
      DELETE FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId} AND dataset_id = ${datasetId} AND flush_id = ${flushId}
        AND id = ANY(${this.sql.array([...deliveryIds])}::bigint[])
    `
  }

  async listStates(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestState[]> {
    const rows = await this.sql<PgStateRow[]>`
      SELECT dataset_id, request::text AS request, requested_at, lease_owner, lease_expires_at,
        flush_id, flush_started_at, failure_streak, last_flushed_at
      FROM dataset_ingest_state
      WHERE project_id = ${projectId}
        AND (${datasetIds === undefined} OR dataset_id = ANY(${this.sql.array([...(datasetIds ?? [])])}::text[]))
    `
    return rows.map(stateFromRow)
  }

  async countPending(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestPendingCounts[]> {
    const rows = await this.sql<
      {
        readonly dataset_id: string
        readonly deliveries: string
        readonly changes: string
        readonly oldest: Date | null
      }[]
    >`
      SELECT dataset_id, count(*)::text AS deliveries, sum(change_count)::text AS changes,
        min(received_at) AS oldest
      FROM dataset_ingest_deliveries
      WHERE project_id = ${projectId}
        AND (${datasetIds === undefined} OR dataset_id = ANY(${this.sql.array([...(datasetIds ?? [])])}::text[]))
      GROUP BY dataset_id
    `
    return rows.map((row) => ({
      datasetId: row.dataset_id,
      pendingDeliveries: Number(row.deliveries),
      pendingChanges: Number(row.changes),
      oldestReceivedAt: row.oldest === null ? null : new Date(row.oldest),
    }))
  }
}

function stateFromRow(row: PgStateRow): DatasetIngestState {
  return {
    datasetId: row.dataset_id,
    request: Number(row.request),
    requestedAt: row.requested_at === null ? null : new Date(row.requested_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
    flushId: row.flush_id,
    flushStartedAt: row.flush_started_at === null ? null : new Date(row.flush_started_at),
    failureStreak: row.failure_streak,
    lastFlushedAt: row.last_flushed_at === null ? null : new Date(row.last_flushed_at),
  }
}

function deliveryFromRow(row: PgDeliveryRow): DatasetIngestDelivery {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    receivedAt: new Date(row.received_at),
    changeCount: row.change_count,
  }
}
