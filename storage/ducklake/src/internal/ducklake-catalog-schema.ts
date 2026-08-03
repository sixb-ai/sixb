import type { DatasetColumnDefinition, DatasetSchema } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import { duckDbTypeToDatasetColumnType } from "./schema"

export interface DuckLakeCatalogColumn {
  readonly tableName: string
  readonly columnId: bigint
  readonly columnOrder: bigint
  readonly columnName: string
  readonly columnType: string
  readonly nullsAllowed: boolean
  readonly parentColumnId?: bigint
}

const FILE_REF_STRUCT_CHILDREN = [
  { name: "blobId", type: "string" },
  { name: "digest", type: "string" },
  { name: "sizeBytes", type: "int64" },
  { name: "fileName", type: "string" },
  { name: "mediaType", type: "string" },
  { name: "logicalPath", type: "string" },
] satisfies readonly { readonly name: string; readonly type: DatasetColumnDefinition["type"] }[]

export function duckLakeCatalogColumnsToDatasetSchema(
  tableName: string,
  rows: readonly DuckLakeCatalogColumn[]
): DatasetSchema {
  const childrenByParentId = new Map<bigint, DuckLakeCatalogColumn[]>()
  const topLevelColumns: DuckLakeCatalogColumn[] = []

  for (const row of rows) {
    if (row.parentColumnId === undefined) {
      topLevelColumns.push(row)
      continue
    }

    const children = childrenByParentId.get(row.parentColumnId) ?? []
    children.push(row)
    childrenByParentId.set(row.parentColumnId, children)
  }

  return {
    columns: topLevelColumns
      .sort(compareDuckLakeCatalogColumnOrder)
      .map((column) => duckLakeCatalogColumnToDefinition(tableName, column, childrenByParentId)),
  }
}

function duckLakeCatalogColumnToDefinition(
  tableName: string,
  column: DuckLakeCatalogColumn,
  childrenByParentId: ReadonlyMap<bigint, readonly DuckLakeCatalogColumn[]>
): DatasetColumnDefinition {
  const children = [...(childrenByParentId.get(column.columnId) ?? [])].sort(
    compareDuckLakeCatalogColumnOrder
  )
  return {
    name: column.columnName,
    type: duckLakeCatalogColumnTypeToDatasetType(tableName, column, children),
    ...(column.nullsAllowed ? { nullable: true } : {}),
  }
}

function duckLakeCatalogColumnTypeToDatasetType(
  tableName: string,
  column: DuckLakeCatalogColumn,
  children: readonly DuckLakeCatalogColumn[]
): DatasetColumnDefinition["type"] {
  if (children.length === 0 && column.columnType.toLowerCase() !== "struct") {
    return duckDbTypeToDatasetColumnType(column.columnType)
  }

  if (isFileRefStruct(children)) {
    return "fileRef"
  }

  throw new SixbError(
    "storage.lake_failed",
    `[SixbDuckLake] DuckDB column type '${formatDuckLakeCatalogColumnType(
      column,
      children
    )}' in dataset table '${tableName}' cannot be mapped to a Sixb dataset column type.`
  )
}

function compareDuckLakeCatalogColumnOrder(
  left: DuckLakeCatalogColumn,
  right: DuckLakeCatalogColumn
): number {
  return Number(left.columnOrder - right.columnOrder)
}

function isFileRefStruct(children: readonly DuckLakeCatalogColumn[]): boolean {
  if (children.length !== FILE_REF_STRUCT_CHILDREN.length) {
    return false
  }

  return FILE_REF_STRUCT_CHILDREN.every((expected, index) => {
    const child = children[index]
    return (
      child !== undefined &&
      child.columnName === expected.name &&
      duckDbTypeToDatasetColumnType(child.columnType) === expected.type
    )
  })
}

function formatDuckLakeCatalogColumnType(
  column: DuckLakeCatalogColumn,
  children: readonly DuckLakeCatalogColumn[]
): string {
  if (children.length === 0) {
    return column.columnType
  }

  return `STRUCT(${children.map((child) => `${child.columnName} ${child.columnType}`).join(", ")})`
}
