import { randomUUID } from "node:crypto"
import type { DatasetDefinition } from "@sixb/core"
import type {
  BeginDatasetMergeInput,
  BeginDatasetWriteInput,
  DatasetMergeCommitResult,
  DatasetProducer,
  DatasetVersion,
  DatasetVersionLineage,
  DatasetWriteCommitResult,
  DatasetWriteMode,
  LakeMergeSession,
  LakeWriteSession,
} from "@sixb/core/lake-storage"
import {
  assertUnsequencedDatasetWrite,
  getDatasetPrimaryKeyColumns,
  hasDatasetProvenanceChanges,
  LakeConcurrencyError,
  LakeStorageError,
  lineageAtCommit,
  retryDatasetMergeCommit,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { localCatalogCoordinationKey } from "./catalog-key"
import {
  type ApplyDatasetRowsResult,
  applyDatasetRowsFromRelation,
  assertDatasetWriteMode,
  type CommitRowCount,
} from "./dataset-row-commit"
import { applyDatasetMergeFromRelation } from "./dataset-row-merge"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import { createDuckLakeMergeSession, type DuckLakeCommitMergeInput } from "./ducklake-merge-session"
import type { DuckLakeSnapshotReader, DuckLakeVersionSummary } from "./ducklake-snapshot-reader"
import {
  beginTransactionOnLatestVersion,
  CatalogMovedError,
  commitVersionTransaction,
  isSqliteCatalog,
  rerunWhenCatalogMoves,
} from "./ducklake-version-transaction"
import { createDuckLakeWriteSession, type DuckLakeCommitWriteInput } from "./ducklake-write-session"
import { encodeLineage } from "./lineage-encoding"
import { encodeDatasetTableName } from "./names"
import {
  duckLakeAlias,
  duckLakeMetadataTableName,
  qualifiedTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"
import { parseCommitMetadata, type SixbCommitMetadata } from "./versions"

export interface DuckLakeCommitDatasetVersionInput {
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly expectedLatestVersionId?: string | null
  readonly commitMessage: string
  readonly producer?: BeginDatasetWriteInput["producer"]
  readonly inputs?: BeginDatasetWriteInput["inputs"]
  /** The lineage of the rows written, as `BeginDatasetWriteInput.lineage`. */
  readonly lineage?: BeginDatasetWriteInput["lineage"]
  applyChanges(
    runtime: DuckDbQueryRuntime,
    context: DuckLakeApplyChangesContext
  ): Promise<ApplyDatasetRowsResult>
}

interface DuckLakeCommitVersionOutcomeInput
  extends Omit<DuckLakeCommitDatasetVersionInput, "expectedLatestVersionId" | "mode"> {
  readonly mode: DatasetWriteMode | "merge"
  readonly expectedLatestVersionId?: string | null
  readonly allowInitialNoOp?: boolean
  readonly signal?: AbortSignal
  readonly optimisticOperation?: "commit" | "merge commit"
}

interface DuckLakeCommitVersionOutcomeRuntimeInput extends DuckLakeCommitVersionOutcomeInput {
  readonly runtime: DuckDbQueryRuntime
}

export interface DuckLakeApplyChangesContext {
  readonly previousRowCount?: number
  readonly validatedPrimaryKeyColumns?: readonly string[]
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
    assertUnsequencedDatasetWrite(definition)
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

  async beginMerge(input: BeginDatasetMergeInput): Promise<LakeMergeSession> {
    this.connections.assertOpen()

    const definition = await this.datasets.getDataset(input.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.dataset.id}'.`)
    }
    if (getDatasetPrimaryKeyColumns(definition) === null) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset '${definition.id}' must define a primaryKey before it can be merged.`
      )
    }

    this.datasets.assertSchema(definition)
    const latestVersion = await this.connections.withAttachedRuntime((runtime) =>
      this.snapshots.getLatestVersionForDefinition(runtime, definition)
    )
    if (
      input.expectedLatestVersionId !== undefined &&
      latestVersion?.versionId !== input.expectedLatestVersionId
    ) {
      throw new LakeConcurrencyError(
        `[SixbDuckLake] Optimistic merge start failed for dataset '${definition.id}': expected latest version '${input.expectedLatestVersionId}', found '${latestVersion?.versionId ?? "none"}'.`
      )
    }
    const runtime = await this.connections.stagingRuntime()
    return createDuckLakeMergeSession({
      commitMerge: (options) => this.commitMerge(options),
      runtime,
      merge: { ...input, dataset: definition },
      baseVersionId: latestVersion?.versionId ?? null,
    })
  }

  private async commitWrite(input: DuckLakeCommitWriteInput): Promise<DatasetWriteCommitResult> {
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
      lineage: input.write.lineage,
      applyChanges: (runtime, context) =>
        this.applyStagedRows({
          ...input,
          runtime,
          previousRowCount: context.previousRowCount,
        }),
    })
  }

  private async commitMerge(input: DuckLakeCommitMergeInput): Promise<DatasetMergeCommitResult> {
    const definition = await this.datasets.getDataset(input.merge.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[SixbDuckLake] Unknown dataset '${input.merge.dataset.id}'.`)
    }
    if (getDatasetPrimaryKeyColumns(definition) === null) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset '${definition.id}' must define a primaryKey before it can be merged.`
      )
    }

    return retryDatasetMergeCommit(input.merge, input.commit, (rebase) =>
      this.withCommitRuntime(async (runtime) => {
        input.commit?.signal?.throwIfAborted()
        const baseVersionId = rebase
          ? ((await this.snapshots.getLatestVersionForDefinition(runtime, definition))?.versionId ??
            null)
          : input.baseVersionId
        return this.commitVersionOutcomeOnExclusiveRuntime(runtime, {
          dataset: definition,
          mode: "merge",
          expectedLatestVersionId: baseVersionId,
          allowInitialNoOp: !input.commit?.createInitialVersion,
          signal: input.commit?.signal,
          optimisticOperation: "merge commit",
          commitMessage: input.commit?.commitMessage ?? `merge dataset ${definition.id}`,
          producer: input.merge.producer,
          inputs: input.merge.inputs,
          applyChanges: async (commitRuntime, context) => {
            const result = await applyDatasetMergeFromRelation({
              options: this.options,
              runtime: commitRuntime,
              dataset: definition,
              stagingTableName: input.stagingTableName,
              sequenceColumnName: input.sequenceColumnName,
              kindColumnName: input.kindColumnName,
              previousRowCount: context.previousRowCount,
              validatedPrimaryKeyColumns: context.validatedPrimaryKeyColumns,
            })
            if (result.sourceRowCount !== input.changesWritten) {
              throw new LakeStorageError(
                `[SixbDuckLake] Staged merge for dataset '${definition.id}' accepted ${input.changesWritten} change(s), but DuckLake saw ${result.sourceRowCount} source change(s) at commit time.`
              )
            }
            return result
          },
        })
      })
    )
  }

  async commitDatasetVersion(
    input: DuckLakeCommitDatasetVersionInput
  ): Promise<DatasetWriteCommitResult> {
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
  ): Promise<DatasetWriteCommitResult> {
    assertUnsequencedDatasetWrite(input.dataset)
    const result = await this.commitVersionOutcomeOnExclusiveRuntime(runtime, input)
    if (result.version === null) {
      throw new LakeStorageError(
        `[SixbDuckLake] No DuckLake changes were committed for dataset '${input.dataset.id}', and no previous version exists.`
      )
    }

    return { ...result.version, outcome: result.outcome }
  }

  private async commitVersionOutcomeOnExclusiveRuntime(
    runtime: DuckDbQueryRuntime,
    input: DuckLakeCommitVersionOutcomeInput
  ): Promise<DatasetMergeCommitResult> {
    // Staged rows outlive a failed transaction, so a rerun applies exactly the same changes.
    return rerunWhenCatalogMoves(
      input.dataset.id,
      () => this.commitDatasetVersionUnlocked({ ...input, runtime }),
      input.signal
    )
  }

  private async commitDatasetVersionUnlocked(
    input: DuckLakeCommitVersionOutcomeRuntimeInput
  ): Promise<DatasetMergeCommitResult> {
    // Capture the write connection's last committed DuckLake snapshot before
    // and after COMMIT. The commitId in DuckLake commit_extra_info proves
    // which snapshot belongs to this transaction.
    const previousWriteSnapshotId = await this.lastCommittedSnapshotId(input.runtime)

    let committed = false
    try {
      const latestVersion = await this.beginVersionTransaction(input)
      if (input.expectedLatestVersionId !== undefined) {
        this.assertExpectedLatestVersion({
          datasetId: input.dataset.id,
          expectedLatestVersionId: input.expectedLatestVersionId,
          actualLatestVersionId: latestVersion?.versionId ?? null,
          operation: input.optimisticOperation ?? "commit",
        })
      }

      const lineage = lineageAtCommit({
        mode: input.mode,
        schema: input.dataset.schema,
        producer: input.producer,
        written: input.lineage,
        parent: latestVersion,
      })

      const changeResult = await input.applyChanges(input.runtime, {
        previousRowCount: latestVersion?.rowCount,
        validatedPrimaryKeyColumns: latestVersion?.validatedPrimaryKeyColumns,
      })
      input.signal?.throwIfAborted()

      // A commit that changes no rows is decided against the latest version, read in this
      // transaction if beginning it did not.
      const noOpBase = changeResult.dataChangeExpected
        ? undefined
        : latestVersion === undefined
          ? await this.snapshots.getLatestVersionSummaryForDefinition(input.runtime, input.dataset)
          : latestVersion

      const createsVersion =
        noOpBase === undefined || this.noOpCreatesVersion(input, noOpBase, lineage)
      if (createsVersion && mustClaimTable(input, changeResult, lineage)) {
        await this.claimTable(input)
      }

      const commitId = randomUUID()
      await this.setCommitMetadata(
        input,
        commitId,
        commitRowCount(input, changeResult, latestVersion),
        lineage
      )

      await commitVersionTransaction(
        input.runtime,
        input.dataset.id,
        createsVersion && mustCommitOnReadSnapshot(input, changeResult)
          ? { poisonRuntime: () => this.connections.poisonRuntime() }
          : undefined
      )
      committed = true

      const committedWriteSnapshotId = await this.lastCommittedSnapshotId(input.runtime)
      try {
        return await this.versionForCommittedWrite({
          ...input,
          commitId,
          previousWriteSnapshotId,
          committedWriteSnapshotId,
          changeResult,
          noOpBaseVersionId: noOpBase?.versionId ?? null,
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
    input: DuckLakeCommitVersionOutcomeRuntimeInput & {
      readonly commitId: string
      readonly previousWriteSnapshotId: string | null
      readonly committedWriteSnapshotId: string | null
      readonly changeResult: ApplyDatasetRowsResult
      /** The latest version a commit that changes no rows was compared with. */
      readonly noOpBaseVersionId: string | null
    }
  ): Promise<DatasetMergeCommitResult> {
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
        return { outcome: "created", version }
      }

      throw new LakeStorageError(
        `[SixbDuckLake] DuckLake committed snapshot '${ownSnapshotId}' for dataset '${input.dataset.id}', but Sixb could not hydrate it as a dataset version.`
      )
    }

    if (!input.changeResult.dataChangeExpected) {
      const version = await this.versionForNoOpCommit(
        input.runtime,
        input.dataset,
        input.allowInitialNoOp ?? false
      )
      if (input.expectedLatestVersionId !== undefined) {
        this.assertExpectedLatestVersion({
          datasetId: input.dataset.id,
          expectedLatestVersionId: input.expectedLatestVersionId,
          actualLatestVersionId: version?.versionId ?? null,
          operation: input.optimisticOperation ?? "commit",
        })
      }

      // Nothing was committed: the write matched the version this transaction read. Another
      // writer moved the latest version since, and the write may not match that one.
      if ((version?.versionId ?? null) !== input.noOpBaseVersionId) {
        throw new CatalogMovedError(
          `[SixbDuckLake] Dataset '${input.dataset.id}' changed while an unchanged write was compared with it.`
        )
      }

      return {
        outcome: "unchanged",
        version,
      }
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
    input: DuckLakeCommitVersionOutcomeRuntimeInput,
    commitId: string,
    rowCount: CommitRowCount,
    lineage: DatasetVersionLineage | undefined
  ): Promise<void> {
    // DuckLake stores this JSON on the snapshot it creates for the current
    // transaction. Version id, timestamp, and data-change detection still come
    // from DuckLake itself. commitId is only a transaction correlation token so
    // concurrent writers do not accidentally hydrate each other's snapshots.
    // Every keyed data path either replaces the baseline or validates its uniqueness before this
    // marker is persisted. Merge commits can therefore avoid repeating that full-table audit.
    const validatedPrimaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
    const metadata: SixbCommitMetadata = {
      kind: "datasetVersion",
      datasetId: input.dataset.id,
      commitId,
      mode: input.mode,
      producer: input.producer ? structuredClone(input.producer) : undefined,
      inputs: input.inputs ? structuredClone(input.inputs) : undefined,
      ...(rowCount.kind === "exact" ? { rowCount: rowCount.value } : {}),
      ...(validatedPrimaryKeyColumns !== null
        ? { validatedPrimaryKeyColumns: [...validatedPrimaryKeyColumns] }
        : {}),
      ...(lineage === undefined ? {} : { lineage: encodeLineage(lineage) }),
    }

    await input.runtime.run(
      `CALL ${quoteIdentifier(duckLakeAlias(this.options))}.set_commit_message(${quoteSqlString(
        "Sixb"
      )}, ${quoteSqlString(input.commitMessage)}, extra_info => ${quoteSqlString(
        JSON.stringify({ sixb: metadata })
      )})`
    )
  }

  /**
   * Claims the table for the version this transaction commits by reapplying its current comment:
   * an idempotent metadata write, which DuckLake records as altering the table. A transaction
   * that changes a table another one altered since it began then fails to commit, before storing
   * anything, and reruns on the new latest version (see `mustClaimTable`).
   *
   * It also gives a version that changes no rows, an initial empty write or a change of
   * provenance, a DuckLake snapshot: DuckLake 1.5.2 creates none for a transaction whose data and
   * metadata are unchanged, and set_commit_message alone cannot force one.
   *
   * Altering a table bumps DuckLake's catalog-wide schema version: every connection reloads its
   * catalog, and concurrent writers to other tables slow down. Versions claim only when needed.
   */
  private async claimTable(input: DuckLakeCommitVersionOutcomeRuntimeInput): Promise<void> {
    const table = qualifiedTableName(this.options, encodeDatasetTableName(input.dataset.id))
    const descriptionSql =
      input.dataset.description === undefined ? "NULL" : quoteSqlString(input.dataset.description)
    await input.runtime.run(`COMMENT ON TABLE ${table} IS ${descriptionSql}`)
  }

  /** A commit that changes no rows still creates a version for a first version or new provenance. */
  private noOpCreatesVersion(
    input: DuckLakeCommitVersionOutcomeRuntimeInput,
    latestVersion: DuckLakeVersionSummary | null,
    lineage: DatasetVersionLineage | undefined
  ): boolean {
    if (!latestVersion) {
      return !input.allowInitialNoOp
    }

    return (
      input.mode !== "merge" &&
      hasDatasetProvenanceChanges(latestVersion, {
        datasetId: input.dataset.id,
        schema: input.dataset.schema,
        producer: input.producer,
        inputs: input.inputs,
        lineage,
      })
    )
  }

  private async versionForNoOpCommit(
    runtime: DuckDbQueryRuntime,
    definition: DatasetDefinition,
    allowInitialNoOp: boolean
  ): Promise<DatasetVersion | null> {
    const latestVersion = await this.snapshots.getLatestVersionForDefinition(runtime, definition)
    if (latestVersion) {
      return latestVersion
    }

    if (allowInitialNoOp) {
      return null
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

  /**
   * Every version but a snapshot keeps its parent's rows, and the lineage it records merges the
   * parent's. A snapshot replaces its parent: it reads it only to guard on it, or on SQLite, whose
   * later reads inside the transaction would block its commit.
   */
  private async beginVersionTransaction(
    input: DuckLakeCommitVersionOutcomeRuntimeInput
  ): Promise<DuckLakeVersionSummary | null | undefined> {
    if (
      input.mode === "snapshot" &&
      input.expectedLatestVersionId === undefined &&
      !isSqliteCatalog(this.options.catalog)
    ) {
      await input.runtime.run("BEGIN TRANSACTION")
      return undefined
    }

    return beginTransactionOnLatestVersion({
      options: this.options,
      runtime: input.runtime,
      datasetId: input.dataset.id,
      signal: input.signal,
      readLatestVersion: () =>
        this.snapshots.getLatestVersionSummaryAtCurrentSnapshot(input.runtime, input.dataset),
    })
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
    readonly expectedLatestVersionId?: string | null
    readonly actualLatestVersionId: string | null
    readonly operation: "commit" | "merge commit"
  }): void {
    if (input.expectedLatestVersionId === undefined) {
      return
    }

    if (input.actualLatestVersionId !== input.expectedLatestVersionId) {
      throw new LakeConcurrencyError(
        `[SixbDuckLake] Optimistic ${input.operation} failed for dataset '${input.datasetId}': expected latest version '${input.expectedLatestVersionId ?? "none"}', found '${input.actualLatestVersionId ?? "none"}'.`
      )
    }
  }
}

/**
 * Whether a version must claim its table so that a concurrent commit cannot build on it unseen.
 *
 * DuckLake commits a transaction on top of snapshots committed since it began unless one of them
 * altered the table or deleted rows it held. Only the earlier commit decides: a claim protects the
 * version that makes it from concurrent commits that land after it, never the reverse. A commit
 * that builds on a version it did not see keeps that version's rows, but stores the lineage of
 * the parent it read. For lineage, that is only wrong when the unseen version's stored lineage
 * carries dependencies: rows that depend on their own columns only add nothing to any lineage, so
 * two unkeyed appends to a dataset no pipeline writes may commit in any order. Commits that record
 * more of their parent than its lineage do not build on unseen versions (see
 * `mustCommitOnReadSnapshot`).
 *
 * - A version that changes no rows claims: it is also how it gets a snapshot.
 * - A write into an empty table claims, whatever it holds. It deletes nothing, so a snapshot that
 *   also read the table empty would delete nothing either, and keep the rows it replaces.
 * - A snapshot that deleted rows needs no claim: any concurrent change to the table conflicts with
 *   its deletes.
 * - A keyed append or merge claims. DuckLake has no primary key: two writes that insert one new
 *   key both commit unless the earlier one claims.
 * - An unkeyed append into a table with rows claims when the lineage it stores carries a
 *   dependency, or is unknown. A concurrent snapshot of that table deletes rows, and conflicts.
 */
function mustClaimTable(
  input: DuckLakeCommitVersionOutcomeRuntimeInput,
  changeResult: ApplyDatasetRowsResult,
  lineage: DatasetVersionLineage | undefined
): boolean {
  if (!changeResult.dataChangeExpected || changeResult.targetWasEmpty) {
    return true
  }

  if (input.mode === "snapshot") {
    return false
  }

  return (
    getDatasetPrimaryKeyColumns(input.dataset) !== null ||
    carriesDependencies(input.producer, lineage)
  )
}

/**
 * Whether a version must fail on any snapshot committed since its transaction began, rather than
 * commit on top of one that does not conflict with it. A version that did not claim its table (see
 * `mustClaimTable`) can only be built on unseen by a commit that records nothing of its parent but
 * its lineage, which that version cannot change. Two kinds of commit record more:
 *
 * - One that inserts and deletes no rows of its table, such as a version of new provenance, a
 *   merge that only advances source ordering, or a schema change. DuckLake checks it against
 *   nothing, and it would stand for rows it never compared.
 * - An unkeyed append guarded on the version it read, which an unclaimed append could move.
 */
function mustCommitOnReadSnapshot(
  input: DuckLakeCommitVersionOutcomeRuntimeInput,
  changeResult: ApplyDatasetRowsResult
): boolean {
  if (!changeResult.changedTableRows) {
    return true
  }

  return (
    input.expectedLatestVersionId !== undefined &&
    input.mode === "append" &&
    getDatasetPrimaryKeyColumns(input.dataset) === null
  )
}

/** Whether a stored lineage says the version's rows depend on any column but their own. */
function carriesDependencies(
  producer: DatasetProducer | undefined,
  lineage: DatasetVersionLineage | undefined
): boolean {
  if (lineage === undefined) {
    // A pipeline version without lineage could hold anything.
    return producer?.kind === "pipeline"
  }

  if ("unknown" in lineage) {
    return true
  }

  return lineage.rows.length > 0 || Object.values(lineage.columns).some((refs) => refs.length > 0)
}

function commitRowCount(
  input: Pick<DuckLakeCommitVersionOutcomeInput, "expectedLatestVersionId" | "mode">,
  changeResult: ApplyDatasetRowsResult,
  latestVersion: DuckLakeVersionSummary | null | undefined
): CommitRowCount {
  // Unguarded append commits can be retried by DuckLake after this transaction
  // read the previous latest version. In that case previousRowCount +
  // sourceRowCount can underreport the committed snapshot, so leave the count unknown.
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
