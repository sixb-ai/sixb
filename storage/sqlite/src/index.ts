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
import { ProviderMaterializationTransactionLifecycle } from "@sixb/core/internal/ontology-storage-provider"
import {
  createAgentOperationScope,
  createAuthOperationScope,
  createOntologyOperationScope,
  createOperationScopedFacade,
  createStorageOperationScope,
  createWorkflowRunOperationScope,
} from "@sixb/core/internal/storage-operation-scope"
import {
  createTransactionStorageProxy,
  StorageTransactionError,
  throwNestedStorageTransaction,
} from "@sixb/core/storage"
import { SqliteActionRunStorage } from "./action-run-storage"
import { SqliteAgentStorage } from "./agents"
import { SqliteAuthStorage } from "./auth-storage"
import { SqliteExecutionStorage } from "./execution-storage"
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
 * Bundles object, timeseries, auth, execution, sync run, pipeline run, projection run, workflow
 * run, webhook run, and webhook delivery storage backed by SQLite.
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
  readonly objects: Storage["objects"]
  readonly ontology: SqliteOntologyStorage
  readonly auth: SqliteAuthStorage
  readonly executions: SqliteExecutionStorage
  readonly agents: SqliteAgentStorage
  readonly actionRuns: SqliteActionRunStorage
  readonly pipelineRuns: SqlitePipelineRunStorage
  readonly syncRuns: SqliteSyncRunStorage
  readonly projectionRuns: SqliteProjectionRunStorage
  readonly workflowRuns: SqliteWorkflowRunStorage
  readonly workflowInterventions: SqliteWorkflowInterventionStorage
  readonly timeseries: Storage["timeseries"]
  readonly webhookDeliveries: SqliteWebhookDeliveryStorage
  readonly webhookRuns: SqliteWebhookRunStorage
  readonly rules: SqliteRulesStorage
  readonly migrators: readonly StorageMigrator[]

  private readonly connection: SqliteStoreConnection
  private readonly readConnection: SqliteStoreConnection
  private readonly transactionScope = new AsyncLocalStorage<{ active: boolean }>()
  private transactionTail: Promise<void> = Promise.resolve()

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.path ? sqliteStoragePath(options.path) : undefined
    this.connection = openSqliteStoreConnection({ path })
    if (path) {
      this.connection.db.run("PRAGMA journal_mode = WAL")
      this.readConnection = openSqliteStoreConnection({ path, readonly: true })
    } else {
      this.readConnection = this.connection
    }

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.connection.db)
    }

    const stores = createSqliteStores(this.connection, {
      runOntologyOperation: async (run) => run(),
      transactionContext: null,
    })
    const assertRootOperationAvailable = () => this.assertRootOperationAvailable()
    const scope = createStorageOperationScope(
      (run) => this.runRootStorageOperation(run),
      assertRootOperationAvailable
    )
    const ontologyScope = createStorageOperationScope(
      (run) => this.runRootOntologyOperation(run),
      assertRootOperationAvailable
    )
    const readScope = path
      ? createStorageOperationScope(async (run) => {
          this.assertRootOperationAvailable()
          return run()
        }, assertRootOperationAvailable)
      : scope
    const readObjects = path
      ? new SqliteObjectStorage({ connection: this.readConnection })
      : stores.objects
    const readTimeseries = path
      ? new SqliteTimeseriesStorage({ connection: this.readConnection })
      : stores.timeseries
    this.objects = createOperationScopedFacade(readObjects, readScope)
    this.ontology = createOntologyOperationScope(stores.ontology, ontologyScope)
    this.auth = createAuthOperationScope(stores.auth, scope)
    this.executions = createOperationScopedFacade(stores.executions, scope)
    this.agents = createAgentOperationScope(stores.agents, scope)
    this.actionRuns = createOperationScopedFacade(stores.actionRuns, scope)
    this.pipelineRuns = createOperationScopedFacade(stores.pipelineRuns, scope)
    this.timeseries = createOperationScopedFacade(readTimeseries, readScope)
    this.syncRuns = createOperationScopedFacade(stores.syncRuns, scope)
    this.projectionRuns = createOperationScopedFacade(stores.projectionRuns, scope)
    this.workflowRuns = createWorkflowRunOperationScope(stores.workflowRuns, scope)
    this.workflowInterventions = createOperationScopedFacade(stores.workflowInterventions, scope)
    this.webhookDeliveries = createOperationScopedFacade(stores.webhookDeliveries, scope)
    this.webhookRuns = createOperationScopedFacade(stores.webhookRuns, scope)
    this.rules = createOperationScopedFacade(stores.rules, scope)
    this.migrators = options.path ? createSqliteStorageMigrators(options.path) : []
  }

  async ping(): Promise<void> {
    this.assertRootOperationAvailable()
    if (this.readConnection !== this.connection) {
      this.readConnection.db.query("SELECT 1").get()
      return
    }
    await this.runRootStorageOperation(() => {
      this.connection.db.query("SELECT 1").get()
    })
  }

  /**
   * The `isolation` option is intentionally ignored. SQLite runs every write transaction through
   * one connection serialized by {@link withTransactionLock} and a `BEGIN IMMEDIATE`, so there is no
   * concurrent writer to isolate against. File-backed object and timeseries reads use a separate WAL
   * snapshot connection; Postgres is where `isolation: "serializable"` maps to a real isolation level.
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
      const transactionContext: SqliteOntologyTransactionContext = {
        id: {},
        materializations: new ProviderMaterializationTransactionLifecycle(),
        active: true,
      }
      const txStorage = this.createTransactionStorage(transactionContext)
      const tx = createTransactionStorageProxy(txStorage, () => active)

      try {
        return await runImmediateTransactionAsync(this.connection.db, () =>
          this.transactionScope.run(scope, async () => {
            try {
              const result = await run(tx)
              transactionContext.materializations.assertCommittable()
              return result
            } finally {
              scope.active = false
              transactionContext.active = false
              txStorage.ontology.deactivateSessions()
              transactionContext.materializations.deactivate()
            }
          })
        )
      } finally {
        active = false
      }
    })
  }

  close(): void {
    if (this.readConnection !== this.connection) closeSqliteStoreConnection(this.readConnection)
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
      ping: async () => {
        this.connection.db.query("SELECT 1").get()
      },
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }

  private runRootStorageOperation<T>(run: () => Promise<T> | T): Promise<T> {
    this.assertRootOperationAvailable()
    return this.withTransactionLock(async () => run())
  }

  private runRootOntologyOperation<T>(run: () => Promise<T> | T): Promise<T> {
    this.assertRootOperationAvailable()
    return this.withTransactionLock(() => runImmediateTransactionAsync(this.connection.db, run))
  }

  private assertRootOperationAvailable(): void {
    if (!this.transactionScope.getStore()?.active) return
    throw new StorageTransactionError(
      "[SixbSqlite] Root storage cannot be used inside a transaction callback; use the provided tx storage."
    )
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
  const auth = new SqliteAuthStorage({ connection })
  const executions = new SqliteExecutionStorage(connection.db, auth)
  return {
    objects: new SqliteObjectStorage({ connection }),
    ontology: new SqliteOntologyStorage({
      db: connection.db,
      runRootOperation: options.runOntologyOperation,
      transactionContext: options.transactionContext,
    }),
    auth,
    executions,
    agents: new SqliteAgentStorage({ connection }),
    actionRuns: new SqliteActionRunStorage({ connection }),
    pipelineRuns: new SqlitePipelineRunStorage({ connection }),
    timeseries: new SqliteTimeseriesStorage({ connection }),
    syncRuns: new SqliteSyncRunStorage({ connection }),
    projectionRuns: new SqliteProjectionRunStorage({ connection }),
    workflowRuns: new SqliteWorkflowRunStorage({ connection, executions }),
    workflowInterventions: new SqliteWorkflowInterventionStorage({ connection }),
    webhookDeliveries: new SqliteWebhookDeliveryStorage({ connection }),
    webhookRuns: new SqliteWebhookRunStorage({ connection }),
    rules: new SqliteRulesStorage({ connection }),
  }
}

interface SqliteStoreSet {
  readonly objects: SqliteObjectStorage
  readonly ontology: SqliteOntologyStorage
  readonly auth: SqliteAuthStorage
  readonly executions: SqliteExecutionStorage
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
