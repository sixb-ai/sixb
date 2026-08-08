import type { DatasetDefinition } from "@sixb/core"
import { getDatasetPrimaryKeyColumns, LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { type ApplyDatasetRowsResult, inspectUniqueKeyedRelation } from "./dataset-row-commit"
import { getBigIntLike } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetTableName } from "./names"
import { datasetSchemaColumnNamesSql } from "./schema"
import { qualifiedTableName, quoteIdentifier, quoteSqlString } from "./sql"

export interface ApplyDatasetMergeFromRelationInput {
  readonly options: DuckLakeStorageOptions
  readonly runtime: DuckDbQueryRuntime
  readonly dataset: DatasetDefinition
  readonly stagingTableName: string
  readonly sequenceColumnName: string
  readonly kindColumnName: string
  readonly previousRowCount?: number
  readonly validatedPrimaryKeyColumns?: readonly string[]
}

interface MergeEffectCounts {
  readonly inserts: number
  readonly updates: number
  readonly deletes: number
}

export async function applyDatasetMergeFromRelation(
  input: ApplyDatasetMergeFromRelationInput
): Promise<ApplyDatasetRowsResult> {
  const primaryKeyColumns = getDatasetPrimaryKeyColumns(input.dataset)
  if (primaryKeyColumns === null) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' must define a primaryKey before it can be merged.`
    )
  }

  const stagingTable = quoteIdentifier(input.stagingTableName)
  const targetTable = qualifiedTableName(input.options, encodeDatasetTableName(input.dataset.id))
  const sourceRowCount = await countRows(input.runtime, stagingTable)
  const previousRowCount = await currentBaselineRowCount(input, targetTable, primaryKeyColumns)

  return withMaterializedFinalChanges(input, primaryKeyColumns, async (finalChanges) => {
    const effects = await countMergeEffects(input, targetTable, finalChanges, primaryKeyColumns)
    const effectiveChangeCount = effects.inserts + effects.updates + effects.deletes

    if (effectiveChangeCount === 0) {
      return {
        dataChangeExpected: false,
        sourceRowCount,
        resultingRowCount: { kind: "exact", value: previousRowCount },
      }
    }

    const keyMatchSql = primaryKeyMatchSql(primaryKeyColumns, "target", "source")
    const rowDifferenceSql = datasetRowDifferenceSql(input.dataset, "target", "source")
    const kindColumn = `source.${quoteIdentifier(input.kindColumnName)}`

    await input.runtime.run(`
      DELETE FROM ${targetTable} AS target
      USING ${finalChanges} AS source
      WHERE ${keyMatchSql}
        AND (
          ${kindColumn} = ${quoteSqlString("delete")}
          OR (
            ${kindColumn} = ${quoteSqlString("upsert")}
            AND (${rowDifferenceSql})
          )
        )
    `)

    const columnsSql = datasetSchemaColumnNamesSql(input.dataset.schema)
    const selectedColumnsSql = input.dataset.schema.columns
      .map((column) => `source.${quoteIdentifier(column.name)}`)
      .join(", ")
    const firstSequenceColumnName = firstSequenceName(input.sequenceColumnName)
    await input.runtime.run(`
      INSERT INTO ${targetTable} (${columnsSql})
      SELECT ${selectedColumnsSql}
      FROM ${finalChanges} AS source
      WHERE ${kindColumn} = ${quoteSqlString("upsert")}
        AND NOT EXISTS (
          SELECT 1
          FROM ${targetTable} AS target
          WHERE ${keyMatchSql}
        )
      ORDER BY source.${quoteIdentifier(firstSequenceColumnName)}
    `)

    return {
      dataChangeExpected: true,
      sourceRowCount,
      resultingRowCount: {
        kind: "exact",
        value: previousRowCount + effects.inserts - effects.deletes,
      },
    }
  })
}

async function currentBaselineRowCount(
  input: ApplyDatasetMergeFromRelationInput,
  targetTable: string,
  primaryKeyColumns: readonly string[]
): Promise<number> {
  // Sixb writes mark keyed versions only after the write path has enforced uniqueness. Older or
  // external versions carry no marker and keep the full defensive audit.
  if (sameColumns(input.validatedPrimaryKeyColumns, primaryKeyColumns)) {
    return input.previousRowCount ?? countRows(input.runtime, targetTable)
  }

  return inspectUniqueKeyedRelation({
    runtime: input.runtime,
    dataset: input.dataset,
    relationSql: targetTable,
    context: "current baseline",
  })
}

