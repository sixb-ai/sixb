// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.
/// <reference path="./sql.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks"
import {
  createTransactionStorageProxy,
  type MigrationCapableStorage,
  type Storage,
  type StorageMigrator,
  StorageTransactionError,
  type StorageTransactionOptions,
  throwNestedStorageTransaction,
} from "@sixb/core"
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
import { isSerializationFailure } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

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
  private readonly transactionScope = new AsyncLocalStorage<boolean>()

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
    const stores = createPostgresStores(this.sql)
    this.objects = stores.objects
    this.auth = stores.auth
    this.actionRuns = stores.actionRuns
    this.pipelineRuns = stores.pipelineRuns
    this.workflowRuns = stores.workflowRuns
    this.workflowInterventions = stores.workflowInterventions
    this.syncRuns = stores.syncRuns
    this.projectionRuns = stores.projectionRuns
    this.timeseries = stores.timeseries
    this.webhookDeliveries = stores.webhookDeliveries
    this.webhookRuns = stores.webhookRuns
    this.rules = stores.rules
  }

  async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    options: StorageTransactionOptions = {}
  ): Promise<T> {
    if (this.transactionScope.getStore()) {
      throwNestedStorageTransaction()
    }

    try {
      return await runPgTransaction(this.sql, async (client) => {
        if (options.isolation === "serializable") {
          await client`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`
        }

        let active = true
        const txStorage = this.createTransactionStorage(client)
        const tx = createTransactionStorageProxy(txStorage, () => active)

        try {
          return await this.transactionScope.run(true, () => run(tx))
        } finally {
          active = false
        }
      })
    } catch (error) {
      if (isSerializationFailure(error)) {
        throw new StorageTransactionError(
          "[SixbPg] Storage transaction failed due to a serialization conflict.",
          { cause: error, code: "serialization_failure" }
        )
      }
      throw error
    }
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

  private createTransactionStorage(client: PgStoreClient): Storage {
    return {
      ...createPostgresStores(client),
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }
}

function createPostgresStores(sql: PgStoreClient): PostgresStoreSet {
  return {
    objects: new PgObjectStorage(sql),
    auth: new PgAuthStorage({ sql }),
    actionRuns: new PgActionRunStorage(sql),
    pipelineRuns: new PgPipelineRunStorage(sql),
    workflowRuns: new PgWorkflowRunStorage(sql),
    workflowInterventions: new PgWorkflowInterventionStorage(sql),
    syncRuns: new PgSyncRunStorage(sql),
    projectionRuns: new PgProjectionRunStorage(sql),
    timeseries: new PgTimeseriesStorage(sql),
    webhookDeliveries: new PgWebhookDeliveryStorage(sql),
    webhookRuns: new PgWebhookRunStorage(sql),
    rules: new PgRulesStorage(sql),
  }
}

interface PostgresStoreSet {
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
