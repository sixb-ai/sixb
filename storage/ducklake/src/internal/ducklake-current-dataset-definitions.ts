import type { DatasetDefinition } from "@sixb/core"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import {
  getBigIntLike,
  getBoolean,
  getOptionalBigIntLike,
  getOptionalString,
  getString,
} from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import {
  DATASET_SEQUENCE_COLUMN_COMMENT,
  type DuckLakeCatalogColumn,
  duckLakeCatalogColumnsToDatasetPrimaryKey,
  duckLakeCatalogColumnsToDatasetSchema,
} from "./ducklake-catalog-schema"
import { decodeDatasetTableName, encodeDatasetTableName } from "./names"
import { buildDuckLakeMetadataQuery, quoteSqlStringList } from "./sql"

interface CatalogPartition {
  readonly keyIndex: bigint
  readonly transform: string
}

interface CatalogColumnRow {
  readonly tableComment?: string
  readonly column: DuckLakeCatalogColumn
  readonly partition?: CatalogPartition
}

interface CatalogTable {
  readonly datasetId: string
  readonly tableName: string
  readonly comment?: string
  readonly rows: CatalogColumnRow[]
}

export interface ReadCurrentDatasetDefinitionsInput {
  readonly options: DuckLakeStorageOptions
  readonly runtime: DuckDbQueryRuntime
  readonly datasetIds?: readonly string[]
}

export async function readCurrentDatasetDefinitions(
  input: ReadCurrentDatasetDefinitionsInput
): Promise<Map<string, DatasetDefinition>> {
  if (input.datasetIds?.length === 0) {
    return new Map()
  }

  const tables = groupByTable(await readCurrentDatasetCatalogRows(input))
  const definitions = new Map<string, DatasetDefinition>()

  for (const table of tables) {
    const columns = table.rows.map((row) => row.column)
    const primaryKey = duckLakeCatalogColumnsToDatasetPrimaryKey(table.tableName, columns)
    const sequenceBy = columns.find(
      (column) => column.comment === DATASET_SEQUENCE_COLUMN_COMMENT
    )?.columnName
    const partitionBy = table.rows
      .flatMap(({ column, partition }) => (partition === undefined ? [] : [{ column, partition }]))
      .sort((left, right) => Number(left.partition.keyIndex - right.partition.keyIndex))
      .map(({ column, partition }) => partitionColumnName(table.tableName, column, partition))

    definitions.set(table.datasetId, {
      kind: "dataset",
      id: table.datasetId,
      schema: duckLakeCatalogColumnsToDatasetSchema(table.tableName, columns),
      ...(primaryKey !== undefined ? { primaryKey } : {}),
      ...(sequenceBy !== undefined ? { sequenceBy } : {}),
      ...(partitionBy.length > 0 ? { partitionBy } : {}),
      ...(table.comment !== undefined ? { description: table.comment } : {}),
    })
  }

  return definitions
}

/**
 * Every current column of the datasets' tables, with its table's comment and its place in the
 * table's partitioning, from one query of the committed catalog rows. A small write reads its
 * definition twice: one round trip each, and never `duckdb_tables()`, which loads DuckLake's
 * whole catalog first.
 */
async function readCurrentDatasetCatalogRows(
  input: ReadCurrentDatasetDefinitionsInput
): Promise<readonly CatalogColumnRow[]> {
  const tableNameFilter =
    input.datasetIds === undefined
      ? ""
      : `AND table_meta.table_name IN (${quoteSqlStringList(
          [...new Set(input.datasetIds)].map((datasetId) => encodeDatasetTableName(datasetId))
        )})`

  const rows = await input.runtime.query(
    buildDuckLakeMetadataQuery(
      input.options,
      (table) => `
        SELECT
          table_meta.table_name,
          table_tag."value" AS table_comment,
          column_meta.column_id,
          column_meta.column_order,
          column_meta.column_name,
          column_meta.column_type,
          CAST(column_meta.nulls_allowed AS BOOLEAN) AS nulls_allowed,
          column_meta.parent_column,
          column_tag."value" AS comment,
          partition_column.partition_key_index,
          partition_column.transform
        FROM ${table("ducklake_table")} table_meta
        JOIN ${table("ducklake_schema")} schema_meta
          ON schema_meta.schema_id = table_meta.schema_id
          AND schema_meta.end_snapshot IS NULL
          AND schema_meta.schema_name = 'main'
        JOIN ${table("ducklake_column")} column_meta
          ON column_meta.table_id = table_meta.table_id
          AND column_meta.end_snapshot IS NULL
        LEFT JOIN ${table("ducklake_tag")} table_tag
          ON table_tag.object_id = table_meta.table_id
          AND table_tag."key" = 'comment'
          AND table_tag.end_snapshot IS NULL
        LEFT JOIN ${table("ducklake_column_tag")} column_tag
          ON column_tag.table_id = column_meta.table_id
          AND column_tag.column_id = column_meta.column_id
          AND column_tag."key" = 'comment'
          AND column_tag.end_snapshot IS NULL
        LEFT JOIN ${table("ducklake_partition_info")} partition_info
          ON partition_info.table_id = table_meta.table_id
          AND partition_info.end_snapshot IS NULL
        LEFT JOIN ${table("ducklake_partition_column")} partition_column
          ON partition_column.table_id = table_meta.table_id
          AND partition_column.partition_id = partition_info.partition_id
          AND partition_column.column_id = column_meta.column_id
        WHERE table_meta.end_snapshot IS NULL ${tableNameFilter}
        ORDER BY table_meta.table_name, column_meta.column_order
      `
    )
  )

  return rows.map((row) => {
    const partitionKeyIndex = getOptionalBigIntLike(row, "partition_key_index")

    return {
      tableComment: getOptionalString(row, "table_comment"),
      column: {
        tableName: getString(row, "table_name"),
        columnId: getBigIntLike(row, "column_id"),
        columnOrder: getBigIntLike(row, "column_order"),
        columnName: getString(row, "column_name"),
        columnType: getString(row, "column_type"),
        nullsAllowed: getBoolean(row, "nulls_allowed"),
        parentColumnId: getOptionalBigIntLike(row, "parent_column"),
        comment: getOptionalString(row, "comment"),
      },
      ...(partitionKeyIndex === undefined
        ? {}
        : {
            partition: { keyIndex: partitionKeyIndex, transform: getString(row, "transform") },
          }),
    }
  })
}

/** The rows of each dataset table, in table order, skipping tables that hold no dataset. */
function groupByTable(rows: readonly CatalogColumnRow[]): readonly CatalogTable[] {
  const tables = new Map<string, CatalogTable>()

  for (const row of rows) {
    const tableName = row.column.tableName
    const datasetId = decodeDatasetTableName(tableName)
    if (datasetId === null) {
      continue
    }

    const table = tables.get(tableName) ?? {
      datasetId,
      tableName,
      ...(row.tableComment === undefined ? {} : { comment: row.tableComment }),
      rows: [],
    }
    table.rows.push(row)
    tables.set(tableName, table)
  }

  return [...tables.values()]
}

function partitionColumnName(
  tableName: string,
  column: DuckLakeCatalogColumn,
  partition: CatalogPartition
): string {
  if (partition.transform !== "identity") {
    throw new LakeStorageError(
      `[SixbDuckLake] Dataset table '${tableName}' uses unsupported DuckLake partition transform '${partition.transform}'.`
    )
  }

  return column.columnName
}
