import { randomUUID } from "node:crypto"
import type {
  BeginDatasetWriteInput,
  DatasetDefinition,
  DatasetVersion,
  DatasetWriteMode,
  LakeWriteSession,
} from "@pario/core"
import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import {
  type ApplyDatasetRowsResult,
  applyDatasetRowsFromRelation,
  assertDatasetWriteMode,
  type CommitRowCount,
} from "./dataset-row-commit"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbRuntime } from "./duckdb-runtime"
import type {
  DuckLakeCommittedWriteRuntimeRelease,
  DuckLakeConnectionManager,
  DuckLakeWriteRuntimeLease,
} from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader, DuckLakeVersionSummary } from "./ducklake-snapshot-reader"
import { createDuckLakeWriteSession, type DuckLakeCommitWriteInput } from "./ducklake-write-session"
import {
  buildAttachSql,
  duckLakeAlias,
  duckLakeMetadataTableName,
  quoteIdentifier,
  quoteSqlString,
} from "./sql"
import { type ParioCommitMetadata, parseCommitMetadata } from "./versions"

export interface DuckLakeCommitDatasetVersionInput {
  readonly runtime: DuckDbRuntime
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly expectedLatestVersionId?: string
  readonly commitMessage: string
  readonly producer?: BeginDatasetWriteInput["producer"]
  readonly inputs?: BeginDatasetWriteInput["inputs"]
  committedReadRuntime(release: DuckLakeCommittedWriteRuntimeRelease): Promise<DuckDbRuntime>
  applyChanges(
    runtime: DuckDbRuntime,
    context: DuckLakeApplyChangesContext
  ): Promise<ApplyDatasetRowsResult>
}

export interface DuckLakeApplyChangesContext {
  readonly previousRowCount?: number
}

