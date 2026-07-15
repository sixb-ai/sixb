// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.
/// <reference path="./sql.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks"
import type {
  MigrationCapableStorage,
  Storage,
  StorageMigrator,
  StorageTransactionOptions,
} from "@sixb/core"
import { createTransactionStorageProxy, throwNestedStorageTransaction } from "@sixb/core/storage"
import { SqliteActionRunStorage } from "./action-run-storage"
import { SqliteAgentStorage } from "./agents"
import { SqliteAuthStorage } from "./auth-storage"
import {
  createSqliteStorageMigrators,
  installFreshSqliteSchema,
  sqliteStoragePath,
} from "./migrations"
import { SqliteObjectStorage } from "./object-storage"
import { SqlitePipelineRunStorage } from "./pipeline-run-storage"
import { SqliteProjectionRunStorage } from "./projection-run-storage"
import { SqliteRulesStorage } from "./rules-storage"
import { SqliteSyncRunStorage } from "./sync-run-storage"
import { SqliteTimeseriesStorage } from "./timeseries-storage"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransactionAsync,
  type SqliteStoreConnection,
} from "./transactions"
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
  readonly agents: SqliteAgentStorage
  readonly actionRuns: SqliteActionRunStorage
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

  private readonly connection: SqliteStoreConnection
  private readonly transactionScope = new AsyncLocalStorage<boolean>()
  private transactionTail: Promise<void> = Promise.resolve()

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.path ? sqliteStoragePath(options.path) : undefined
    this.connection = openSqliteStoreConnection({ path })

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }

    const stores = createSqliteStores(this.connection)
    this.objects = stores.objects
    this.auth = stores.auth
    this.agents = stores.agents
    this.actionRuns = stores.actionRuns
    this.pipelineRuns = stores.pipelineRuns
    this.timeseries = stores.timeseries
    this.syncRuns = stores.syncRuns
    this.projectionRuns = stores.projectionRuns
    this.workflowRuns = stores.workflowRuns
    this.workflowInterventions = stores.workflowInterventions
    this.webhookDeliveries = stores.webhookDeliveries
    this.webhookRuns = stores.webhookRuns
    this.rules = stores.rules
    this.migrators = options.path ? createSqliteStorageMigrators(options.path) : []
  }

  /**
   * The `isolation` option is intentionally ignored. SQLite runs every transaction through one
   * shared connection serialized by {@link withTransactionLock} and a `BEGIN IMMEDIATE`, so there is
   * no concurrent transaction to isolate against — the lock already provides serializable semantics
   * for transaction-vs-transaction races. Postgres, which has true concurrent connections, is where
   * `isolation: "serializable"` translates to a real isolation level.
   */
  async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    _options: StorageTransactionOptions = {}
  ): Promise<T> {
    if (this.transactionScope.getStore()) {
      throwNestedStorageTransaction()
    }

    return this.withTransactionLock(async () => {
      let active = true
      const txStorage = this.createTransactionStorage()
      const tx = createTransactionStorageProxy(txStorage, () => active)

      try {
        return await runImmediateTransactionAsync(this.connection.db, () =>
          this.transactionScope.run(true, () => run(tx))
        )
      } finally {
        active = false
      }
    })
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private createTransactionStorage(): Storage {
    return {
      ...createSqliteStores({
        db: this.connection.db,
        ownsConnection: false,
        installFreshSchema: false,
      }),
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }

  private async withTransactionLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.transactionTail
    let release!: () => void
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }
}

function createSqliteStores(connection: SqliteStoreConnection): SqliteStoreSet {
  return {
    objects: new SqliteObjectStorage({ connection }),
    auth: new SqliteAuthStorage({ connection }),
    agents: new SqliteAgentStorage({ connection }),
    actionRuns: new SqliteActionRunStorage({ connection }),
    pipelineRuns: new SqlitePipelineRunStorage({ connection }),
    timeseries: new SqliteTimeseriesStorage({ connection }),
    syncRuns: new SqliteSyncRunStorage({ connection }),
    projectionRuns: new SqliteProjectionRunStorage({ connection }),
    workflowRuns: new SqliteWorkflowRunStorage({ connection }),
    workflowInterventions: new SqliteWorkflowInterventionStorage({ connection }),
    webhookDeliveries: new SqliteWebhookDeliveryStorage({ connection }),
    webhookRuns: new SqliteWebhookRunStorage({ connection }),
    rules: new SqliteRulesStorage({ connection }),
  }
}

interface SqliteStoreSet {
  readonly objects: SqliteObjectStorage
  readonly auth: SqliteAuthStorage
  readonly agents: SqliteAgentStorage
  readonly actionRuns: SqliteActionRunStorage
  readonly pipelineRuns: SqlitePipelineRunStorage
  readonly syncRuns: SqliteSyncRunStorage
  readonly projectionRuns: SqliteProjectionRunStorage
  readonly workflowRuns: SqliteWorkflowRunStorage
  readonly workflowInterventions: SqliteWorkflowInterventionStorage
  readonly timeseries: SqliteTimeseriesStorage
  readonly webhookDeliveries: SqliteWebhookDeliveryStorage
  readonly webhookRuns: SqliteWebhookRunStorage
  readonly rules: SqliteRulesStorage
}

export { migrateSqliteStorage } from "./migrations"
