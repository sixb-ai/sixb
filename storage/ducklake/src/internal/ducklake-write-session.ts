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
  readonly runtime: DuckDbRuntime
  readonly stagingTableName: string
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

  try {
    // The temp table lives only on this write connection. That keeps partially
    // written rows invisible until DuckLakeStorage commits them into the
    // durable dataset table.
    await input.runtime.run(
      `CREATE TEMP TABLE ${quoteIdentifier(stagingTableName)} (${datasetSchemaToDuckDbColumnsSql(
        input.write.dataset.schema
      )})`
    )
  } catch (error) {
    await input.runtime.close()
    throw error
  }

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
      }
    })
  }

  async commit(input?: CommitDatasetWriteInput): Promise<DatasetVersion> {
    this.assertOpen()
    this.closed = true

    try {
      return await this.commitWrite({
        write: this.input,
        commit: input,
        runtime: this.runtime,
        stagingTableName: this.stagingTableName,
      })
    } finally {
      // Even successful commits no longer need the staging table or dedicated
      // connection once rows have been inserted into the DuckLake table.
      await this.cleanup()
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
    await this.runtime.close()
  }
}
