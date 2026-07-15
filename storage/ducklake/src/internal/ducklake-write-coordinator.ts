import { randomUUID } from "node:crypto"
import type { DatasetDefinition } from "@sixb/core"
import type {
  BeginDatasetWriteInput,
  DatasetVersion,
  DatasetWriteMode,
  LakeWriteSession,
} from "@sixb/core/lake-storage"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { localCatalogCoordinationKey } from "./catalog-key"
import {
  type ApplyDatasetRowsResult,
  applyDatasetRowsFromRelation,
  assertDatasetWriteMode,
  type CommitRowCount,
} from "./dataset-row-commit"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader, DuckLakeVersionSummary } from "./ducklake-snapshot-reader"
import { createDuckLakeWriteSession, type DuckLakeCommitWriteInput } from "./ducklake-write-session"
import { duckLakeAlias, duckLakeMetadataTableName, quoteIdentifier, quoteSqlString } from "./sql"
import { parseCommitMetadata, type SixbCommitMetadata } from "./versions"

export interface DuckLakeCommitDatasetVersionInput {
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly expectedLatestVersionId?: string
  readonly commitMessage: string
  readonly producer?: BeginDatasetWriteInput["producer"]
  readonly inputs?: BeginDatasetWriteInput["inputs"]
  applyChanges(
    runtime: DuckDbQueryRuntime,
    context: DuckLakeApplyChangesContext
  ): Promise<ApplyDatasetRowsResult>
}

interface DuckLakeCommitDatasetVersionRuntimeInput extends DuckLakeCommitDatasetVersionInput {
  readonly runtime: DuckDbQueryRuntime
}

export interface DuckLakeApplyChangesContext {
  readonly previousRowCount?: number
}

/**
 * Owns the durable DuckLake transaction for a staged Sixb write.
 *
 * Write sessions keep validation and temp staging table mechanics close to the
 * caller. This coordinator handles everything that changes shared DuckLake
 * state: attachment refresh, optimistic guards, row replacement/append,
 * commit_extra_info, no-op detection, and DatasetVersion hydration.
 */
export class DuckLakeWriteCoordinator {
  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    this.connections.assertOpen()

