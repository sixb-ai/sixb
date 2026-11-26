/// <reference path="./sql.d.ts" />
// Keep SQL module declarations visible to downstream workspaces that typecheck this package from
// source.

import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type {
  MigrationCapableStorage,
  Storage,
  StorageMigrator,
  StorageTransactionOptions,
} from "@sixb/core"
import { ProviderMaterializationTransactionLifecycle } from "@sixb/core/internal/ontology-storage-provider"
import {
  assertBranchNamespaceName,
  branchNamespaceExists,
  createTransactionStorageProxy,
  throwNestedStorageTransaction,
} from "@sixb/core/internal/storage"
import {
  createAgentOperationScope,
  createAuthOperationScope,
  createObjectOperationScope,
  createOntologyOperationScope,
  createOperationScopedFacade,
  createStorageOperationScope,
  createWorkflowRunOperationScope,
} from "@sixb/core/internal/storage-operation-scope"
import {
  type AiCostStorage,
  type AiLimitStorage,
  type AiUsageStorage,
  type BranchNamespace,
  type BranchNamespaceStorage,
  type ObjectQueryPreparationPlan,
  type ObjectQueryPreparationResult,
  type ObjectStorage,
  type QueryPreparationCapableStorage,
  type SnapshotLoader,
  type SnapshotLoadInput,
  type SnapshotLoadStorage,
  type SnapshotReadOptions,
  type SnapshotReadStorage,
  type SnapshotReadView,
  StorageTransactionError,
} from "@sixb/core/storage"
import { PgAgentStorage } from "./agents"
import { PgAuthStorage } from "./auth-storage"
import { PgConnectorConnectionStorage } from "./connector-connection-storage"
import { createPostgresStorageMigrators, dropSchema, quoteIdent } from "./migrations"
import { PgObjectStorage, PgSortIndexCatalog } from "./objects"
import { ensureObjectPartition } from "./objects/partitions"
import { preparePgObjectQueries } from "./objects/prepare-queries"
import { ensurePgObjectQueryIndexes, type PgObjectQueryIndex } from "./objects/query-indexes"

export type { PgObjectQueryIndex, PgObjectQueryIndexScope } from "./objects/query-indexes"

import { type PgObjectTextCountIndex, preparePgObjectTextCounts } from "./objects/text-count-index"

export type { PgObjectTextCountIndex } from "./objects/text-count-index"

import { PgOntologyStorage, type PgOntologyTransactionContext } from "./ontology-storage"
import { PgActionRunStorage } from "./pg-action-run-storage"
import { PgActivityStorage } from "./pg-activity-storage"
import { PgAiCostStorage } from "./pg-ai-cost-storage"
import { PgAiLimitStorage } from "./pg-ai-limit-storage"
import { PgAiUsageStorage } from "./pg-ai-usage-storage"
import { PgArtifactStorage } from "./pg-artifact-storage"
import { createPgClient, type ReservedSQL, type SQL, type SQLClient } from "./pg-client"
import { PgDatasetIngestStorage } from "./pg-dataset-ingest-storage"
import { PgExecutionStorage } from "./pg-execution-storage"
import { PgFileDownloadGrantStorage } from "./pg-file-download-grant-storage"
import { PgFileUploadSessionStorage } from "./pg-file-upload-session-storage"
import { PgLakeRetentionRunStorage } from "./pg-lake-retention-run-storage"
import { PgMaintenanceHeartbeatStorage } from "./pg-maintenance-heartbeat-storage"
import { PgPipelineRunStorage } from "./pg-pipeline-run-storage"
import { PgProjectionRunStorage } from "./pg-projection-run-storage"
import { PgRulesStorage } from "./pg-rules-storage"
import { PgSyncRunStorage } from "./pg-sync-run-storage"
import { PgTimeseriesStorage } from "./pg-timeseries-storage"
import { PgWebhookRunStorage } from "./pg-webhook-run-storage"
import { PgWorkflowInterventionStorage } from "./pg-workflow-intervention-storage"
import { PgWorkflowRunStorage } from "./pg-workflow-run-storage"
import { PgShareGrantStorage } from "./share-grant-storage"
import { PgShareSessionStorage } from "./share-session-storage"
import { type BranchSchemaState, PgSnapshotLoad, SNAPSHOT_LANES } from "./snapshot-load"
import { readPgLatestPoints, readPgMemberships, readPgRanges, readPgVectors } from "./snapshot-read"
import { isRetryableTransactionConflict } from "./storage-errors"
import { registerPostgresStorageTestingAdapter } from "./testing"
import {
  beginPgSnapshot,
  endPgSnapshot,
  type PgStoreClient,
  runPgTransaction,
} from "./transactions"

