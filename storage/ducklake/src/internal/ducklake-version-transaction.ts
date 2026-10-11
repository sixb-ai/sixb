import { LakeConcurrencyError, LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeCatalogOptions, DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { duckLakeAlias, quoteIdentifier } from "./sql"

/**
 * How a version transaction reruns after other writers moved the catalog under it. Of concurrent
 * commits to one claimed table, only the first commits: the others rerun, behind a winner that may
 * already be committing its next version, so rerunning at once can lose every time. Each rerun
 * after the first waits a random part (full jitter) of a window that doubles up to a cap, which
 * spreads the losers apart.
 *
 * Ten writers that kept committing to one keyed dataset on PostgreSQL needed up to 10 attempts per
 * write; rerunning at once, one of them ran out of 12. 16 attempts leave room above that, and wait
 * at most 9.3 s in all (4.6 s on average) before a writer that cannot commit fails.
 */
const VERSION_RERUNS = { maxAttempts: 16, baseDelayMillis: 10, maxDelayMillis: 1_000 } as const

/**
 * The catalog moved while a version transaction was being prepared or committed, before anything
 * was stored. Rerunning the whole transaction from a fresh read of the latest version is safe.
 */
export class CatalogMovedError extends LakeConcurrencyError {}

/** The latest version of a dataset, and the lake's snapshot it was read at. */
export interface LatestVersionAtSnapshot<T> {
  readonly snapshotId: string
  readonly latestVersion: T | null
}

export interface BeginVersionTransactionInput<T> {
  readonly options: DuckLakeStorageOptions
  readonly runtime: DuckDbQueryRuntime
  readonly datasetId: string
  readonly signal?: AbortSignal
  /**
   * Reads the latest version of the dataset, which the transaction then builds on. Its first
   * statement reads the lake's current snapshot, which fixes the transaction's snapshot.
   */
  readonly readLatestVersion: () => Promise<LatestVersionAtSnapshot<T>>
}

/**
 * Begins the transaction of a new dataset version together with a read of the latest version, so
 * what the new version derives from its parent, such as its row count or its lineage, describes
 * the parent it commits on top of, provided every version it must not build on unseen claims its
 * table (see the write coordinator).
 */
export async function beginTransactionOnLatestVersion<T>(
  input: BeginVersionTransactionInput<T>
): Promise<T | null> {
  if (!isSqliteCatalog(input.options.catalog)) {
    await input.runtime.run("BEGIN TRANSACTION")

    // DuckLake fixes a transaction's snapshot on its first read of the lake, not at BEGIN: the
    // read fixes it before it reads the latest version, so a version that claimed the table and
    // committed after that read makes this transaction conflict.
    return (await input.readLatestVersion()).latestVersion
  }

  // Direct metadata reads enlist a second SQLite transaction on the outer DuckDB connection.
  // Its read lock blocks DuckLake's own metadata connection at COMMIT. Read in autocommit,
  // then fix the transaction's DuckLake snapshot and verify nothing changed in between: the
  // read is then valid for this transaction, including null (no previous version).
  input.signal?.throwIfAborted()
  const { snapshotId, latestVersion } = await input.readLatestVersion()

  await input.runtime.run("BEGIN TRANSACTION")
  if ((await currentSnapshotId(input.options, input.runtime)) !== snapshotId) {
    await input.runtime.run("ROLLBACK")
    throw new CatalogMovedError(
      `[SixbDuckLake] Catalog changed while a write to dataset '${input.datasetId}' was prepared.`
    )
  }

  return latestVersion
}

export interface CommitOnReadSnapshot {
  /** Recycles the connection when its DuckLake retry setting cannot be restored. */
  readonly poisonRuntime: () => void
}

/**
 * Commits a version transaction. A conflict with a concurrent commit fails before DuckLake stores
 * anything, and is raised as a `CatalogMovedError` for the transaction to rerun.
 *
 * DuckLake commits on top of any snapshot committed since the transaction began that does not
 * conflict with it. With `onReadSnapshot`, the commit fails on any such snapshot instead, of this
 * dataset or not: a version that must sit on the version it read, but that inserts and deletes no
 * rows DuckLake could check, needs it.
 */
export async function commitVersionTransaction(
  runtime: DuckDbQueryRuntime,
  datasetId: string,
  onReadSnapshot?: CommitOnReadSnapshot
): Promise<void> {
  if (onReadSnapshot) {
    await runtime.run("SET ducklake_max_retry_count = 0")
  }

  try {
    await runtime.run("COMMIT")
  } catch (error) {
    throw catalogMovedError(error, datasetId) ?? error
  } finally {
    if (onReadSnapshot) {
      await runtime.run("RESET ducklake_max_retry_count").catch(() => {
        // The setting is session state on a shared connection, and the commit already succeeded
        // or failed durably: never change that outcome, but never reuse the connection either.
        onReadSnapshot.poisonRuntime()
      })
    }
  }
}

/**
 * Reruns a version transaction that the catalog moved under, before anything was stored. The
 * rerun reads the latest version again: one guarded on an expected latest version checks its guard
 * against what moved, and fails as an optimistic commit if this dataset is what moved.
 */
export async function rerunWhenCatalogMoves<T>(
  datasetId: string,
  transaction: (attempt: number) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction(attempt)
    } catch (error) {
      if (!(error instanceof CatalogMovedError)) {
        throw error
      }

      if (attempt === VERSION_RERUNS.maxAttempts) {
        throw new LakeConcurrencyError(
          `[SixbDuckLake] Concurrent writers moved the catalog during ${attempt} attempts to commit dataset '${datasetId}'. Retry the write.`,
          { cause: error }
        )
      }
    }

    await waitBeforeRerun(rerunDelayMillis(attempt), signal)
  }
}