    const definition = await this.datasets.getDataset(input.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.dataset.id}'.`)
    }

    this.datasets.assertSchema(definition)
    const mode = input.mode ?? "snapshot"
    assertDatasetWriteMode(mode, "write")

    // Staging tables are connection-scoped in DuckDB. In the single-runtime
    // model every active write session creates a uniquely named temp table on
    // the shared runtime; the durable commit later runs on that same
    // connection under an exclusive queue slot.
    const runtime = await this.connections.stagingRuntime()
    return createDuckLakeWriteSession({
      commitWrite: (options) => this.commitWrite(options),
      runtime,
      write: {
        ...input,
        dataset: definition,
        mode,
      },
    })
  }

  private async commitWrite(input: DuckLakeCommitWriteInput): Promise<DatasetVersion> {
    const definition = await this.datasets.getDataset(input.write.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.write.dataset.id}'.`)
    }

    const mode = input.write.mode ?? "snapshot"
    assertDatasetWriteMode(mode, "write")

    return this.commitDatasetVersion({
      dataset: definition,
      mode,
      expectedLatestVersionId: input.commit?.expectedLatestVersionId,
      commitMessage: input.commit?.commitMessage ?? `write dataset ${input.write.dataset.id}`,
      producer: input.write.producer,
      inputs: input.write.inputs,
      applyChanges: (runtime, context) =>
        this.applyStagedRows({
          ...input,
          runtime,
          previousRowCount: context.previousRowCount,
        }),
    })
  }

  async commitDatasetVersion(input: DuckLakeCommitDatasetVersionInput): Promise<DatasetVersion> {
    return this.withCommitRuntime((runtime) =>
      this.commitDatasetVersionOnExclusiveRuntime(runtime, input)
    )
  }

  async withCommitRuntime<T>(run: (runtime: DuckDbQueryRuntime) => Promise<T>): Promise<T> {
    return withCatalogCommitLock(this.options, async () => {
      // `withExclusiveAttached` refreshes local catalogs before the exclusive
      // slot, then holds the local attachment boundary through the commit.
      return this.connections.withExclusiveAttached(run)
    })
  }

  async commitDatasetVersionOnExclusiveRuntime(
    runtime: DuckDbQueryRuntime,
    input: DuckLakeCommitDatasetVersionInput
  ): Promise<DatasetVersion> {
    const runtimeInput = { ...input, runtime }
    return this.withGuardedRetrySetting(runtimeInput, () =>
      this.commitDatasetVersionUnlocked(runtimeInput)
    )
  }

  private async withGuardedRetrySetting<T>(
    input: DuckLakeCommitDatasetVersionRuntimeInput,
    run: () => Promise<T>
  ): Promise<T> {
    if (input.expectedLatestVersionId === undefined) {
      return run()
    }

    // DuckLake can retry transactions internally. Guarded Sixb commits need a
    // strict compare-and-swap check, so disable retries only for this exclusive
    // commit and always restore the runtime setting before releasing the queue.
    await input.runtime.run("SET ducklake_max_retry_count = 0")
    let outcome:
      | { readonly kind: "success"; readonly value: T }
      | {
          readonly kind: "error"
          readonly error: unknown
        }

    try {
      outcome = { kind: "success", value: await run() }
    } catch (error) {
      outcome = { kind: "error", error }
    }

    try {
      await input.runtime.run("RESET ducklake_max_retry_count")
    } catch {
      // The retry count is session state on a shared, long-lived connection.
      // If it cannot be restored, recycle the connection so a leftover value of
      // 0 cannot silently disable DuckLake auto-retry for a later unguarded
      // commit. The commit already succeeded or failed durably, so this cleanup
      // must never change the outcome reported to the caller.
      this.connections.poisonRuntime()
    }

    if (outcome.kind === "error") {
      throw outcome.error
    }

    return outcome.value
  }

  private async commitDatasetVersionUnlocked(
    input: DuckLakeCommitDatasetVersionRuntimeInput
  ): Promise<DatasetVersion> {
    // Capture the write connection's last committed DuckLake snapshot before
    // and after COMMIT. The commitId in DuckLake commit_extra_info proves
    // which snapshot belongs to this transaction.
    const previousWriteSnapshotId = await this.lastCommittedSnapshotId(input.runtime)

    await input.runtime.run("BEGIN TRANSACTION")
    let committed = false
    try {
      // Guarded Sixb commits need compare-and-swap semantics. DuckLake can
      // automatically retry non-conflicting commits, so guarded transactions
      // disable retries and re-check the dataset head after BEGIN.
      const latestVersion = await this.latestVersionForCommit(input)
      if (input.expectedLatestVersionId !== undefined) {
        this.assertExpectedLatestVersion({
          datasetId: input.dataset.id,
          expectedLatestVersionId: input.expectedLatestVersionId,
          actualLatestVersionId: latestVersion?.versionId ?? null,
        })
      }

      const changeResult = await input.applyChanges(input.runtime, {
        previousRowCount: latestVersion?.rowCount,
      })
      const commitId = randomUUID()
      await this.setCommitMetadata(
        input,
        commitId,
        commitRowCount(input, changeResult, latestVersion)
      )

      await input.runtime.run("COMMIT")
      committed = true

      const committedWriteSnapshotId = await this.lastCommittedSnapshotId(input.runtime)
      try {
        return await this.versionForCommittedWrite({
          ...input,
          commitId,
          previousWriteSnapshotId,
          committedWriteSnapshotId,
          changeResult,
        })
      } finally {
        await this.connections.detachLocalCatalogAfterCommit(input.runtime)
      }
    } catch (error) {
      if (!committed) {
        await this.rollbackTransaction(input.runtime)
      }
      throw error
    }
  }

  private async versionForCommittedWrite(
    input: DuckLakeCommitDatasetVersionRuntimeInput & {
      readonly commitId: string
      readonly previousWriteSnapshotId: string | null
      readonly committedWriteSnapshotId: string | null
      readonly changeResult: ApplyDatasetRowsResult
    }
  ): Promise<DatasetVersion> {
    // Hydrate the committed version on the same exclusive runtime. That keeps
    // snapshot matching and row-count fallback inside the same serialized
    // connection state that just committed.
    const ownSnapshotId = await this.findOwnSnapshotId(
      input.runtime,
      input.dataset.id,
      input.commitId,
      input.previousWriteSnapshotId,
      input.committedWriteSnapshotId
    )

    if (ownSnapshotId !== null) {
      const version = await this.snapshots.getVersionForSnapshot(
        input.runtime,
        input.dataset,
        ownSnapshotId
      )
      if (version) {
        return version
      }

      throw new LakeStorageError(
        `[SixbDuckLake] DuckLake committed snapshot '${ownSnapshotId}' for dataset '${input.dataset.id}', but Sixb could not hydrate it as a dataset version.`
      )
    }

    if (!input.changeResult.dataChangeExpected) {
      return this.versionForNoOpCommit(input.runtime, input.dataset)
    }

    if (input.committedWriteSnapshotId === input.previousWriteSnapshotId) {
      throw new LakeStorageError(
        `[SixbDuckLake] DuckLake commit for dataset '${input.dataset.id}' completed without producing a snapshot for this non-empty write.`
      )
    }

    throw new LakeStorageError(
      `[SixbDuckLake] DuckLake commit for dataset '${input.dataset.id}' completed, but Sixb could not find a matching snapshot for this write.`
    )
  }

  private async applyStagedRows(
    input: DuckLakeCommitWriteInput & {
      readonly runtime: DuckDbQueryRuntime
      readonly previousRowCount?: number
    }
  ): Promise<ApplyDatasetRowsResult> {
    const mode = input.write.mode ?? "snapshot"
    const result = await applyDatasetRowsFromRelation({
      options: this.options,
      runtime: input.runtime,
      dataset: input.write.dataset,
      mode,
      sourceRelationSql: quoteIdentifier(input.stagingTableName),
      previousRowCount: input.previousRowCount,
    })

    if (result.sourceRowCount !== input.rowsWritten) {
      throw new LakeStorageError(
        `[SixbDuckLake] Staged write for dataset '${input.write.dataset.id}' accepted ${input.rowsWritten} row(s), but DuckLake saw ${result.sourceRowCount} source row(s) at commit time.`
      )
    }

    return result
  }

  private async setCommitMetadata(
    input: DuckLakeCommitDatasetVersionRuntimeInput,
    commitId: string,
    rowCount: CommitRowCount
  ): Promise<void> {
    // DuckLake stores this JSON on the snapshot it creates for the current
    // transaction. Version id, timestamp, and data-change detection still come
    // from DuckLake itself. commitId is only a transaction correlation token so
    // concurrent writers do not accidentally hydrate each other's snapshots.
    const metadata: SixbCommitMetadata = {
      kind: "datasetVersion",
      datasetId: input.dataset.id,
      commitId,
      mode: input.mode,
      producer: input.producer ? structuredClone(input.producer) : undefined,
      inputs: input.inputs ? structuredClone(input.inputs) : undefined,
      ...(rowCount.kind === "exact" ? { rowCount: rowCount.value } : {}),
    }

    await input.runtime.run(
      `CALL ${quoteIdentifier(duckLakeAlias(this.options))}.set_commit_message(${quoteSqlString(
        "Sixb"
      )}, ${quoteSqlString(input.commitMessage)}, extra_info => ${quoteSqlString(
        JSON.stringify({ sixb: metadata })
      )})`
    )
  }

  private async versionForNoOpCommit(
    runtime: DuckDbQueryRuntime,
    definition: DatasetDefinition
  ): Promise<DatasetVersion> {
    const latestVersion = await this.snapshots.getLatestVersionForDefinition(runtime, definition)
    if (latestVersion) {
      return latestVersion
    }

    throw new LakeStorageError(
      `[SixbDuckLake] No DuckLake changes were committed for dataset '${definition.id}', and no previous version exists.`
    )
  }

  private async rollbackTransaction(runtime: DuckDbQueryRuntime): Promise<void> {
    try {
      await runtime.run("ROLLBACK")
    } catch {
      // Preserve the original write failure. DuckDB may already have closed
      // the transaction if COMMIT itself failed.
    }
  }

  private async latestVersionForCommit(
    input: DuckLakeCommitDatasetVersionRuntimeInput
  ): Promise<DuckLakeVersionSummary | null> {
    if (input.expectedLatestVersionId === undefined && input.mode !== "append") {
      return null
    }

    return this.snapshots.getLatestVersionSummaryForDefinition(input.runtime, input.dataset)
  }

  private async lastCommittedSnapshotId(runtime: DuckDbQueryRuntime): Promise<string | null> {
    // DuckLake reports the last snapshot committed by this connection.
    const [row] = await runtime.query(
      `SELECT id FROM ${quoteIdentifier(duckLakeAlias(this.options))}.last_committed_snapshot()`
    )
    if (row === undefined || row.id === null || row.id === undefined) {
      return null
    }

    return String(getBigIntLike(row, "id"))
  }

  private async findSnapshotIdByCommitId(
    runtime: DuckDbQueryRuntime,
    datasetId: string,
    commitId: string,
    snapshotId?: string
  ): Promise<string | null> {
    if (snapshotId !== undefined) {
      assertDuckLakeSnapshotId(snapshotId)
    }

    const ducklakeSnapshotChanges = duckLakeMetadataTableName(
      this.options,
      "ducklake_snapshot_changes"
    )
    const whereSql = snapshotId === undefined ? "" : `WHERE snapshot_id = ${snapshotId}`
    const orderSql = snapshotId === undefined ? "ORDER BY snapshot_id DESC" : ""
    const rows = await runtime.query(`
      SELECT snapshot_id, commit_extra_info
      FROM ${ducklakeSnapshotChanges}
      ${whereSql}
      ${orderSql}
    `)

    for (const row of rows) {
      const metadata = parseCommitMetadata(row.commit_extra_info)
      if (metadata?.datasetId === datasetId && metadata.commitId === commitId) {
        return String(getBigIntLike(row, "snapshot_id"))
      }
    }

    return null
  }

  private async findOwnSnapshotId(
    runtime: DuckDbQueryRuntime,
    datasetId: string,
    commitId: string,
    previousWriteSnapshotId: string | null,
    committedWriteSnapshotId: string | null
  ): Promise<string | null> {
    if (committedWriteSnapshotId === null || committedWriteSnapshotId === previousWriteSnapshotId) {
      return null
    }

    const exactMatch = await this.findSnapshotIdByCommitId(
      runtime,
      datasetId,
      commitId,
      committedWriteSnapshotId
    )
    if (exactMatch !== null) {
      return exactMatch
    }

    // Defensive fallback for driver/version edge cases. The expected hot path
    // above reads a single metadata row keyed by last_committed_snapshot().
    return this.findSnapshotIdByCommitId(runtime, datasetId, commitId)
  }

  private assertExpectedLatestVersion(input: {
    readonly datasetId: string
    readonly expectedLatestVersionId?: string
    readonly actualLatestVersionId: string | null
  }): void {
    if (input.expectedLatestVersionId === undefined) {
      return
    }

    if (input.actualLatestVersionId !== input.expectedLatestVersionId) {
      throw new LakeStorageError(
        `[SixbDuckLake] Optimistic commit failed for dataset '${input.datasetId}': expected latest version '${input.expectedLatestVersionId}', found '${input.actualLatestVersionId ?? "none"}'.`
      )
    }
  }
}

