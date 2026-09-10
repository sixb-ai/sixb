import type { DatasetDefinition } from "@sixb/core"
import {
  type DatasetSequenceChange,
  type DatasetSequenceState,
  getDatasetPrimaryKeyColumns,
  LakeStorageError,
  reconcileDatasetSequences,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { type ApplyDatasetRowsResult, inspectUniqueKeyedRelation } from "./dataset-row-commit"
import { getBigIntLike, getOptionalString, getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "./names"
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

  return withMaterializedFinalChanges(
    input,
    primaryKeyColumns,
    async (finalChanges, orderingChanged) => {
      const effects = await countMergeEffects(input, targetTable, finalChanges, primaryKeyColumns)
      const effectiveChangeCount = effects.inserts + effects.updates + effects.deletes

      if (effectiveChangeCount === 0) {
        return {
          dataChangeExpected: orderingChanged,
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
    }
  )
}

/** The companion table is current state, committed in the same DuckLake transaction as rows.
 * It is not recovered from expirable snapshot history. Only keys present in staging are read.
 */
async function applySourceOrdering(
  input: ApplyDatasetMergeFromRelationInput,
  acceptedTable: string
): Promise<boolean> {
  const source = quoteIdentifier(`${input.sequenceColumnName}_source`)
  const ordinal = quoteIdentifier(input.sequenceColumnName)
  const staging = quoteIdentifier(input.stagingTableName)
  const stateTable = qualifiedTableName(
    input.options,
    encodeDatasetSequenceTableName(input.dataset.id)
  )
  await input.runtime.run(
    `CREATE TEMP TABLE ${acceptedTable} (source_key VARCHAR, ordinal UBIGINT)`
  )
  let lastOrdinal = -1n
  let changed = false
  while (true) {
    const staged = await input.runtime.query(
      `SELECT ${ordinal} AS ordinal, ${source} AS source FROM ${staging}
       WHERE ${ordinal} > ${lastOrdinal} ORDER BY ${ordinal} LIMIT 1000`
    )
    if (staged.length === 0) return changed
    const changes = staged.map(
      (row) => JSON.parse(getString(row, "source")) as DatasetSequenceChange
    )
    lastOrdinal = getBigIntLike(staged[staged.length - 1]!, "ordinal")
    const batchKeys = changes.map((change) => quoteSqlString(change.key)).join(",")
    const current = await input.runtime.query(
      `SELECT * FROM ${stateTable} WHERE source_key IN (${batchKeys})`
    )
    const previous = new Map<string, DatasetSequenceState>()
    for (const row of current) {
      previous.set(getString(row, "source_key"), {
        sequence: getString(row, "sequence"),
        content: getOptionalString(row, "content") ?? null,
      })
    }
    // Earlier batches are visible inside this transaction. A later conflict rolls them all back.
    const { states, accepted } = reconcileDatasetSequences(input.dataset, previous, changes)
    if (accepted.size === 0) continue
    changed = true
    const stateValues: string[] = []
    const acceptedValues: string[] = []
    for (const [key, index] of accepted) {
      const state = states.get(key)!
      stateValues.push(
        `(${quoteSqlString(key)}, ${quoteSqlString(state.sequence)}, ${state.content === null ? "NULL" : quoteSqlString(state.content)})`
      )
      acceptedValues.push(`(${quoteSqlString(key)}, ${getBigIntLike(staged[index]!, "ordinal")})`)
    }
    const keys = [...accepted.keys()].map(quoteSqlString).join(",")
    await input.runtime.run(`DELETE FROM ${stateTable} WHERE source_key IN (${keys})`)
    await input.runtime.run(`INSERT INTO ${stateTable} VALUES ${stateValues.join(",")}`)
    await input.runtime.run(`DELETE FROM ${acceptedTable} WHERE source_key IN (${keys})`)
    await input.runtime.run(`INSERT INTO ${acceptedTable} VALUES ${acceptedValues.join(",")}`)
  }
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
  run: (finalChangesTable: string, orderingChanged: boolean) => Promise<T>
): Promise<T> {
  const table = quoteIdentifier(`${input.stagingTableName}_final`)
  const acceptedTable = quoteIdentifier(`${input.stagingTableName}_accepted`)

  let outcome:
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "error"; readonly error: unknown }
  try {
    const sequenced = input.dataset.sequenceBy !== undefined
    const orderingChanged = sequenced ? await applySourceOrdering(input, acceptedTable) : false
    const ordinal = quoteIdentifier(input.sequenceColumnName)
    const selectSql = sequenced
      ? `SELECT source.*, source.${ordinal} AS ${quoteIdentifier(firstSequenceName(input.sequenceColumnName))}
         FROM ${quoteIdentifier(input.stagingTableName)} AS source
         JOIN ${acceptedTable} AS accepted ON source.${ordinal} = accepted.ordinal`
      : finalChangesSelectSql(input, primaryKeyColumns)
    await input.runtime.run(`CREATE TEMP TABLE ${table} AS ${selectSql}`)
    outcome = { kind: "success", value: await run(table, orderingChanged) }
  } catch (error) {
    outcome = { kind: "error", error }
  }

  try {
    await input.runtime.run(`DROP TABLE IF EXISTS ${table}`)
    await input.runtime.run(`DROP TABLE IF EXISTS ${acceptedTable}`)
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