export interface PostgresStorageOptions {
  /**
   * Full connection string (e.g. DATABASE_URL). Takes precedence over individual fields.
   *
   * Add `sslnegotiation=direct` (with `sslmode=require`, `verify-ca` or `verify-full`) to open TLS
   * directly, as libpq does against PostgreSQL 17 or later. It saves a round trip per connection.
   * On Bun 1.4.0–1.4.2 it also avoids a bug that keeps in memory every byte read over a TLS
   * connection negotiated the classic way.
   */
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
  /** Concurrent root count/facet calculations per instance; defaults to 1. */
  maxConcurrentAggregates?: number
  /** Idle connection timeout in milliseconds. Defaults to 60000. */
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
 * Bundles Sixb storage adapters, including the AI accounting ledger, behind a shared PostgreSQL
 * connection pool (porsager `postgres`), which reliably reclaims connections under load.
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
export class PostgresStorage
  implements
    MigrationCapableStorage,
    QueryPreparationCapableStorage,
    SnapshotReadStorage,
    SnapshotLoadStorage,
    BranchNamespaceStorage
{
  readonly objects: ObjectStorage
  readonly ontology: PgOntologyStorage
  readonly auth: PgAuthStorage
  readonly executions: PgExecutionStorage
  readonly agents: PgAgentStorage
  readonly artifacts: PgArtifactStorage
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
  readonly aiLimits: AiLimitStorage
  readonly actionRuns: PgActionRunStorage
  readonly pipelineRuns: PgPipelineRunStorage
  readonly workflowRuns: PgWorkflowRunStorage
  readonly workflowInterventions: PgWorkflowInterventionStorage
  readonly syncRuns: PgSyncRunStorage
  readonly projectionRuns: PgProjectionRunStorage
  readonly timeseries: Storage["timeseries"]
  readonly webhookRuns: PgWebhookRunStorage
  readonly rules: PgRulesStorage
  readonly connectorConnections: PgConnectorConnectionStorage
  readonly shareGrants: PgShareGrantStorage
  readonly shareSessions: PgShareSessionStorage
  readonly fileUploadSessions: PgFileUploadSessionStorage
  readonly datasetIngest: PgDatasetIngestStorage
  readonly fileDownloadGrants: PgFileDownloadGrantStorage
  readonly activity: PgActivityStorage
  readonly maintenanceHeartbeats: PgMaintenanceHeartbeatStorage
  readonly lakeRetentionRuns: PgLakeRetentionRunStorage
  readonly migrators: readonly StorageMigrator[]

  private readonly sql: SQL
  private readonly options: PostgresStorageOptions
  private readonly schemaName: string
  /** Branch schemas opened through this storage, closed with it. */
  private readonly branches = new Map<string, PostgresStorage>()
  /** Set on a branch namespace's storage: the only kind a snapshot loads into. */
  private branchName: string | undefined
  private readonly shutdownTimeoutSeconds: number
  private readonly transactionScope = new AsyncLocalStorage<boolean>()
  private readonly sortIndexes = new PgSortIndexCatalog()

  constructor(options: PostgresStorageOptions) {
    if (
      options.maxConcurrentAggregates !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrentAggregates) ||
        options.maxConcurrentAggregates < 1)
    )
      throw new Error("[SixbPg] maxConcurrentAggregates must be a positive integer")
    this.options = options
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
    const stores = createPostgresStores(this.sql, {
      sortIndexes: this.sortIndexes,
      maxConcurrentAggregates: options.maxConcurrentAggregates,
      runOntologyOperation: (run) => runPgTransaction(this.sql, run),
      transactionContext: null,
    })
    const scope = createStorageOperationScope(
      async (run) => {
        this.assertRootOperationAvailable()
        return run()
      },
      () => this.assertRootOperationAvailable()
    )
    this.objects = createObjectOperationScope(stores.objects, scope)
    this.ontology = createOntologyOperationScope(stores.ontology, scope)
    this.auth = createAuthOperationScope(stores.auth, scope)
    this.executions = createOperationScopedFacade(stores.executions, scope)
    this.agents = createAgentOperationScope(stores.agents, scope)
    this.artifacts = createOperationScopedFacade(stores.artifacts, scope)
    this.aiUsage = createOperationScopedFacade(stores.aiUsage, scope)
    this.aiCosts = createOperationScopedFacade(stores.aiCosts, scope)
    this.aiLimits = createOperationScopedFacade(stores.aiLimits, scope)
    this.actionRuns = createOperationScopedFacade(stores.actionRuns, scope)
    this.pipelineRuns = createOperationScopedFacade(stores.pipelineRuns, scope)
    this.workflowRuns = createWorkflowRunOperationScope(stores.workflowRuns, scope)
    this.workflowInterventions = createOperationScopedFacade(stores.workflowInterventions, scope)
    this.syncRuns = createOperationScopedFacade(stores.syncRuns, scope)
    this.projectionRuns = createOperationScopedFacade(stores.projectionRuns, scope)
    this.timeseries = createOperationScopedFacade(stores.timeseries, scope)
    this.webhookRuns = createOperationScopedFacade(stores.webhookRuns, scope)
    this.rules = createOperationScopedFacade(stores.rules, scope)
    this.connectorConnections = createOperationScopedFacade(stores.connectorConnections, scope)
    this.shareGrants = createOperationScopedFacade(stores.shareGrants, scope)
    this.shareSessions = createOperationScopedFacade(stores.shareSessions, scope)
    this.fileUploadSessions = createOperationScopedFacade(stores.fileUploadSessions, scope)
    this.datasetIngest = createOperationScopedFacade(stores.datasetIngest, scope)
    this.fileDownloadGrants = createOperationScopedFacade(stores.fileDownloadGrants, scope)
    this.activity = createOperationScopedFacade(stores.activity, scope)
    this.maintenanceHeartbeats = createOperationScopedFacade(stores.maintenanceHeartbeats, scope)
    this.lakeRetentionRuns = createOperationScopedFacade(stores.lakeRetentionRuns, scope)
    registerPostgresStorageTestingAdapter(this, (durationMs) =>
      stores.connectorConnections.advanceTimeForTesting(durationMs)
    )
  }

  async ping(): Promise<void> {
    this.assertRootOperationAvailable()
    await this.sql`SELECT 1`
  }

  async transaction<T>(
    run: (tx: Storage) => Promise<T> | T,
    options: StorageTransactionOptions = {}
  ): Promise<T> {
    if (this.transactionScope.getStore()) {
      throwNestedStorageTransaction()
    }

    try {
      return await runPgTransaction(
        this.sql,
        async (client) => {
          let active = true
          const transactionContext: PgOntologyTransactionContext = {
            id: {},
            materializations: new ProviderMaterializationTransactionLifecycle(),
            active: true,
          }
          const txStorage = this.createTransactionStorage(client, transactionContext)
          const tx = createTransactionStorageProxy(txStorage, () => active)

          try {
            const result = await this.transactionScope.run(true, () => run(tx))
            transactionContext.materializations.assertCommittable()
            return result
          } finally {
            await txStorage.aiLimits.settleOperations()
            transactionContext.active = false
            txStorage.ontology.deactivateSessions()
            transactionContext.materializations.deactivate()
            active = false
          }
        },
        { isolation: options.isolation === "serializable" ? "serializable" : undefined }
      )
    } catch (error) {
      if (isRetryableTransactionConflict(error)) {
        throw new StorageTransactionError(
          "[SixbPg] Storage transaction failed due to a serialization conflict or deadlock and may be retried.",
          { cause: error, code: "serialization_failure" }
        )
      }
      throw error
    }
  }

  async prepareObjectQueries(
    plan: ObjectQueryPreparationPlan
  ): Promise<ObjectQueryPreparationResult> {
    this.assertRootOperationAvailable()
    try {
      return await preparePgObjectQueries(this.sql, this.schemaName, plan)
    } finally {
      this.sortIndexes.invalidate()
    }
  }

  /** Build workload-specific indexes concurrently, after migrations, outside transactions. */
  async ensureObjectQueryIndexes(
    indexes: readonly PgObjectQueryIndex[]
  ): Promise<readonly string[]> {
    this.assertRootOperationAvailable()
    try {
      return await ensurePgObjectQueryIndexes(this.sql, this.schemaName, indexes)
    } finally {
      // Even a build that failed partway may have created some of them.
      this.sortIndexes.invalidate()
    }
  }

  /** Offline maintenance: STORED columns rewrite the objects table before concurrent index builds. */
  async prepareObjectTextCounts(
    indexes: readonly PgObjectTextCountIndex[]
  ): Promise<readonly string[]> {
    this.assertRootOperationAvailable()
    return preparePgObjectTextCounts(this.sql, this.schemaName, indexes)
  }

  private assertRootOperationAvailable(): void {
    if (!this.transactionScope.getStore()) return
    throw new StorageTransactionError(
      "[SixbPg] Root storage cannot be used inside a transaction callback; use the provided tx storage."
    )
  }

  /**
   * Close the connection pool. Should be called on shutdown.
   *
   * Stops accepting new queries and waits up to `shutdownTimeoutMillis` for in-flight
   * queries to finish before destroying connections.
   */
  async close(): Promise<void> {
    await Promise.all([...this.branches.values()].map((branch) => branch.close()))
    this.branches.clear()
    await this.sql.end({ timeout: this.shutdownTimeoutSeconds })
  }

  /**
   * Views on connections of their own, each in a `REPEATABLE READ READ ONLY` transaction on the
   * snapshot the first one exports, so they read in parallel and all see one state. They take at
   * most half the pool, leaving the rest to the project's own work. Each transaction is bounded
   * on the server too: by `transaction_timeout` on PostgreSQL 17 and later, by the statement and
   * idle timeouts before.
   */
  async readSnapshot<T>(
    options: SnapshotReadOptions,
    run: (views: readonly SnapshotReadView[]) => Promise<T>
  ): Promise<T> {
    this.assertRootOperationAvailable()
    const count = Math.max(1, Math.min(options.views, Math.floor((this.options.max ?? 10) / 2)))
    const connections: ReservedSQL[] = []
    const open: ReservedSQL[] = []

    try {
      let snapshotId: string | undefined
      for (let index = 0; index < count; index += 1) {
        const connection = await this.sql.reserve()
        connections.push(connection)
        open.push(connection)
        snapshotId = await beginPgSnapshot(connection, {
          maxDurationMs: options.maxDurationMs,
          ...(snapshotId === undefined ? {} : { snapshotId }),
        })
      }

      return await run(connections.map((connection) => this.snapshotView(connection)))
    } finally {
      for (const connection of open) await endPgSnapshot(connection).catch(() => undefined)
      for (const connection of connections) connection.release()
    }
  }

  private snapshotView(connection: ReservedSQL): SnapshotReadView {
    return {
      storage: this.createTransactionStorage(connection, {
        id: {},
        materializations: new ProviderMaterializationTransactionLifecycle(),
        active: true,
      }),
      readVectors: ({ projectId, refs }) => readPgVectors(connection, projectId, refs),
      readLatestPoints: (input) => readPgLatestPoints(connection, input),
      readMemberships: ({ projectId }) => readPgMemberships(connection, projectId),
      readRanges: (input) => readPgRanges(connection, input),
    }
  }

  /**
   * Load into this branch schema, and only into one: the load empties the tables it fills. Each
   * type's partition is created first, then the tables load in parallel lanes, one connection
   * and transaction each, on at most half the pool; see `PgSnapshotLoad`. One load at a time.
   */
  async loadSnapshot<T>(
    input: SnapshotLoadInput,
    run: (loader: SnapshotLoader) => Promise<T>
  ): Promise<T> {
    this.assertRootOperationAvailable()
    const branch = this.branchName
    if (branch === undefined) {
      throw new Error(
        "[SixbPg] A snapshot loads into a branch namespace only: create one with createBranchNamespace, then load into it."
      )
    }

    const count = Math.max(1, Math.min(SNAPSHOT_LANES, Math.floor((this.options.max ?? 10) / 2)))
    const connections: ReservedSQL[] = []
    let locked = false

    try {
      for (let index = 0; index < count; index += 1) connections.push(await this.sql.reserve())
      const first = connections[0]!

      const [lock] = await first<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${`${this.schemaName}:snapshot-load`})) AS locked
      `
      locked = lock?.locked === true
      if (!locked) {
        throw new Error(
          `[SixbPg] Branch namespace '${branch}' is loading a snapshot already: wait for that load to end.`
        )
      }

      for (const objectTypeId of input.objectTypeIds) {
        await ensureObjectPartition(first, this.schemaName, objectTypeId)
      }

      return await PgSnapshotLoad.run(connections, input, { sixbBranch: branch }, (load) =>
        run({ write: (batch) => load.write(batch) })
      )
    } finally {
      if (locked) {
        await connections[0]!`
          SELECT pg_advisory_unlock(hashtext(${`${this.schemaName}:snapshot-load`}))
        `.catch(() => undefined)
      }
      for (const connection of connections) connection.release()
    }
  }

  /** A schema of its own, migrated and ready to load a snapshot into. */
  async createBranchNamespace(name: string): Promise<BranchNamespace> {
    assertBranchNamespaceName(name)
    const schema = this.branchSchemaName(name)

    // Creating the schema is the check: two callers cannot both create it.
    try {
      await runPgTransaction(this.sql, async (tx) => {
        await tx.unsafe(`CREATE SCHEMA ${quoteIdent(schema)}`)
        await tx.unsafe(
          `COMMENT ON SCHEMA ${quoteIdent(schema)} IS '${JSON.stringify({ sixbBranch: name })}'`
        )
      })
    } catch (error) {
      if (isDuplicateSchema(error)) throw branchNamespaceExists(name)
      throw error
    }

    return this.openBranch(name)
  }

  async openBranchNamespace(name: string): Promise<BranchNamespace | null> {
    assertBranchNamespaceName(name)
    const state = await this.branchSchemaState(name)
    if (!state) return null

    if (state.loading) {
      throw new Error(
        `[SixbPg] Branch namespace '${name}' stopped while a snapshot was loading into it: drop it and load the snapshot again.`
      )
    }
    return this.openBranch(name)
  }

  async listBranchNamespaces(): Promise<readonly string[]> {
    const rows = await this.sql<{ comment: string | null }[]>`
      SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace
      WHERE starts_with(nspname, ${this.branchSchemaPrefix()})
    `
    return rows
      .flatMap((row) => {
        const state = parseBranchState(row.comment)
        return state ? [state.sixbBranch] : []
      })
      .sort()
  }

  /** Drop the branch's schema and everything in it. */
  async dropBranchNamespace(name: string): Promise<void> {
    assertBranchNamespaceName(name)
    await this.branches.get(name)?.close()
    this.branches.delete(name)

    await this.sql.unsafe(
      `DROP SCHEMA IF EXISTS ${quoteIdent(this.branchSchemaName(name))} CASCADE`
    )
  }

  private async openBranch(name: string): Promise<PostgresStorage> {
    const opened = this.branches.get(name)
    if (opened) return opened

    const branch = new PostgresStorage({ ...this.options, schemaName: this.branchSchemaName(name) })
    branch.branchName = name
    for (const migrator of branch.migrators) await migrator.migrate()

    this.branches.set(name, branch)
    return branch
  }

  private branchSchemaPrefix(): string {
    return `${this.schemaName}_branch_`
  }

  /**
   * `<schema>_branch_<name>`, dashes as underscores. PostgreSQL cuts a name at 63 bytes, so a
   * longer one keeps a prefix and a hash of the branch's name: two names never share a schema.
   */
  private branchSchemaName(name: string): string {
    const full = `${this.branchSchemaPrefix()}${name.replaceAll("-", "_")}`
    if (Buffer.byteLength(full) <= MAX_IDENTIFIER_BYTES) return full

    const hash = createHash("sha256").update(name).digest("hex").slice(0, 12)
    const kept = Buffer.from(full).subarray(0, MAX_IDENTIFIER_BYTES - hash.length - 1)
    return `${kept.toString("utf8").replace(/\uFFFD$/, "")}_${hash}`
  }

  /** The schema's state, read from its comment; null when the schema is not this branch's. */
  private async branchSchemaState(name: string): Promise<BranchSchemaState | null> {
    const [row] = await this.sql<{ comment: string | null }[]>`
      SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace
      WHERE nspname = ${this.branchSchemaName(name)}
    `
    if (!row) return null

    const state = parseBranchState(row.comment)
    if (state?.sixbBranch !== name) {
      throw new Error(
        `[SixbPg] Schema '${this.branchSchemaName(name)}' exists but is not branch namespace '${name}': drop it or choose another name.`
      )
    }
    return state
  }

  /**
   * Drop all Sixb tables and schema. Useful for test cleanup.
   * WARNING: This permanently deletes all data.
   */
  async dropSchema(): Promise<void> {
    await dropSchema(this.sql, this.schemaName)
  }

  private createTransactionStorage(
    client: PgStoreClient,
    transactionContext: PgOntologyTransactionContext
  ): Storage & { readonly ontology: PgOntologyStorage; readonly aiLimits: PgAiLimitStorage } {
    return {
      ...createPostgresStores(client, {
        sortIndexes: this.sortIndexes,
        runOntologyOperation: async (run) => run(client),
        transactionContext,
      }),
      ping: async () => {
        await client`SELECT 1`
      },
      transaction: async <T>(): Promise<T> => {
        throwNestedStorageTransaction()
      },
    }
  }
}

function createPostgresStores(
  sql: PgStoreClient,
  options: {
    readonly runOntologyOperation: <T>(run: (sql: SQLClient) => Promise<T>) => Promise<T>
    readonly transactionContext: PgOntologyTransactionContext | null
    readonly sortIndexes: PgSortIndexCatalog
    readonly maxConcurrentAggregates?: number
  }
): PostgresStoreSet {
  const auth = new PgAuthStorage({ sql })
  const shareGrants = new PgShareGrantStorage(sql)
  const shareSessions = new PgShareSessionStorage(sql)
  const executions = new PgExecutionStorage(sql, auth, shareSessions)
  return {
    objects: new PgObjectStorage(sql, options.sortIndexes, options.maxConcurrentAggregates),
    ontology: new PgOntologyStorage({
      sql,
      runRootOperation: options.runOntologyOperation,
      transactionContext: options.transactionContext,
    }),
    auth,
    executions,
    agents: new PgAgentStorage({ sql, executions }),
    artifacts: new PgArtifactStorage(sql),
    aiUsage: new PgAiUsageStorage(sql),
    aiCosts: new PgAiCostStorage(sql),
    aiLimits: new PgAiLimitStorage(sql),
    actionRuns: new PgActionRunStorage(sql, executions),
    pipelineRuns: new PgPipelineRunStorage(sql, executions),
    workflowRuns: new PgWorkflowRunStorage(sql, executions),
    workflowInterventions: new PgWorkflowInterventionStorage(sql),
    syncRuns: new PgSyncRunStorage(sql, executions),
    projectionRuns: new PgProjectionRunStorage(sql, executions),
    timeseries: new PgTimeseriesStorage(sql),
    webhookRuns: new PgWebhookRunStorage(sql, executions),
    rules: new PgRulesStorage(sql),
    connectorConnections: new PgConnectorConnectionStorage(sql),
    shareGrants,
    shareSessions,
    fileUploadSessions: new PgFileUploadSessionStorage(sql),
    datasetIngest: new PgDatasetIngestStorage(sql),
    fileDownloadGrants: new PgFileDownloadGrantStorage(sql),
    activity: new PgActivityStorage(sql),
    maintenanceHeartbeats: new PgMaintenanceHeartbeatStorage(sql),
    lakeRetentionRuns: new PgLakeRetentionRunStorage(sql),
  }
}

interface PostgresStoreSet {
  readonly objects: PgObjectStorage
  readonly ontology: PgOntologyStorage
  readonly auth: PgAuthStorage
  readonly executions: PgExecutionStorage
  readonly agents: PgAgentStorage
  readonly artifacts: PgArtifactStorage
  readonly aiUsage: PgAiUsageStorage
  readonly aiCosts: PgAiCostStorage
  readonly aiLimits: PgAiLimitStorage
  readonly actionRuns: PgActionRunStorage
  readonly pipelineRuns: PgPipelineRunStorage
  readonly workflowRuns: PgWorkflowRunStorage
  readonly workflowInterventions: PgWorkflowInterventionStorage
  readonly syncRuns: PgSyncRunStorage
  readonly projectionRuns: PgProjectionRunStorage
  readonly timeseries: PgTimeseriesStorage
  readonly webhookRuns: PgWebhookRunStorage
  readonly rules: PgRulesStorage
  readonly connectorConnections: PgConnectorConnectionStorage
  readonly shareGrants: PgShareGrantStorage
  readonly shareSessions: PgShareSessionStorage
  readonly fileUploadSessions: PgFileUploadSessionStorage
  readonly datasetIngest: PgDatasetIngestStorage
  readonly fileDownloadGrants: PgFileDownloadGrantStorage
  readonly activity: PgActivityStorage
  readonly maintenanceHeartbeats: PgMaintenanceHeartbeatStorage
  readonly lakeRetentionRuns: PgLakeRetentionRunStorage
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

const MAX_IDENTIFIER_BYTES = 63

function parseBranchState(comment: string | null): BranchSchemaState | null {
  if (!comment) return null
  try {
    const state = JSON.parse(comment) as unknown
    if (typeof state === "object" && state !== null && "sixbBranch" in state) {
      return state as BranchSchemaState
    }
  } catch {
    return null
  }
  return null
}

function isDuplicateSchema(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P06"
}

export { migratePostgresStorage } from "./migrations"
