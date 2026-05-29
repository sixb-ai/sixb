import { type DatasetDefinition, type DatasetWriteMode, LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { datasetSchemaColumnNamesSql } from "./schema"
import { qualifiedTableName } from "./sql"

export type CommitRowCount =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "unknown" }

export interface ApplyDatasetRowsResult {
  readonly dataChangeExpected: boolean
  readonly sourceRowCount: number
  readonly resultingRowCount: CommitRowCount
}

export function assertDatasetWriteMode(
  mode: unknown,
  operation: string
): asserts mode is DatasetWriteMode {
  if (mode !== "snapshot" && mode !== "append") {
    throw new LakeStorageError(
      `[ParioDuckLake] Invalid ${operation} mode '${String(mode)}'. Expected 'snapshot' or 'append'.`
    )
  }
}

export async function applyDatasetRowsFromRelation(input: {
  readonly options: DuckLakeStorageOptions
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  /** Provider-rendered relation SQL, such as a quoted staging or temp table. */
  readonly sourceRelationSql: string
  readonly previousRowCount?: number
}): Promise<ApplyDatasetRowsResult> {
  const tableName = encodeDatasetTableName(input.dataset.id)
  const table = qualifiedTableName(input.options, tableName)
  const columnsSql = datasetSchemaColumnNamesSql(input.dataset.schema)
  const sourceRowCount = await countRows(input.runtime, input.sourceRelationSql)
  const existingRowCount =
    input.mode === "snapshot" && sourceRowCount === 0
      ? (input.previousRowCount ?? (await countRows(input.runtime, table)))
      : 0

  if (input.mode === "snapshot") {
    await input.runtime.run(`DELETE FROM ${table}`)
  }

  await input.runtime.run(
    `INSERT INTO ${table} (${columnsSql}) SELECT ${columnsSql} FROM ${input.sourceRelationSql}`
  )

  if (input.mode === "append") {
    return {
      dataChangeExpected: sourceRowCount > 0,
      sourceRowCount,
      resultingRowCount:
        input.previousRowCount === undefined
          ? { kind: "unknown" }
          : { kind: "exact", value: input.previousRowCount + sourceRowCount },
    }
  }

  return {
    dataChangeExpected: sourceRowCount > 0 || existingRowCount > 0,
    sourceRowCount,
    resultingRowCount: { kind: "exact", value: sourceRowCount },
  }
}

async function countRows(runtime: DuckDbQueryRuntime, relationSql: string): Promise<number> {
  const [row] = await runtime.query(`SELECT count(*) AS row_count FROM ${relationSql}`)
  if (row === undefined) {
    return 0
  }

  return Number(getBigIntLike(row, "row_count"))
}
