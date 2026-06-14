// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.
/// <reference path="./sql.d.ts" />

import type { MigrationCapableStorage, StorageMigrator } from "@sixb/core"
import { SqliteActionRunStorage } from "./action-run-storage"
import { SqliteAuthStorage } from "./auth-storage"
import { SqliteEditStorage } from "./edit-storage"
import { createSqliteStorageMigrators, sqliteStoragePath } from "./migrations"
import { SqliteObjectStorage } from "./object-storage"
import { SqlitePipelineRunStorage } from "./pipeline-run-storage"
import { SqliteProjectionRunStorage } from "./projection-run-storage"
import { SqliteRulesStorage } from "./rules-storage"
import { SqliteSyncRunStorage } from "./sync-run-storage"
import { SqliteTimeseriesStorage } from "./timeseries-storage"
import { SqliteWebhookDeliveryStorage } from "./webhook-delivery-storage"
import { SqliteWebhookRunStorage } from "./webhook-run-storage"
import { SqliteWorkflowInterventionStorage } from "./workflow-intervention-storage"
import { SqliteWorkflowRunStorage } from "./workflow-run-storage"

export interface SqliteStorageOptions {
  /** Directory path for the SQLite storage database. */
  path?: string
}

/**
 * SQLite storage provider for Sixb.
 *
 * Bundles object, timeseries, auth, sync run, pipeline run, projection run, workflow run, webhook
 * run, and webhook delivery storage backed by SQLite.
 *
 * Usage:
 * ```ts
 * const storage = new SqliteStorage({ path: ".sixb" })
 *
 * export const sixb = createSixb({
 *   broker: new InMemoryBroker(),
 *   storage,
 * })
 * ```
 */
export class SqliteStorage implements MigrationCapableStorage {
  readonly objects: SqliteObjectStorage
  readonly auth: SqliteAuthStorage
  readonly actionRuns: SqliteActionRunStorage
  readonly edits: SqliteEditStorage
  readonly pipelineRuns: SqlitePipelineRunStorage
  readonly syncRuns: SqliteSyncRunStorage
  readonly projectionRuns: SqliteProjectionRunStorage
  readonly workflowRuns: SqliteWorkflowRunStorage
  readonly workflowInterventions: SqliteWorkflowInterventionStorage
  readonly timeseries: SqliteTimeseriesStorage
  readonly webhookDeliveries: SqliteWebhookDeliveryStorage
  readonly webhookRuns: SqliteWebhookRunStorage
  readonly rules: SqliteRulesStorage
  readonly migrators: readonly StorageMigrator[]

  constructor(options: SqliteStorageOptions = {}) {
    // The bundled stores share one file so one migrator owns the full SQLite schema.
    const path = options.path ? sqliteStoragePath(options.path) : undefined

    this.objects = new SqliteObjectStorage({
      path,
    })
    this.auth = new SqliteAuthStorage({
      path,
    })
    this.actionRuns = new SqliteActionRunStorage({
      path,
    })
    this.edits = new SqliteEditStorage({
      path,
    })
    this.pipelineRuns = new SqlitePipelineRunStorage({
      path,
    })
    this.timeseries = new SqliteTimeseriesStorage({
      path,
    })
    this.syncRuns = new SqliteSyncRunStorage({
      path,
    })
    this.projectionRuns = new SqliteProjectionRunStorage({
      path,
    })
    this.workflowRuns = new SqliteWorkflowRunStorage({
      path,
    })
    this.workflowInterventions = new SqliteWorkflowInterventionStorage({
      path,
    })
    this.webhookDeliveries = new SqliteWebhookDeliveryStorage({
      path,
    })
    this.webhookRuns = new SqliteWebhookRunStorage({
      path,
    })
    this.rules = new SqliteRulesStorage({
      path,
    })
    this.migrators = options.path ? createSqliteStorageMigrators(options.path) : []
  }
}

export type { SqliteActionRunStorageOptions } from "./action-run-storage"
export { SqliteActionRunStorage } from "./action-run-storage"
export type { SqliteAuthStorageOptions } from "./auth-storage"
export { SqliteAuthStorage } from "./auth-storage"
export type { SqliteEditStorageOptions } from "./edit-storage"
export { SqliteEditStorage } from "./edit-storage"
export {
  createSqliteMigrator,
  createSqliteStorageMigrators,
  migrateSqliteDatabase,
  migrateSqliteStorage,
  SQLITE_STORAGE_ADAPTER_ID,
  SQLITE_STORAGE_FILE,
  sqliteSql,
  sqliteStep,
  sqliteStorageMigrations,
  sqliteStoragePath,
} from "./migrations"
export type { SqliteObjectStorageOptions } from "./object-storage"
export { SqliteObjectStorage } from "./object-storage"
export type { SqlitePipelineRunStorageOptions } from "./pipeline-run-storage"
export { SqlitePipelineRunStorage } from "./pipeline-run-storage"
export type { SqliteProjectionRunStorageOptions } from "./projection-run-storage"
export { SqliteProjectionRunStorage } from "./projection-run-storage"
export type { SqliteRulesStorageOptions } from "./rules-storage"
export { SqliteRulesStorage } from "./rules-storage"
export type { SqliteSyncRunStorageOptions } from "./sync-run-storage"
export { SqliteSyncRunStorage } from "./sync-run-storage"
export type { SqliteTimeseriesStorageOptions } from "./timeseries-storage"
export { SqliteTimeseriesStorage } from "./timeseries-storage"
export type { SqliteWebhookDeliveryStorageOptions } from "./webhook-delivery-storage"
export { SqliteWebhookDeliveryStorage } from "./webhook-delivery-storage"
export type { SqliteWebhookRunStorageOptions } from "./webhook-run-storage"
export { SqliteWebhookRunStorage } from "./webhook-run-storage"
export type { SqliteWorkflowInterventionStorageOptions } from "./workflow-intervention-storage"
export { SqliteWorkflowInterventionStorage } from "./workflow-intervention-storage"
export type { SqliteWorkflowRunStorageOptions } from "./workflow-run-storage"
export { SqliteWorkflowNodeRunStorage, SqliteWorkflowRunStorage } from "./workflow-run-storage"
