// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.
/// <reference path="./sql.d.ts" />

import type { MigrationCapableStorage, StorageMigrator } from "@sixb/core"
import { createPostgresStorageMigrators, dropSchema } from "./migrations"
import { PgActionRunStorage } from "./pg-action-run-storage"
import { PgAuthStorage } from "./pg-auth-storage"
import { createPgClient, type SQL } from "./pg-client"
import { PgObjectStorage } from "./pg-object-storage"
import { PgPipelineRunStorage } from "./pg-pipeline-run-storage"
import { PgProjectionRunStorage } from "./pg-projection-run-storage"
import { PgRulesStorage } from "./pg-rules-storage"
import { PgSyncRunStorage } from "./pg-sync-run-storage"
import { PgTimeseriesStorage } from "./pg-timeseries-storage"
import { PgWebhookDeliveryStorage } from "./pg-webhook-delivery-storage"
import { PgWebhookRunStorage } from "./pg-webhook-run-storage"
import { PgWorkflowInterventionStorage } from "./pg-workflow-intervention-storage"
import { PgWorkflowRunStorage } from "./pg-workflow-run-storage"

export interface PostgresStorageOptions {
  /** Full connection string (e.g. DATABASE_URL). Takes precedence over individual fields. */
  connectionString?: string

  /** PostgreSQL host. Defaults to 'localhost'. */
  host?: string
  /** PostgreSQL port. Defaults to 5432. */
  port?: number
  /** Database name. */
  database?: string
  /** Database user. */
  user?: string
  /** Database password. */
  password?: string

  /** Maximum number of connections in the pool. Defaults to 10. */
  max?: number
  /** Idle connection timeout in milliseconds. Defaults to 30000. */
  idleTimeoutMillis?: number

  /**
   * Server-side `statement_timeout` (ms) applied to every connection in the pool. A query
   * exceeding it is cancelled by PostgreSQL, which frees its pooled connection instead of
   * pinning it indefinitely. Without this, a single stalled query can starve a small pool
   * until the process is restarted. Unset by default (no timeout). Set per role — keep it
   * generous or unset for workers that run long migrations/bulk writes.
   */
  statementTimeoutMillis?: number
  /**
   * Server-side `idle_in_transaction_session_timeout` (ms) applied to every connection. A
   * transaction left open and idle beyond it is aborted by PostgreSQL, releasing the
   * connection. Unset by default (no timeout).
   */
  idleInTransactionSessionTimeoutMillis?: number

  /**
   * Grace period (ms) for {@link PostgresStorage.close}. On shutdown the pool stops
   * accepting new queries and waits up to this long for in-flight queries to finish before
   * destroying the connections, so a restart drains cleanly instead of severing live work.
   * Defaults to 5000.
   */
  shutdownTimeoutMillis?: number

  /** Seconds to wait when establishing a connection. Defaults to 10000. */
  connectTimeoutMillis?: number
  /**
   * Whether to use server-side prepared statements (porsager's default, faster against a
   * direct Postgres connection). Behind PgBouncer transaction mode they require PgBouncer
   * >= 1.21 with `max_prepared_statements > 0`; set `false` for an older PgBouncer or when
   * that setting is 0. Defaults to `true`.
   */
  prepare?: boolean

  /** PostgreSQL schema name for all Sixb tables. Defaults to 'sixb'. */
  schemaName?: string

  /** SSL configuration. */
  ssl?: boolean | "require" | "prefer"
}

/**
 * PostgreSQL storage provider for Sixb.
 *
 * Bundles Sixb storage adapters backed by a shared PostgreSQL connection pool (porsager
 * `postgres`), which reliably reclaims connections under load.
 *
 * The storage exposes a core `StorageMigrator`. Sixb CLI startup and
 * `sixb db migrate` run it automatically through `migrateStorage(storage)`.
 *
 * Usage:
 * ```ts
 * const pg = new PostgresStorage({
 *   connectionString: process.env.DATABASE_URL!,
 * })
 *
 * export const sixb = createSixb({
 *   broker: myBroker,
 *   storage: pg,
 * })
 * ```
 */
export class PostgresStorage implements MigrationCapableStorage {
  readonly objects: PgObjectStorage
  readonly auth: PgAuthStorage
  readonly actionRuns: PgActionRunStorage
  readonly pipelineRuns: PgPipelineRunStorage
  readonly workflowRuns: PgWorkflowRunStorage
  readonly workflowInterventions: PgWorkflowInterventionStorage
  readonly syncRuns: PgSyncRunStorage
  readonly projectionRuns: PgProjectionRunStorage
  readonly timeseries: PgTimeseriesStorage
  readonly webhookDeliveries: PgWebhookDeliveryStorage
  readonly webhookRuns: PgWebhookRunStorage
  readonly rules: PgRulesStorage
  readonly migrators: readonly StorageMigrator[]

