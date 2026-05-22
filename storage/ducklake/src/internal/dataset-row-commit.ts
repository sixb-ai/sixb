import { type DatasetDefinition, type DatasetWriteMode, LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { datasetSchemaColumnNamesSql } from "./schema"
import { qualifiedTableName } from "./sql"

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
  readonly runtime: DuckDbRuntime
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode
  /** Provider-rendered relation SQL, such as a quoted staging or temp table. */
  readonly sourceRelationSql: string
}): Promise<boolean> {
  const tableName = encodeDatasetTableName(input.dataset.id)
  const table = qualifiedTableName(input.options, tableName)
  const columnsSql = datasetSchemaColumnNamesSql(input.dataset.schema)
  const sourceRowCount = await countRows(input.runtime, input.sourceRelationSql)
  const existingRowCount = input.mode === "snapshot" ? await countRows(input.runtime, table) : 0

  if (input.mode === "snapshot") {
    await input.runtime.run(`DELETE FROM ${table}`)
  }

  await input.runtime.run(
    `INSERT INTO ${table} (${columnsSql}) SELECT ${columnsSql} FROM ${input.sourceRelationSql}`
  )

  return input.mode === "append" ? sourceRowCount > 0 : sourceRowCount > 0 || existingRowCount > 0
}

async function countRows(runtime: DuckDbRuntime, relationSql: string): Promise<number> {
  const [row] = await runtime.query(`SELECT count(*) AS row_count FROM ${relationSql}`)
  if (row === undefined) {
    return 0
  }

  return Number(getBigIntLike(row, "row_count"))
}
