import { randomUUID } from "node:crypto"
import type { DatasetRow } from "@sixb/core"
import { getDatasetRowValidationError } from "@sixb/core"
import type {
  BeginDatasetWriteInput,
  CommitDatasetWriteInput,
  DatasetWriteCommitResult,
  LakeWriteSession,
} from "@sixb/core/lake-storage"
import {
  encodeDatasetPrimaryKey,
  getDatasetPrimaryKeyColumns,
  LakeStorageError,
} from "@sixb/core/lake-storage"
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

type DuckLakeCommitWrite = (options: DuckLakeCommitWriteInput) => Promise<DatasetWriteCommitResult>

// Rows are staged in bounded in-memory batches so a slow source iterable never
// holds the DuckDB runtime queue. Only the per-batch appender flush takes a
// queue slot. 1000 keeps memory bounded while amortizing appender open/close.
const WRITE_ROW_BATCH_SIZE = 1000

interface CreateDuckLakeWriteSessionInput {
  readonly commitWrite: DuckLakeCommitWrite
  readonly runtime: DuckDbRuntime
  readonly write: BeginDatasetWriteInput
}

export async function createDuckLakeWriteSession(
  input: CreateDuckLakeWriteSessionInput
): Promise<LakeWriteSession> {
  const stagingTableName = `sixb_write_${randomUUID().replaceAll("-", "")}`

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
  private readonly stagedPrimaryKeys = new Set<string>()

  constructor(
    private readonly commitWrite: DuckLakeCommitWrite,
    private readonly runtime: DuckDbRuntime,
    private readonly input: BeginDatasetWriteInput,
    private readonly stagingTableName: string
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    // Drain and validate the source OUTSIDE the DuckDB queue so slow external
    // reads (pagination, APIs, SFTP, retries) never hold a runtime slot. Only
    // appendBatchToStagingTable below briefly enters the queue.
    let batch: DatasetRow[] = []
    let batchPrimaryKeys = new Set<string>()
    for await (const row of rows) {
      const validationError = getDatasetRowValidationError(row, this.input.dataset)
      if (validationError) {
        throw new LakeStorageError(`[SixbDuckLake] ${validationError}`)
      }

      // Snapshot the validated row. Callers may reuse and mutate one row object
      // between yields, so the batch must not retain a live reference.
      const clonedRow = structuredClone(row)
      if (getDatasetPrimaryKeyColumns(this.input.dataset) !== null) {
        const primaryKey = encodeDatasetPrimaryKey(this.input.dataset, clonedRow)
        if (this.stagedPrimaryKeys.has(primaryKey) || batchPrimaryKeys.has(primaryKey)) {
          throw new LakeStorageError(
            `[SixbDuckLake] Dataset '${this.input.dataset.id}' ${this.input.mode ?? "snapshot"} source contains duplicate primary key.`
          )
        }
        batchPrimaryKeys.add(primaryKey)
      }
      batch.push(clonedRow)

      if (batch.length >= WRITE_ROW_BATCH_SIZE) {
        await this.appendBatchToStagingTable(batch, batchPrimaryKeys)
        batch = []
        batchPrimaryKeys = new Set()
      }
    }

    if (batch.length > 0) {
      await this.appendBatchToStagingTable(batch, batchPrimaryKeys)
    }
  }

  private async appendBatchToStagingTable(
    batch: readonly DatasetRow[],
    primaryKeys: ReadonlySet<string>
  ): Promise<void> {
    // Synchronous callback: no awaits inside the queue slot. The appender
    // buffers and flushes the whole batch into the staging temp table on close.
    await this.runtime.withAppender(this.stagingTableName, (appender) => {
      for (const row of batch) {
        appendDatasetRow(appender, this.input.dataset.schema, row)
      }
    })
    // Count only rows actually appended -- commit asserts rowsWritten ===
    // sourceRowCount in the write coordinator.
    this.rowsWritten += batch.length
    for (const primaryKey of primaryKeys) {
      this.stagedPrimaryKeys.add(primaryKey)
    }
  }

  async commit(input?: CommitDatasetWriteInput): Promise<DatasetWriteCommitResult> {
    this.assertOpen()
    this.closed = true

    let committed = false
    try {
      const result = await this.commitWrite({
        write: this.input,
        commit: input,
        rowsWritten: this.rowsWritten,
        stagingTableName: this.stagingTableName,
      })
      committed = true
      // Even successful commits no longer need the staging table once rows
      // have been inserted into the durable DuckLake table.
      await this.cleanup()
      return result
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
      throw new LakeStorageError("[SixbDuckLake] Write session is already closed.")
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
