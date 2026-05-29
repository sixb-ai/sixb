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
import { appendDatasetRow } from "./row-appender"
import { datasetSchemaToDuckDbColumnsSql } from "./schema"
import { quoteIdentifier } from "./sql"

export interface DuckLakeCommitWriteInput {
  readonly write: BeginDatasetWriteInput
  readonly commit?: CommitDatasetWriteInput
  readonly stagingTableName: string
  readonly rowsWritten: number
}

type DuckLakeCommitWrite = (options: DuckLakeCommitWriteInput) => Promise<DatasetVersion>

interface CreateDuckLakeWriteSessionInput {
  readonly commitWrite: DuckLakeCommitWrite
  readonly runtime: DuckDbRuntime
  readonly write: BeginDatasetWriteInput
}

export async function createDuckLakeWriteSession(
  input: CreateDuckLakeWriteSessionInput
): Promise<LakeWriteSession> {
  const stagingTableName = `pario_write_${randomUUID().replaceAll("-", "")}`

  // The temp table lives only on this runtime connection. That keeps
  // partially written rows invisible until DuckLakeStorage commits them into
  // the durable dataset table.
  await input.runtime.run(
    `CREATE TEMP TABLE ${quoteIdentifier(stagingTableName)} (${datasetSchemaToDuckDbColumnsSql(
      input.write.dataset.schema
    )})`
  )

  return new DuckLakeWriteSession(input.commitWrite, input.runtime, input.write, stagingTableName)
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
  private rowsWritten = 0

  constructor(
    private readonly commitWrite: DuckLakeCommitWrite,
    private readonly runtime: DuckDbRuntime,
    private readonly input: BeginDatasetWriteInput,
    private readonly stagingTableName: string
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    await this.runtime.withAppender(this.stagingTableName, async (appender) => {
      for await (const row of rows) {
        const validationError = getDatasetRowValidationError(row, this.input.dataset)
        if (validationError) {
          throw new LakeStorageError(`[ParioDuckLake] ${validationError}`)
        }

        appendDatasetRow(appender, this.input.dataset.schema, row)
        this.rowsWritten += 1
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
        rowsWritten: this.rowsWritten,
        stagingTableName: this.stagingTableName,
      })
      committed = true
      // Even successful commits no longer need the staging table once rows
      // have been inserted into the durable DuckLake table.
      await this.cleanup()
      return version
    } catch (error) {
      if (!committed) {
        await this.cleanup()
      }
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    await this.cleanup()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LakeStorageError("[ParioDuckLake] Write session is already closed.")
    }
  }

  private async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true
    await this.dropStagingTable()
  }

  private async dropStagingTable(): Promise<void> {
    try {
      await this.runtime.run(`DROP TABLE IF EXISTS ${quoteIdentifier(this.stagingTableName)}`)
    } catch {
      // Preserve the commit/abort failure. Temp tables are connection-scoped
      // and will disappear when the storage runtime closes.
    }
  }
}
