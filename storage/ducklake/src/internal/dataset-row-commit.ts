import type { DatasetDefinition } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import type { DatasetWriteMode } from "@sixb/core/lake-storage"
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
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Invalid ${operation} mode '${String(mode)}'. Expected 'snapshot' or 'append'.`
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

  if (input.mode === "snapshot") {
    const source = await fingerprintRelation(input.runtime, input.sourceRelationSql, columnsSql)
    const target = await fingerprintRelation(input.runtime, table, columnsSql)

    if (sameFingerprint(source, target)) {
      return {
        dataChangeExpected: false,
        sourceRowCount: source.rowCount,
        resultingRowCount: { kind: "exact", value: target.rowCount },
      }
    }

    await input.runtime.run(`DELETE FROM ${table}`)
    await input.runtime.run(
      `INSERT INTO ${table} (${columnsSql}) SELECT ${columnsSql} FROM ${input.sourceRelationSql}`
    )

    return {
      dataChangeExpected: source.rowCount > 0 || target.rowCount > 0,
      sourceRowCount: source.rowCount,
      resultingRowCount: { kind: "exact", value: source.rowCount },
    }
  }

  const sourceRowCount = await countRows(input.runtime, input.sourceRelationSql)
  await input.runtime.run(
    `INSERT INTO ${table} (${columnsSql}) SELECT ${columnsSql} FROM ${input.sourceRelationSql}`
  )

  return {
    dataChangeExpected: sourceRowCount > 0,
    sourceRowCount,
    resultingRowCount:
      input.previousRowCount === undefined
        ? { kind: "unknown" }
        : { kind: "exact", value: input.previousRowCount + sourceRowCount },
  }
}

interface RelationFingerprint {
  readonly rowCount: number
  readonly hashSum: string
  readonly hashXor: string
}

async function fingerprintRelation(
  runtime: DuckDbQueryRuntime,
  relationSql: string,
  columnsSql: string
): Promise<RelationFingerprint> {
  const [row] = await runtime.query(`
    SELECT
      count(*) AS row_count,
      coalesce(sum(hash(${columnsSql})::HUGEINT), 0::HUGEINT) AS hash_sum,
      coalesce(bit_xor(hash('sixb:snapshot:v1', ${columnsSql})), 0::UBIGINT) AS hash_xor
    FROM ${relationSql}
  `)

  if (row === undefined) {
    return { rowCount: 0, hashSum: "0", hashXor: "0" }
  }

  return {
    rowCount: Number(getBigIntLike(row, "row_count")),
    hashSum: getBigIntLike(row, "hash_sum").toString(),
    hashXor: getBigIntLike(row, "hash_xor").toString(),
  }
}

function sameFingerprint(left: RelationFingerprint, right: RelationFingerprint): boolean {
  return (
    left.rowCount === right.rowCount &&
    left.hashSum === right.hashSum &&
    left.hashXor === right.hashXor
  )
}

async function countRows(runtime: DuckDbQueryRuntime, relationSql: string): Promise<number> {
  const [row] = await runtime.query(`SELECT count(*) AS row_count FROM ${relationSql}`)
  if (row === undefined) {
    return 0
  }

  return Number(getBigIntLike(row, "row_count"))
}