async function withMaterializedFinalChanges<T>(
  input: ApplyDatasetMergeFromRelationInput,
  primaryKeyColumns: readonly string[],
  run: (finalChangesTable: string) => Promise<T>
): Promise<T> {
  const table = quoteIdentifier(`${input.stagingTableName}_final`)
  await input.runtime.run(`
    CREATE TEMP TABLE ${table} AS
    ${finalChangesSelectSql(input, primaryKeyColumns)}
  `)

  let outcome:
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "error"; readonly error: unknown }
  try {
    outcome = { kind: "success", value: await run(table) }
  } catch (error) {
    outcome = { kind: "error", error }
  }

  try {
    await input.runtime.run(`DROP TABLE IF EXISTS ${table}`)
  } catch (cleanupError) {
    if (outcome.kind === "success") {
      throw cleanupError
    }
  }

  if (outcome.kind === "error") {
    throw outcome.error
  }

  return outcome.value
}

function finalChangesSelectSql(
  input: ApplyDatasetMergeFromRelationInput,
  primaryKeyColumns: readonly string[]
): string {
  const sequenceColumn = quoteIdentifier(input.sequenceColumnName)
  const keyColumnsSql = primaryKeyColumns.map((column) => quoteIdentifier(column)).join(", ")
  const rankColumn = quoteIdentifier(rankName(input.sequenceColumnName))
  const firstSequenceColumn = quoteIdentifier(firstSequenceName(input.sequenceColumnName))

  return `
    SELECT * EXCLUDE (${rankColumn})
    FROM (
      SELECT
        *,
        min(${sequenceColumn}) OVER (PARTITION BY ${keyColumnsSql}) AS ${firstSequenceColumn},
        row_number() OVER (
          PARTITION BY ${keyColumnsSql}
          ORDER BY ${sequenceColumn} DESC
        ) AS ${rankColumn}
      FROM ${quoteIdentifier(input.stagingTableName)}
    ) ranked_changes
    WHERE ${rankColumn} = 1
  `
}

async function countMergeEffects(
  input: ApplyDatasetMergeFromRelationInput,
  targetTable: string,
  finalChanges: string,
  primaryKeyColumns: readonly string[]
): Promise<MergeEffectCounts> {
  const matchColumn = primaryKeyColumns[0]
  if (matchColumn === undefined) {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset '${input.dataset.id}' primaryKey must contain at least one column.`
    )
  }

  const keyMatchSql = primaryKeyMatchSql(primaryKeyColumns, "target", "source")
  const targetMatch = `target.${quoteIdentifier(matchColumn)} IS NOT NULL`
  const kindColumn = `source.${quoteIdentifier(input.kindColumnName)}`
  const rowDifferenceSql = datasetRowDifferenceSql(input.dataset, "target", "source")
  const [row] = await input.runtime.query(`
    SELECT
      count(*) FILTER (
        WHERE ${kindColumn} = ${quoteSqlString("upsert")} AND NOT (${targetMatch})
      ) AS insert_count,
      count(*) FILTER (
        WHERE ${kindColumn} = ${quoteSqlString("upsert")}
          AND ${targetMatch}
          AND (${rowDifferenceSql})
      ) AS update_count,
      count(*) FILTER (
        WHERE ${kindColumn} = ${quoteSqlString("delete")} AND ${targetMatch}
      ) AS delete_count
    FROM ${finalChanges} AS source
    LEFT JOIN ${targetTable} AS target ON ${keyMatchSql}
  `)

  return {
    inserts: row === undefined ? 0 : Number(getBigIntLike(row, "insert_count")),
    updates: row === undefined ? 0 : Number(getBigIntLike(row, "update_count")),
    deletes: row === undefined ? 0 : Number(getBigIntLike(row, "delete_count")),
  }
}

function primaryKeyMatchSql(
  primaryKeyColumns: readonly string[],
  leftAlias: string,
  rightAlias: string
): string {
  return primaryKeyColumns
    .map(
      (column) =>
        `${leftAlias}.${quoteIdentifier(column)} = ${rightAlias}.${quoteIdentifier(column)}`
    )
    .join(" AND ")
}

function datasetRowDifferenceSql(
  dataset: DatasetDefinition,
  leftAlias: string,
  rightAlias: string
): string {
  return dataset.schema.columns
    .map(
      (column) =>
        `${leftAlias}.${quoteIdentifier(column.name)} IS DISTINCT FROM ${rightAlias}.${quoteIdentifier(
          column.name
        )}`
    )
    .join(" OR ")
}

async function countRows(runtime: DuckDbQueryRuntime, relationSql: string): Promise<number> {
  const [row] = await runtime.query(`SELECT count(*) AS row_count FROM ${relationSql}`)
  return row === undefined ? 0 : Number(getBigIntLike(row, "row_count"))
}

function rankName(sequenceColumnName: string): string {
  return `${sequenceColumnName}_rank`
}

function firstSequenceName(sequenceColumnName: string): string {
  return `${sequenceColumnName}_first`
}

function sameColumns(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}
