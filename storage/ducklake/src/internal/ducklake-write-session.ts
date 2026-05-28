import { randomUUID } from "node:crypto"
import type {
  BeginDatasetWriteInput,
  CommitDatasetWriteInput,
  DatasetRow,
  DatasetVersion,
  LakeWriteSession,
} from "@pario/core"
import { getDatasetRowValidationError, LakeStorageError } from "@pario/core"
import type { DuckDbRuntime } from "./duckdb-runtime"
import type {
  DuckLakeWriteRuntimeLease,
  DuckLakeWriteRuntimeRelease,
} from "./ducklake-connection-manager"
import { appendDatasetRow } from "./row-appender"
import { datasetSchemaToDuckDbColumnsSql } from "./schema"
import { quoteIdentifier } from "./sql"

export interface DuckLakeCommitWriteInput {
  readonly write: BeginDatasetWriteInput
  readonly commit?: CommitDatasetWriteInput
  readonly runtime: DuckDbRuntime
  readonly stagingTableName: string
}

type DuckLakeCommitWrite = (options: DuckLakeCommitWriteInput) => Promise<DatasetVersion>

interface CreateDuckLakeWriteSessionInput {
  readonly commitWrite: DuckLakeCommitWrite
  readonly lease: DuckLakeWriteRuntimeLease
  readonly write: BeginDatasetWriteInput
}

export async function createDuckLakeWriteSession(
  input: CreateDuckLakeWriteSessionInput
): Promise<LakeWriteSession> {
  const stagingTableName = `pario_write_${randomUUID().replaceAll("-", "")}`

  try {
    // The temp table lives only on this write connection. That keeps partially
    // written rows invisible until DuckLakeStorage commits them into the
    // durable dataset table.
    await input.lease.runtime.run(
      `CREATE TEMP TABLE ${quoteIdentifier(stagingTableName)} (${datasetSchemaToDuckDbColumnsSql(
        input.write.dataset.schema
      )})`
    )
  } catch (error) {
    await input.lease.release({ kind: "failed" })
    throw error
  }

  return new DuckLakeWriteSession(input.commitWrite, input.lease, input.write, stagingTableName)
}

/**
 * Package-private LakeWriteSession implementation for DuckLakeStorage.
 *
 * The session owns row validation, the connection-scoped staging table, and
 * cleanup. DuckLakeStorage owns the durable transaction because it has the
 * dataset/version context needed to build the returned DatasetVersion.
 */
class DuckLakeWriteSession implements LakeWriteSession {
  private closed = false
  private cleanedUp = false

  constructor(
    private readonly commitWrite: DuckLakeCommitWrite,
    private readonly lease: DuckLakeWriteRuntimeLease,
    private readonly input: BeginDatasetWriteInput,
    private readonly stagingTableName: string
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    await this.lease.runtime.withAppender(this.stagingTableName, async (appender) => {
      for await (const row of rows) {
        const validationError = getDatasetRowValidationError(row, this.input.dataset)
        if (validationError) {
          throw new LakeStorageError(`[ParioDuckLake] ${validationError}`)
        }

        appendDatasetRow(appender, this.input.dataset.schema, row)
      }
    })
  }

  async commit(input?: CommitDatasetWriteInput): Promise<DatasetVersion> {
    this.assertOpen()
    this.closed = true

    let committed = false
    try {
      const version = await this.commitWrite({
        write: this.input,
        commit: input,
        runtime: this.lease.runtime,
        stagingTableName: this.stagingTableName,
      })
      committed = true
      // Even successful commits no longer need the staging table or dedicated
      // lease once rows have been inserted into the DuckLake table.
      await this.cleanup({
        kind: "committed",
        guarded: input?.expectedLatestVersionId !== undefined,
        reusable: true,
      })
      return version
    } catch (error) {
      if (!committed) {
        await this.cleanup({ kind: "failed" })
      }
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    await this.cleanup({ kind: "aborted" })
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LakeStorageError("[ParioDuckLake] Write session is already closed.")
    }
  }

  private async cleanup(release: DuckLakeWriteRuntimeRelease): Promise<void> {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true

    if (release.kind === "failed") {
      await this.lease.release(release)
      return
    }

    const reusable = await this.dropStagingTable()
    const releaseResult =
      release.kind === "committed"
        ? { ...release, reusable: release.reusable && reusable }
        : { ...release, reusable }

    await this.lease.release(releaseResult)
  }

  private async dropStagingTable(): Promise<boolean> {
    try {
      await this.lease.runtime.run(`DROP TABLE IF EXISTS ${quoteIdentifier(this.stagingTableName)}`)
      return true
    } catch {
      return false
    }
  }
}
