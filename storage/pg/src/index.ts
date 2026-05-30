// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.
/// <reference path="./sql.d.ts" />

import type { MigrationCapableStorage, StorageMigrator } from "@pario/core"
import { SQL } from "bun"
import { createPostgresStorageMigrators, dropSchema, quoteIdent } from "./migrations"
import { PgActionRunStorage } from "./pg-action-run-storage"
import { PgAuthStorage } from "./pg-auth-storage"
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

  /** PostgreSQL schema name for all Pario tables. Defaults to 'pario'. */
  schemaName?: string

  /** SSL configuration. */
  ssl?: boolean | "require" | "prefer"
}

/**
 * PostgreSQL storage provider for Pario.
 *
 * Bundles Pario storage adapters backed by a shared PostgreSQL connection pool using Bun's
 * native SQL client.
 *
 * The storage exposes a core `StorageMigrator`. Pario CLI startup and
 * `pario db migrate` run it automatically through `migrateStorage(storage)`.
 *
 * Usage:
 * ```ts
 * const pg = new PostgresStorage({
 *   connectionString: process.env.DATABASE_URL!,
 * })
 *
 * export const pario = createPario({
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

  constructor(options: PostgresStorageOptions) {
    this.schemaName = options.schemaName ?? "pario"

    const quotedSchemaName = quoteIdent(this.schemaName)

    // Build connection URL — either from connectionString or individual fields.
    // search_path is set via PostgreSQL's standard `options` connection parameter,
    // which applies at the wire-protocol level to every connection in the pool.
    let url: URL
    if (options.connectionString) {
      url = new URL(options.connectionString)
    } else {
      const host = options.host ?? "localhost"
      const port = options.port ?? 5432
      const db = options.database ?? ""
      url = new URL(`postgres://${host}:${port}/${db}`)
      if (options.user) url.username = options.user
      if (options.password) url.password = options.password
    }

    const existingOptions = url.searchParams.get("options") ?? ""
    const searchPathOption = `-csearch_path=${quotedSchemaName}`
    url.searchParams.set(
      "options",
      existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption
    )

    const sqlOptions: Record<string, unknown> = {
      url: url.toString(),
      max: options.max ?? 10,
      idleTimeout: options.idleTimeoutMillis ? Math.round(options.idleTimeoutMillis / 1000) : 30,
    }

    if (options.ssl) {
      if (typeof options.ssl === "string") {
        sqlOptions.ssl = options.ssl
      } else {
        sqlOptions.tls = true
      }
    }

    this.sql = new SQL(sqlOptions)

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
   */
  async close(): Promise<void> {
    await this.sql.close()
  }

  /**
   * Drop all Pario tables and schema. Useful for test cleanup.
   * WARNING: This permanently deletes all data.
   */
  async dropSchema(): Promise<void> {
    await dropSchema(this.sql, this.schemaName)
  }
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
