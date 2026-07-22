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
import { SqliteOntologyStorage, type SqliteOntologyTransactionContext } from "./ontology-storage"
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
  readonly ontology: SqliteOntologyStorage
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
  private readonly transactionScope = new AsyncLocalStorage<{ active: boolean }>()
  private transactionTail: Promise<void> = Promise.resolve()

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.path ? sqliteStoragePath(options.path) : undefined
    this.connection = openSqliteStoreConnection({ path })

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }

    const stores = createSqliteStores(this.connection, {
      runOntologyOperation: (run) => this.runRootOntologyOperation(run),
      transactionContext: null,
    })
    const lock = <T>(run: () => Promise<T> | T) => this.runRootStorageOperation(run)
    this.objects = createSqliteRootFacade(stores.objects, lock)
    this.ontology = stores.ontology
    this.auth = createSqliteRootFacade(stores.auth, lock)
    this.agents = createSqliteRootFacade(stores.agents, lock)
    this.actionRuns = createSqliteRootFacade(stores.actionRuns, lock)
    this.pipelineRuns = createSqliteRootFacade(stores.pipelineRuns, lock)
    this.timeseries = createSqliteRootFacade(stores.timeseries, lock)
    this.syncRuns = createSqliteRootFacade(stores.syncRuns, lock)
    this.projectionRuns = createSqliteRootFacade(stores.projectionRuns, lock)
    this.workflowRuns = createSqliteRootFacade(stores.workflowRuns, lock)
    this.workflowInterventions = createSqliteRootFacade(stores.workflowInterventions, lock)
    this.webhookDeliveries = createSqliteRootFacade(stores.webhookDeliveries, lock)
    this.webhookRuns = createSqliteRootFacade(stores.webhookRuns, lock)
    this.rules = createSqliteRootFacade(stores.rules, lock)
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
      const scope = { active: true }
      const transactionContext: SqliteOntologyTransactionContext = { id: {}, active: true }
      const txStorage = this.createTransactionStorage(transactionContext)
      const tx = createTransactionStorageProxy(txStorage, () => active)

      try {
        return await runImmediateTransactionAsync(this.connection.db, () =>
          this.transactionScope.run(scope, async () => {
            try {
              return await run(tx)
            } finally {
              scope.active = false
              transactionContext.active = false
              txStorage.ontology.deactivateSessions()
            }
          })
        )
      } finally {
        active = false
      }
    })
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private createTransactionStorage(
    transactionContext: SqliteOntologyTransactionContext
  ): Storage & { readonly ontology: SqliteOntologyStorage } {
    return {
      ...createSqliteStores(
        {
          db: this.connection.db,
          ownsConnection: false,
          installFreshSchema: false,
        },
        {
          runOntologyOperation: async (run) => run(),
          transactionContext,
        }
      ),
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }

  private runRootStorageOperation<T>(run: () => Promise<T> | T): Promise<T> {
    if (this.transactionScope.getStore()?.active) return Promise.resolve(run())
    return this.withTransactionLock(async () => run())
  }

  private runRootOntologyOperation<T>(run: () => Promise<T> | T): Promise<T> {
    if (this.transactionScope.getStore()?.active) return Promise.resolve(run())
    return this.withTransactionLock(() => runImmediateTransactionAsync(this.connection.db, run))
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

function createSqliteStores(
  connection: SqliteStoreConnection,
  options: {
    readonly runOntologyOperation: <T>(run: () => Promise<T> | T) => Promise<T>
    readonly transactionContext: SqliteOntologyTransactionContext | null
  }
): SqliteStoreSet {
  return {
    objects: new SqliteObjectStorage({ connection }),
    ontology: new SqliteOntologyStorage({
      db: connection.db,
      runRootOperation: options.runOntologyOperation,
      transactionContext: options.transactionContext,
    }),
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

function createSqliteRootFacade<T extends object>(
  target: T,
  runRootOperation: <TResult>(run: () => Promise<TResult> | TResult) => Promise<TResult>
): T {
  const nested = new WeakMap<object, object>()
  return new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current) as unknown
      if (typeof value === "function") {
        if (property === "close" || property === "queryCapabilities") {
          return value.bind(current)
        }
        return (...args: readonly unknown[]) =>
          runRootOperation(() => Reflect.apply(value, current, args) as unknown)
      }
      if (typeof value === "object" && value !== null) {
        const existing = nested.get(value)
        if (existing) return existing
        const facade = createSqliteRootFacade(value, runRootOperation)
        nested.set(value, facade)
        return facade
      }
      return value
    },
  })
}

interface SqliteStoreSet {
  readonly objects: SqliteObjectStorage
  readonly ontology: SqliteOntologyStorage
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