function commitRowCount(
  input: Pick<DuckLakeCommitDatasetVersionInput, "expectedLatestVersionId" | "mode">,
  changeResult: ApplyDatasetRowsResult,
  latestVersion: DuckLakeVersionSummary | null
): CommitRowCount {
  // Unguarded append commits can be retried by DuckLake after this transaction
  // read the previous latest version. In that case previousRowCount +
  // sourceRowCount can underreport the committed snapshot, so omit metadata
  // and let hydration count the exact committed snapshot instead.
  if (input.mode === "append" && input.expectedLatestVersionId === undefined) {
    return { kind: "unknown" }
  }

  if (changeResult.resultingRowCount.kind === "exact") {
    return changeResult.resultingRowCount
  }

  if (input.mode === "append" && latestVersion === null) {
    return { kind: "exact", value: changeResult.sourceRowCount }
  }

  return { kind: "unknown" }
}

function assertDuckLakeSnapshotId(snapshotId: string): void {
  if (!/^\d+$/.test(snapshotId)) {
    throw new LakeStorageError(`[SixbDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}

// Local metadata catalogs are useful for dev/test, but they do not have the
// same multi-connection conflict behavior as PostgreSQL. Serialize local
// commits within this process so a losing writer cannot hydrate another
// connection's snapshot during DuckLake conflict handling.
const localCatalogCommitLocks = new Map<string, Promise<void>>()

async function withCatalogCommitLock<T>(
  options: DuckLakeStorageOptions,
  run: () => Promise<T>
): Promise<T> {
  const key = localCatalogCoordinationKey(options)
  if (key === undefined) {
    return run()
  }

  const previous = localCatalogCommitLocks.get(key) ?? Promise.resolve()
  const ready = previous.catch(() => {})
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = ready.then(() => next)
  localCatalogCommitLocks.set(key, current)

  await ready
  try {
    return await run()
  } finally {
    release()
    if (localCatalogCommitLocks.get(key) === current) {
      localCatalogCommitLocks.delete(key)
    }
  }
}