/** The wait before the given rerun: none before the first, then full jitter on a doubling window. */
function rerunDelayMillis(rerun: number): number {
  if (rerun === 1) {
    return 0
  }

  const window = Math.min(
    VERSION_RERUNS.maxDelayMillis,
    VERSION_RERUNS.baseDelayMillis * 2 ** (rerun - 1)
  )

  return Math.random() * window
}

function waitBeforeRerun(millis: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  if (millis === 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, millis)

    signal?.addEventListener("abort", abort, { once: true })
  })
}

export function isSqliteCatalog(catalog: DuckLakeCatalogOptions): boolean {
  return (
    catalog.type === "sqlite" ||
    (catalog.type === "custom" && catalog.uri.toLowerCase().startsWith("sqlite:"))
  )
}

/**
 * DuckLake refuses a commit that conflicts with one committed since the transaction began, or that
 * exhausted its retries against concurrent commits, before it stores anything. Other errors, such
 * as a lost connection during COMMIT, are not classified: their outcome is ambiguous.
 */
function catalogMovedError(error: unknown, datasetId: string): CatalogMovedError | undefined {
  if (
    error instanceof Error &&
    error.message.startsWith(
      "TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction."
    ) &&
    (error.message.includes("Transaction conflict - ") ||
      error.message.includes("Exceeded the maximum retry count"))
  ) {
    return new CatalogMovedError(
      `[SixbDuckLake] Concurrent catalog commit for dataset '${datasetId}'.`,
      { cause: error }
    )
  }

  return undefined
}

async function currentSnapshotId(
  options: DuckLakeStorageOptions,
  runtime: DuckDbQueryRuntime
): Promise<string> {
  const [row] = await runtime.query(
    `SELECT id FROM ${quoteIdentifier(duckLakeAlias(options))}.current_snapshot()`
  )
  if (row === undefined) {
    throw new LakeStorageError("[SixbDuckLake] DuckLake did not return a current snapshot.")
  }

  return String(getBigIntLike(row, "id"))
}
