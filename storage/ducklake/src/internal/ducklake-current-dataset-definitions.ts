import type { DatasetDefinition } from "@sixb/core"
import { LakeStorageError } from "@sixb/core"
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
  type DuckLakeCatalogColumn,
  duckLakeCatalogColumnsToDatasetSchema,
} from "./ducklake-catalog-schema"
import { decodeDatasetTableName, encodeDatasetTableName } from "./names"
import { duckLakeAlias, duckLakeMetadataTableName, quoteSqlString, quoteSqlStringList } from "./sql"

interface CurrentDatasetTable {
  readonly datasetId: string
  readonly tableName: string
  readonly comment?: string
}

interface CurrentDatasetPartition {
  readonly tableName: string
  readonly columnName: string
  readonly transform: string
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

  const tables = await readCurrentDatasetTables(input, input.datasetIds)
  if (tables.length === 0) {
    return new Map()
  }

  const tableNames = tables.map((table) => table.tableName)
  const columnsByTableName = groupColumnsByTableName(
    await readCurrentDatasetColumns(input, tableNames)
  )
  const partitionByTableName = groupPartitionsByTableName(
    await readCurrentDatasetPartitions(input, tableNames)
  )
  const definitions = new Map<string, DatasetDefinition>()

  for (const table of tables) {
    const partitionBy = partitionByTableName.get(table.tableName) ?? []
    definitions.set(table.datasetId, {
      kind: "dataset",
      id: table.datasetId,
      schema: duckLakeCatalogColumnsToDatasetSchema(
        table.tableName,
        columnsByTableName.get(table.tableName) ?? []
      ),
      ...(partitionBy.length > 0 ? { partitionBy } : {}),
      ...(table.comment !== undefined ? { description: table.comment } : {}),
    })
  }

  return definitions
}

async function readCurrentDatasetTables(
  input: ReadCurrentDatasetDefinitionsInput,
  datasetIds: readonly string[] | undefined
): Promise<readonly CurrentDatasetTable[]> {
  if (datasetIds !== undefined && datasetIds.length === 0) {
    return []
  }

  const tableNameFilter =
    datasetIds === undefined
      ? ""
      : `AND table_name IN (${quoteSqlStringList(
          [...new Set(datasetIds)].map((datasetId) => encodeDatasetTableName(datasetId))
        )})`

  const rows = await input.runtime.query(
    `SELECT table_name, comment FROM duckdb_tables() WHERE database_name = ${quoteSqlString(
      duckLakeAlias(input.options)
    )} AND schema_name = 'main' ${tableNameFilter} AND NOT internal ORDER BY table_name`
  )

  const tables: CurrentDatasetTable[] = []
  for (const row of rows) {
    const tableName = getString(row, "table_name")
    const datasetId = decodeDatasetTableName(tableName)
    if (datasetId === null) {
      continue
    }

    tables.push({
      datasetId,
      tableName,
      comment: getOptionalString(row, "comment"),
    })
  }

  return tables
}

async function readCurrentDatasetColumns(
  input: ReadCurrentDatasetDefinitionsInput,
  tableNames: readonly string[]
): Promise<readonly DuckLakeCatalogColumn[]> {
  if (tableNames.length === 0) {
    return []
  }

  const ducklakeTable = duckLakeMetadataTableName(input.options, "ducklake_table")
  const ducklakeColumn = duckLakeMetadataTableName(input.options, "ducklake_column")
  const rows = await input.runtime.query(`
    SELECT
      table_meta.table_name,
      column_meta.column_id,
      column_meta.column_order,
      column_meta.column_name,
      column_meta.column_type,
      CAST(column_meta.nulls_allowed AS BOOLEAN) AS nulls_allowed,
      column_meta.parent_column
    FROM ${ducklakeTable} table_meta
    JOIN ${ducklakeColumn} column_meta
      ON column_meta.table_id = table_meta.table_id
      AND column_meta.end_snapshot IS NULL
    WHERE table_meta.end_snapshot IS NULL
      AND table_meta.table_name IN (${quoteSqlStringList(tableNames)})
    ORDER BY table_meta.table_name, column_meta.column_order
  `)

  return rows.map((row) => ({
    tableName: getString(row, "table_name"),
    columnId: getBigIntLike(row, "column_id"),
    columnOrder: getBigIntLike(row, "column_order"),
    columnName: getString(row, "column_name"),
    columnType: getString(row, "column_type"),
    nullsAllowed: getBoolean(row, "nulls_allowed"),
    parentColumnId: getOptionalBigIntLike(row, "parent_column"),
  }))
}

async function readCurrentDatasetPartitions(
  input: ReadCurrentDatasetDefinitionsInput,
  tableNames: readonly string[]
): Promise<readonly CurrentDatasetPartition[]> {
  if (tableNames.length === 0) {
    return []
  }

  const ducklakeTable = duckLakeMetadataTableName(input.options, "ducklake_table")
  const ducklakePartitionInfo = duckLakeMetadataTableName(input.options, "ducklake_partition_info")
  const ducklakePartitionColumn = duckLakeMetadataTableName(
    input.options,
    "ducklake_partition_column"
  )
  const ducklakeColumn = duckLakeMetadataTableName(input.options, "ducklake_column")
  const rows = await input.runtime.query(`
    SELECT
      table_meta.table_name,
      column_meta.column_name,
      partition_column.transform
    FROM ${ducklakeTable} table_meta
    JOIN ${ducklakePartitionInfo} partition_info
      ON partition_info.table_id = table_meta.table_id
      AND partition_info.end_snapshot IS NULL
    JOIN ${ducklakePartitionColumn} partition_column
      ON partition_column.table_id = table_meta.table_id
      AND partition_column.partition_id = partition_info.partition_id
    JOIN ${ducklakeColumn} column_meta
      ON column_meta.table_id = table_meta.table_id
      AND column_meta.column_id = partition_column.column_id
      AND column_meta.end_snapshot IS NULL
    WHERE table_meta.end_snapshot IS NULL
      AND table_meta.table_name IN (${quoteSqlStringList(tableNames)})
    ORDER BY table_meta.table_name, partition_column.partition_key_index
  `)

  return rows.map((row) => {
    const partition = {
      tableName: getString(row, "table_name"),
      columnName: getString(row, "column_name"),
      transform: getString(row, "transform"),
    } satisfies CurrentDatasetPartition

    if (partition.transform !== "identity") {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset table '${partition.tableName}' uses unsupported DuckLake partition transform '${partition.transform}'.`
      )
    }

    return partition
  })
}

function groupColumnsByTableName(
  rows: readonly DuckLakeCatalogColumn[]
): Map<string, DuckLakeCatalogColumn[]> {
  const result = new Map<string, DuckLakeCatalogColumn[]>()
  for (const row of rows) {
    const tableRows = result.get(row.tableName) ?? []
    tableRows.push(row)
    result.set(row.tableName, tableRows)
  }
  return result
}

function groupPartitionsByTableName(
  rows: readonly CurrentDatasetPartition[]
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const row of rows) {
    const tablePartitions = result.get(row.tableName) ?? []
    tablePartitions.push(row.columnName)
    result.set(row.tableName, tablePartitions)
  }
  return result
}
