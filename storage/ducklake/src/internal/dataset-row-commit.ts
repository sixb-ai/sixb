import type { DatasetDefinition } from "@sixb/core"
import {
  type DatasetWriteMode,
  getDatasetPrimaryKeyColumns,
  LakeStorageError,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { datasetSchemaColumnNamesSql } from "./schema"
import { qualifiedTableName, quoteIdentifier } from "./sql"

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
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)

  if (primaryKeyColumns !== null) {
    await inspectUniqueKeyedRelation({
      runtime: input.runtime,
      dataset: input.dataset,
      relationSql: input.sourceRelationSql,
      context: `${input.mode} source`,
    })

    if (input.mode === "append") {
      await inspectUniqueKeyedRelation({
        runtime: input.runtime,
        dataset: input.dataset,
        relationSql: table,
        context: "current baseline",
      })
      await assertNoPrimaryKeyOverlap({
        runtime: input.runtime,
        dataset: input.dataset,
        leftRelationSql: input.sourceRelationSql,
        rightRelationSql: table,
        context: "append",
      })
    }
  }

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

export async function inspectUniqueKeyedRelation(input: {
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly relationSql: string
  readonly context: string
}): Promise<number> {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
  if (primaryKeyColumns === null) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' must define a primaryKey before rows can be keyed.`
    )
  }

  const keysSql = primaryKeyColumns.map((column) => quoteIdentifier(column)).join(", ")
  const [row] = await input.runtime.query(`
    SELECT
      count(*) AS row_count,
      coalesce(max(key_count), 0) AS max_key_count
    FROM (
      SELECT count(*) OVER (PARTITION BY ${keysSql}) AS key_count
      FROM ${input.relationSql}
    ) keyed_rows
  `)

  const rowCount = row === undefined ? 0 : Number(getBigIntLike(row, "row_count"))
  const maxKeyCount = row === undefined ? 0 : Number(getBigIntLike(row, "max_key_count"))
  if (maxKeyCount > 1) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' ${input.context} contains duplicate primary key.`
    )
  }

  return rowCount
}

async function assertNoPrimaryKeyOverlap(input: {
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly leftRelationSql: string
  readonly rightRelationSql: string
  readonly context: string
}): Promise<void> {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
  if (primaryKeyColumns === null) {
    return
  }

  const matchSql = primaryKeyColumns
    .map((column) => `left_rows.${quoteIdentifier(column)} = right_rows.${quoteIdentifier(column)}`)
    .join(" AND ")
  const [collision] = await input.runtime.query(`
    SELECT 1
    FROM ${input.leftRelationSql} left_rows
    JOIN ${input.rightRelationSql} right_rows ON ${matchSql}
    LIMIT 1
  `)
  if (collision !== undefined) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' ${input.context} contains duplicate primary key.`
    )
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