/**
 * Owns the durable DuckLake transaction for a staged Pario write.
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
      throw new LakeStorageError(`[ParioDuckLake] Unknown dataset '${input.dataset.id}'.`)
    }

    this.datasets.assertSchema(definition)
    const mode = input.mode ?? "snapshot"
    assertDatasetWriteMode(mode, "write")

    // Staging tables are connection-scoped in DuckDB, so every active write
    // session owns a dedicated runtime lease until commit or abort releases it.
    const lease = await this.connections.acquireWriteLease()
    return createDuckLakeWriteSession({
      commitWrite: (options) => this.commitWrite(options, lease),
      lease,
      write: {
        ...input,
        dataset: definition,
        mode,
      },
    })
  }

  private async commitWrite(
    input: DuckLakeCommitWriteInput,
    lease: DuckLakeWriteRuntimeLease
  ): Promise<DatasetVersion> {
    const definition = await this.datasets.getDataset(input.write.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[ParioDuckLake] Unknown dataset '${input.write.dataset.id}'.`)
    }

    const mode = input.write.mode ?? "snapshot"
    assertDatasetWriteMode(mode, "write")

    return this.commitDatasetVersion({
      runtime: input.runtime,
      dataset: definition,
      mode,
      expectedLatestVersionId: input.commit?.expectedLatestVersionId,
      commitMessage: input.commit?.commitMessage ?? `write dataset ${input.write.dataset.id}`,
      producer: input.write.producer,
      inputs: input.write.inputs,
      committedReadRuntime: (release) => lease.committedReadRuntime(release),
      applyChanges: (runtime, context) =>
        this.applyStagedRows({
          ...input,
          runtime,
          previousRowCount: context.previousRowCount,
        }),
    })
  }

  async commitDatasetVersion(input: DuckLakeCommitDatasetVersionInput): Promise<DatasetVersion> {
    await this.prepareRuntimeForCommit(input.runtime, input.expectedLatestVersionId !== undefined)

    // Capture the write connection's last committed DuckLake snapshot before
    // and after COMMIT. Fresh write runtimes usually start at null; this is a
    // helpful no-op signal, but non-empty writes still prove ownership through
    // the commitId in DuckLake commit_extra_info.
    const previousWriteSnapshotId = await this.lastCommittedSnapshotId(input.runtime)

    await input.runtime.run("BEGIN TRANSACTION")
    let committed = false
    try {
      // Guarded Pario commits need compare-and-swap semantics. DuckLake can
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
      const readRuntime = await input.committedReadRuntime({
        kind: "committed",
        guarded: input.expectedLatestVersionId !== undefined,
        reusable: true,
      })
      const version = await this.versionForCommittedWrite({
        ...input,
        readRuntime,
        commitId,
        previousWriteSnapshotId,
        committedWriteSnapshotId,
        changeResult,
      })
      return version
    } catch (error) {
      if (!committed) {
        await this.rollbackTransaction(input.runtime)
      }
      await this.connections.resetRuntime()
      throw error
    }
  }

  private async versionForCommittedWrite(
    input: DuckLakeCommitDatasetVersionInput & {
      readonly readRuntime: DuckDbRuntime
      readonly commitId: string
      readonly previousWriteSnapshotId: string | null
      readonly committedWriteSnapshotId: string | null
      readonly changeResult: ApplyDatasetRowsResult
    }
  ): Promise<DatasetVersion> {
    // The lease chooses the correct post-commit read runtime. Local catalogs
    // close the writer before returning a fresh reader; PostgreSQL catalogs
    // refresh the shared reader while keeping the writer lease available for
    // cleanup and possible reuse.
    const readRuntime = input.readRuntime
    const ownSnapshotId = await this.findOwnSnapshotId(
      readRuntime,
      input.dataset.id,
      input.commitId,
      input.previousWriteSnapshotId,
      input.committedWriteSnapshotId
    )

    if (ownSnapshotId !== null) {
      const version = await this.snapshots.getVersionForSnapshot(
        readRuntime,
        input.dataset,
        ownSnapshotId
      )
      if (version) {
        return version
      }

      throw new LakeStorageError(
        `[ParioDuckLake] DuckLake committed snapshot '${ownSnapshotId}' for dataset '${input.dataset.id}', but Pario could not hydrate it as a dataset version.`
      )
    }

    if (!input.changeResult.dataChangeExpected) {
      return this.versionForNoOpCommit(readRuntime, input.dataset)
    }

    if (input.committedWriteSnapshotId === input.previousWriteSnapshotId) {
      throw new LakeStorageError(
        `[ParioDuckLake] DuckLake commit for dataset '${input.dataset.id}' completed without producing a snapshot for this non-empty write.`
      )
    }

    throw new LakeStorageError(
      `[ParioDuckLake] DuckLake commit for dataset '${input.dataset.id}' completed, but Pario could not find a matching snapshot for this write.`
    )
  }

  private async applyStagedRows(
    input: DuckLakeCommitWriteInput & { readonly previousRowCount?: number }
  ): Promise<ApplyDatasetRowsResult> {
    const mode = input.write.mode ?? "snapshot"
    return applyDatasetRowsFromRelation({
      options: this.options,
      runtime: input.runtime,
      dataset: input.write.dataset,
      mode,
      sourceRelationSql: quoteIdentifier(input.stagingTableName),
      previousRowCount: input.previousRowCount,
    })
  }

  private async setCommitMetadata(
    input: DuckLakeCommitDatasetVersionInput,
    commitId: string,
    rowCount: CommitRowCount
  ): Promise<void> {
    // DuckLake stores this JSON on the snapshot it creates for the current
    // transaction. Version id, timestamp, and data-change detection still come
    // from DuckLake itself. commitId is only a transaction correlation token so
    // concurrent writers do not accidentally hydrate each other's snapshots.
    const metadata: ParioCommitMetadata = {
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
        "Pario"
      )}, ${quoteSqlString(input.commitMessage)}, extra_info => ${quoteSqlString(
        JSON.stringify({ pario: metadata })
      )})`
    )
  }

  private async versionForNoOpCommit(
    runtime: DuckDbRuntime,
    definition: DatasetDefinition
  ): Promise<DatasetVersion> {
    const latestVersion = await this.snapshots.getLatestVersionForDefinition(runtime, definition)
    if (latestVersion) {
      return latestVersion
    }

    throw new LakeStorageError(
      `[ParioDuckLake] No DuckLake changes were committed for dataset '${definition.id}', and no previous version exists.`
    )
  }

  private async rollbackTransaction(runtime: DuckDbRuntime): Promise<void> {
    try {
      await runtime.run("ROLLBACK")
    } catch {
      // Preserve the original write failure. DuckDB may already have closed
      // the transaction if COMMIT itself failed.
    }
  }

  private async prepareRuntimeForCommit(runtime: DuckDbRuntime, guarded: boolean): Promise<void> {
    if (guarded) {
      await runtime.run("SET ducklake_max_retry_count = 0")
    }

    // Write sessions can live long enough for other connections to commit.
    // Re-attaching refreshes DuckLake metadata while preserving temp staging
    // tables on the same DuckDB connection.
    await runtime.runStatements([
      `DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`,
      buildAttachSql(this.options),
    ])
  }

  private async latestVersionForCommit(
    input: DuckLakeCommitDatasetVersionInput
  ): Promise<DuckLakeVersionSummary | null> {
    if (input.expectedLatestVersionId === undefined && input.mode !== "append") {
      return null
    }

    return this.snapshots.getLatestVersionSummaryForDefinition(input.runtime, input.dataset)
  }

  private async lastCommittedSnapshotId(runtime: DuckDbRuntime): Promise<string | null> {
    // DuckLake reports the last snapshot committed by this connection. Fresh
    // write runtimes may return null even when the lake already has history.
    const [row] = await runtime.query(
      `SELECT id FROM ${quoteIdentifier(duckLakeAlias(this.options))}.last_committed_snapshot()`
    )
    if (row === undefined || row.id === null || row.id === undefined) {
      return null
    }

    return String(getBigIntLike(row, "id"))
  }

  private async findSnapshotIdByCommitId(
    runtime: DuckDbRuntime,
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
    runtime: DuckDbRuntime,
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
        `[ParioDuckLake] Optimistic commit failed for dataset '${input.datasetId}': expected latest version '${input.expectedLatestVersionId}', found '${input.actualLatestVersionId ?? "none"}'.`
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
    throw new LakeStorageError(`[ParioDuckLake] Invalid DuckLake snapshot id '${snapshotId}'.`)
  }
}
