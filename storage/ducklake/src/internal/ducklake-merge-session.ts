import { randomUUID } from "node:crypto"
import type { DatasetRow, MergeChange } from "@sixb/core"
import type {
  BeginDatasetMergeInput,
  CommitDatasetMergeInput,
  DatasetMergeCommitResult,
  LakeMergeSession,
} from "@sixb/core/lake-storage"
import {
  cloneDatasetMergeChange,
  getDatasetMergeChangeValidationError,
  LakeStorageError,
} from "@sixb/core/lake-storage"
import type { DuckDbRuntime } from "./duckdb-runtime"
import { appendDatasetRow } from "./row-appender"
import { datasetSchemaToDuckDbNullableColumnsSql } from "./schema"
import { quoteIdentifier } from "./sql"

export interface DuckLakeCommitMergeInput {
  readonly merge: BeginDatasetMergeInput
  readonly baseVersionId: string | null
  readonly commit?: CommitDatasetMergeInput
  readonly stagingTableName: string
  readonly sequenceColumnName: string
  readonly kindColumnName: string
  readonly changesWritten: number
}

type DuckLakeCommitMerge = (input: DuckLakeCommitMergeInput) => Promise<DatasetMergeCommitResult>

const MERGE_CHANGE_BATCH_SIZE = 1000

interface StagedMergeChange {
  readonly sequence: bigint
  readonly change: MergeChange<DatasetRow, DatasetRow>
}

interface CreateDuckLakeMergeSessionInput {
  readonly commitMerge: DuckLakeCommitMerge
  readonly runtime: DuckDbRuntime
  readonly merge: BeginDatasetMergeInput
  readonly baseVersionId: string | null
}

export async function createDuckLakeMergeSession(
  input: CreateDuckLakeMergeSessionInput
): Promise<LakeMergeSession> {
  const suffix = randomUUID().replaceAll("-", "")
  const stagingTableName = `sixb_merge_${suffix}`
  const sequenceColumnName = `sixb_merge_sequence_${suffix}`
  const kindColumnName = `sixb_merge_kind_${suffix}`

  await input.runtime.run(`
    CREATE TEMP TABLE ${quoteIdentifier(stagingTableName)} (
      ${quoteIdentifier(sequenceColumnName)} UBIGINT NOT NULL,
      ${quoteIdentifier(kindColumnName)} VARCHAR NOT NULL,
      ${datasetSchemaToDuckDbNullableColumnsSql(input.merge.dataset.schema)}
    )
  `)

  return new DuckLakeMergeSession(
    input.commitMerge,
    input.runtime,
    input.merge,
    input.baseVersionId,
    stagingTableName,
    sequenceColumnName,
    kindColumnName
  )
}

class DuckLakeMergeSession implements LakeMergeSession {
  private closed = false
  private cleanedUp = false
  private nextSequence = 0n
  private changesWritten = 0

  constructor(
    private readonly commitMerge: DuckLakeCommitMerge,
    private readonly runtime: DuckDbRuntime,
    private readonly input: BeginDatasetMergeInput,
    private readonly baseVersionId: string | null,
    private readonly stagingTableName: string,
    private readonly sequenceColumnName: string,
    private readonly kindColumnName: string
  ) {}

  async writeChanges(
    changes:
      | Iterable<MergeChange<DatasetRow, DatasetRow>>
      | AsyncIterable<MergeChange<DatasetRow, DatasetRow>>
  ): Promise<void> {
    this.assertOpen()

    let batch: StagedMergeChange[] = []
    for await (const change of changes) {
      const validationError = getDatasetMergeChangeValidationError(change, this.input.dataset)
      if (validationError) {
        throw new LakeStorageError(`[SixbDuckLake] ${validationError}`)
      }

      batch.push({
        sequence: this.nextSequence,
        change: cloneDatasetMergeChange(change),
      })
      this.nextSequence += 1n

      if (batch.length >= MERGE_CHANGE_BATCH_SIZE) {
        await this.appendBatchToStagingTable(batch)
        batch = []
      }
    }

    if (batch.length > 0) {
      await this.appendBatchToStagingTable(batch)
    }
  }

  private async appendBatchToStagingTable(batch: readonly StagedMergeChange[]): Promise<void> {
    await this.runtime.withAppender(this.stagingTableName, (appender) => {
      for (const staged of batch) {
        appender.appendBigInt(staged.sequence)
        appender.appendVarchar(staged.change.kind)
        appendDatasetRow(
          appender,
          this.input.dataset.schema,
          staged.change.kind === "upsert" ? staged.change.row : staged.change.key
        )
      }
    })
    this.changesWritten += batch.length
  }

  async commit(input?: CommitDatasetMergeInput): Promise<DatasetMergeCommitResult> {
    this.assertOpen()
    this.closed = true

    let committed = false
    try {
      const result = await this.commitMerge({
        merge: this.input,
        baseVersionId: this.baseVersionId,
        commit: input,
        stagingTableName: this.stagingTableName,
        sequenceColumnName: this.sequenceColumnName,
        kindColumnName: this.kindColumnName,
        changesWritten: this.changesWritten,
      })
      committed = true
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
      throw new LakeStorageError("[SixbDuckLake] Merge session is already closed.")
    }
  }

  private async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true
    try {
      await this.runtime.run(`DROP TABLE IF EXISTS ${quoteIdentifier(this.stagingTableName)}`)
    } catch {
      // Preserve the commit/abort outcome. Temp tables disappear when the storage runtime closes.
    }
  }
}
