import type { DatasetDefinition } from "@sixb/core"
import type { DuckLakeStorageOptions } from "../types"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { type DatasetTableRef, resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import {
  type DuckLakeTableStorage,
  partitionWarnings,
  REWRITE_DELETED_SHARE,
  readTableStorage,
  SMALL_FILE_BYTES,
  tableRowCount,
} from "./ducklake-storage-stats"
import { CatalogMovedError, commitVersionTransaction } from "./ducklake-version-transaction"
import { encodeDatasetSequenceTableName } from "./names"
import { duckLakeAlias, quoteIdentifier, quoteSqlString } from "./sql"

/**
 * A dataset's thresholds are checked after its first commit in this provider, then after every
 * this many: one catalog read for several commits, while a webhook dataset taking a commit a
 * second is checked every few seconds.
 */
const CHECK_EVERY_COMMITS = 8

/** Inlined rows a dataset's tables may hold in the catalog before a flush moves them to a file. */
const FLUSH_INLINED_ROWS = 1_000

/** Small files a dataset's tables may hold before they are merged. */
const MERGE_SMALL_FILES = 16

/** Most files one merge reads, so that one pass, and the commits waiting behind it, stay short. */
const MERGE_MAX_FILES = 256

/**
 * DuckLake commits a transaction on top of non-conflicting commits that landed since it began,
 * waiting before each retry: 10 retries and about 11 s of waiting by default, while this
 * provider's connection waits too. Compaction retries 3 times, about half a second. A conflict
 * fails at once whatever the count, and the compaction yields to the write.
 */
const COMPACTION_COMMIT_RETRIES = 3

interface DatasetCompactionState {
  /** Commits since the last pass began, counting from the first commit's check. */
  commitsSinceCheck: number
  running: Promise<void> | undefined
  dirty: boolean
}

interface CompactionPlan {
  readonly table: DatasetTableRef
  readonly flush: boolean
  readonly compact: boolean
}

/** Datasets whose partitioning this process has warned about. */
const warnedPartitionedDatasets = new Set<string>()

/**
 * Compacts a dataset's storage after the writes that need it, in the process that wrote.
 *
 * A commit only schedules the work: the version is committed and returned first, and a failure
 * never reaches the write. One compaction runs per dataset at a time; a commit arriving meanwhile
 * marks it for one more pass. A pass that crosses no threshold changes nothing. Otherwise it
 * flushes inlined rows to a file, then rewrites the files whose deleted rows reached
 * `REWRITE_DELETED_SHARE` and merges small files, as two maintenance commits, which are never
 * dataset versions (see `parseTableDataChange`). Time travel to a retained version reads the same
 * rows after them.
 *
 * Each commit takes the catalog commit lock, as writes do, and a merge reads at most
 * `MERGE_MAX_FILES` files, so writes in this process wait one short commit at most; a backlog
 * takes several passes. A compaction that conflicts with another process's write yields: the
 * next check tries again.
 */
export class DuckLakeCompaction {
  private readonly datasets = new Map<string, DatasetCompactionState>()
  private closing = false

  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly withCommitRuntime: <T>(
      run: (runtime: DuckDbQueryRuntime) => Promise<T>
    ) => Promise<T>
  ) {}

  /** Schedules a check of the dataset after a commit that created a version. Never waits. */
  afterCommit(dataset: DatasetDefinition): void {
    if (this.closing) {
      return
    }

    let state = this.datasets.get(dataset.id)
    if (state === undefined) {
      state = { commitsSinceCheck: CHECK_EVERY_COMMITS - 1, running: undefined, dirty: false }
      this.datasets.set(dataset.id, state)
    }

    if (state.running !== undefined) {
      state.dirty = true
      return
    }

    state.commitsSinceCheck++
    if (state.commitsSinceCheck < CHECK_EVERY_COMMITS) {
      return
    }

    const running = this.run(dataset, state).finally(() => {
      state.running = undefined
    })
    state.running = running
  }

  /** Every compaction in flight finishes its current pass, and none starts another. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.datasets.values()].map((state) => state.running))
  }

  private async run(dataset: DatasetDefinition, state: DatasetCompactionState): Promise<void> {
    try {
      while (!this.closing) {
        // Each pass is a check, and sees every commit made before it starts.
        state.commitsSinceCheck = 0
        state.dirty = false
        const progressed = await this.compactOnce(dataset)

        if (!progressed && !state.dirty) {
          return
        }
      }
    } catch (error) {
      if (error instanceof CatalogMovedError) {
        return
      }

      console.warn(
        `[SixbDuckLake] Automatic compaction of dataset '${dataset.id}' failed. Its writes are unaffected; a later commit tries again.`,
        error
      )
    }
  }

  /** One pass: whether it moved any row or file. */
  private async compactOnce(dataset: DatasetDefinition): Promise<boolean> {
    const plan = await this.plan(dataset)
    if (plan === null) {
      return false
    }

    let progressed = false
    if (plan.flush) {
      progressed = await this.commitMaintenance(dataset, this.flushCalls(plan.table))
    }

    if (plan.compact) {
      progressed =
        (await this.commitMaintenance(dataset, this.compactCalls(plan.table))) || progressed
    }

    return progressed
  }

  private async plan(dataset: DatasetDefinition): Promise<CompactionPlan | null> {
    const found = await this.connections.withAttachedRuntime(async (runtime) => {
      const table = await resolveDatasetTableRef(this.options, runtime, dataset.id)
      return table === null
        ? null
        : { table, storage: await readTableStorage(this.options, runtime, [table]) }
    })
    if (found === null) {
      return null
    }

    const tables = [...found.storage.values()]
    const main = found.storage.get(found.table.tableId)
    this.warnIfPartitionedSmall(dataset, main)

    const sum = (count: (storage: DuckLakeTableStorage) => number) =>
      tables.reduce((total, storage) => total + count(storage), 0)

    const flush = sum((storage) => storage.inlinedRows) >= FLUSH_INLINED_ROWS
    const compact =
      sum((storage) => storage.filesToRewrite) > 0 ||
      sum((storage) => storage.smallDataFiles) >= MERGE_SMALL_FILES

    return flush || compact ? { table: found.table, flush, compact } : null
  }

  private flushCalls(table: DatasetTableRef): readonly string[] {
    return this.tableNames(table).map(
      (name) =>
        `CALL ducklake_flush_inlined_data(${this.aliasSql()}, table_name => ${quoteSqlString(name)})`
    )
  }

  /** Rewrites the files carrying enough deletes first: DuckLake merges no file with deletes. */
  private compactCalls(table: DatasetTableRef): readonly string[] {
    return this.tableNames(table).flatMap((name) => [
      `CALL ducklake_rewrite_data_files(${this.aliasSql()}, ${quoteSqlString(name)}, delete_threshold => ${REWRITE_DELETED_SHARE})`,
      `CALL ducklake_merge_adjacent_files(${this.aliasSql()}, ${quoteSqlString(name)}, max_file_size => ${SMALL_FILE_BYTES}, max_compacted_files => ${MERGE_MAX_FILES})`,
    ])
  }

  /**
   * Runs DuckLake maintenance calls as one commit, and says whether they moved anything. DuckLake
   * refuses to flush and compact in one transaction, hence two commits per pass.
   */
  private async commitMaintenance(
    dataset: DatasetDefinition,
    calls: readonly string[]
  ): Promise<boolean> {
    return this.withCommitRuntime(async (runtime) => {
      let moved = false
      let committed = false

      await runtime.run("BEGIN TRANSACTION")
      try {
        await runtime.run(
          `CALL ${quoteIdentifier(duckLakeAlias(this.options))}.set_commit_message(${quoteSqlString("Sixb")}, ${quoteSqlString(`compact dataset ${dataset.id}`)})`
        )

        for (const call of calls) {
          moved = (await runtime.query(call)).some(movedAnything) || moved
        }

        await this.commit(runtime, dataset)
        committed = true
      } catch (error) {
        await runtime.run("ROLLBACK").catch(() => {
          // The commit may already have closed the transaction; keep its error.
        })
        throw error
      } finally {
        if (committed && moved) {
          await this.connections.detachLocalCatalogAfterCommit(runtime)
        }
      }

      return moved
    })
  }

  private async commit(runtime: DuckDbQueryRuntime, dataset: DatasetDefinition): Promise<void> {
    await runtime.run(`SET ducklake_max_retry_count = ${COMPACTION_COMMIT_RETRIES}`)
    try {
      await commitVersionTransaction(runtime, dataset.id)
    } finally {
      await runtime.run("RESET ducklake_max_retry_count").catch(() => {
        // Session state on a shared connection: never reuse it with the setting changed.
        this.connections.poisonRuntime()
      })
    }
  }

  /** Warns once per process about a partitioned dataset too small for partitioning to pay. */
  private warnIfPartitionedSmall(
    dataset: DatasetDefinition,
    main: DuckLakeTableStorage | undefined
  ): void {
    if (warnedPartitionedDatasets.has(dataset.id) || main === undefined) {
      return
    }

    const [warning] = partitionWarnings(dataset, tableRowCount(main))
    if (warning !== undefined) {
      warnedPartitionedDatasets.add(dataset.id)
      console.warn(`[SixbDuckLake] ${warning.message}`)
    }
  }

  private tableNames(table: DatasetTableRef): readonly string[] {
    return table.sequenceTableId === undefined
      ? [table.tableName]
      : [table.tableName, encodeDatasetSequenceTableName(table.datasetId)]
  }

  private aliasSql(): string {
    return quoteSqlString(duckLakeAlias(this.options))
  }
}

/** Whether a DuckLake maintenance call's result row reports moved rows or files. */
function movedAnything(row: Readonly<Record<string, unknown>>): boolean {
  return ["rows_flushed", "files_processed"].some((key) => {
    const value = row[key]
    return value !== null && value !== undefined && Number(value) > 0
  })
}