  private readonly sql: SQL
  private readonly schemaName: string
  private readonly shutdownTimeoutSeconds: number

  constructor(options: PostgresStorageOptions) {
    this.schemaName = options.schemaName ?? "sixb"
    this.shutdownTimeoutSeconds = Math.max(
      1,
      Math.round((options.shutdownTimeoutMillis ?? 5000) / 1000)
    )

    this.sql = createPgClient({
      ...(options.connectionString !== undefined
        ? { connectionString: options.connectionString }
        : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.database !== undefined ? { database: options.database } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
      ...(options.password !== undefined ? { password: options.password } : {}),
      max: options.max ?? 10,
      schemaName: this.schemaName,
      ...(options.idleTimeoutMillis !== undefined
        ? { idleTimeoutMillis: options.idleTimeoutMillis }
        : {}),
      ...(resolveTimeoutMillis(options.statementTimeoutMillis, "statementTimeoutMillis") !==
      undefined
        ? { statementTimeoutMillis: options.statementTimeoutMillis }
        : {}),
      ...(resolveTimeoutMillis(
        options.idleInTransactionSessionTimeoutMillis,
        "idleInTransactionSessionTimeoutMillis"
      ) !== undefined
        ? { idleInTransactionSessionTimeoutMillis: options.idleInTransactionSessionTimeoutMillis }
        : {}),
      ...(resolveTimeoutMillis(options.connectTimeoutMillis, "connectTimeoutMillis") !== undefined
        ? { connectTimeoutMillis: options.connectTimeoutMillis }
        : {}),
      ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    })

    this.migrators = createPostgresStorageMigrators(this.sql, this.schemaName)
    this.objects = new PgObjectStorage(this.sql)
    this.auth = new PgAuthStorage({ sql: this.sql })
    this.actionRuns = new PgActionRunStorage(this.sql)
    this.pipelineRuns = new PgPipelineRunStorage(this.sql)
    this.workflowRuns = new PgWorkflowRunStorage(this.sql)
    this.workflowInterventions = new PgWorkflowInterventionStorage(this.sql)
    this.syncRuns = new PgSyncRunStorage(this.sql)
    this.projectionRuns = new PgProjectionRunStorage(this.sql)
    this.timeseries = new PgTimeseriesStorage(this.sql)
    this.webhookDeliveries = new PgWebhookDeliveryStorage(this.sql)
    this.webhookRuns = new PgWebhookRunStorage(this.sql)
    this.rules = new PgRulesStorage(this.sql)
  }

  /**
   * Close the connection pool. Should be called on shutdown.
   *
   * Stops accepting new queries and waits up to `shutdownTimeoutMillis` for in-flight
   * queries to finish before destroying connections.
   */
  async close(): Promise<void> {
    await this.sql.end({ timeout: this.shutdownTimeoutSeconds })
  }

  /**
   * Drop all Sixb tables and schema. Useful for test cleanup.
   * WARNING: This permanently deletes all data.
   */
  async dropSchema(): Promise<void> {
    await dropSchema(this.sql, this.schemaName)
  }
}

function resolveTimeoutMillis(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[Sixb] PostgresStorage ${label} must be a non-negative finite number.`)
  }

  return Math.trunc(value)
}

export type { PostgresMigrationContext } from "./migrations"
export {
  createPostgresMigrator,
  createPostgresStorageMigrators,
  dropSchema,
  migratePostgresStorage,
  POSTGRES_STORAGE_ADAPTER_ID,
  pgSql,
  pgStep,
  postgresStorageMigrations,
  quoteIdent,
} from "./migrations"
export { PgActionRunStorage } from "./pg-action-run-storage"
export type { PgAuthStorageOptions } from "./pg-auth-storage"
export { PgAuthStorage } from "./pg-auth-storage"
export { PgObjectStorage } from "./pg-object-storage"
export { PgPipelineRunStorage } from "./pg-pipeline-run-storage"
export { PgProjectionRunStorage } from "./pg-projection-run-storage"
export { PgRulesStorage } from "./pg-rules-storage"
export { PgSyncRunStorage } from "./pg-sync-run-storage"
export { PgTimeseriesStorage } from "./pg-timeseries-storage"
export { PgWebhookDeliveryStorage } from "./pg-webhook-delivery-storage"
export { PgWebhookRunStorage } from "./pg-webhook-run-storage"
export { PgWorkflowInterventionStorage } from "./pg-workflow-intervention-storage"
export { PgWorkflowNodeRunStorage, PgWorkflowRunStorage } from "./pg-workflow-run-storage"
