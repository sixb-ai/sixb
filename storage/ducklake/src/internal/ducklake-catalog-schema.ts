import type { DatasetColumnDefinition, DatasetPrimaryKey, DatasetSchema } from "@sixb/core"
import { LakeStorageError } from "@sixb/core/lake-storage"
import { duckDbTypeToDatasetColumnType } from "./schema"

export interface DuckLakeCatalogColumn {
  readonly tableName: string
  readonly columnId: bigint
  readonly columnOrder: bigint
  readonly columnName: string
  readonly columnType: string
  readonly nullsAllowed: boolean
  readonly parentColumnId?: bigint
  readonly comment?: string
}

const SIXB_PRIMARY_KEY_COMMENT_NAMESPACE = "sixb:primary-key:"
const SIXB_PRIMARY_KEY_COMMENT_PREFIX = `${SIXB_PRIMARY_KEY_COMMENT_NAMESPACE}v1:`

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

export function duckLakePrimaryKeyColumnComment(ordinal: number): string {
  return `${SIXB_PRIMARY_KEY_COMMENT_PREFIX}${ordinal}`
}

export function duckLakeCatalogColumnsToDatasetPrimaryKey(
  tableName: string,
  rows: readonly DuckLakeCatalogColumn[]
): DatasetPrimaryKey | undefined {
  const keyedColumns: { readonly column: DuckLakeCatalogColumn; readonly ordinal: number }[] = []
  const seenOrdinals = new Set<number>()

  for (const column of rows) {
    const comment = column.comment
    if (comment === undefined || !comment.startsWith(SIXB_PRIMARY_KEY_COMMENT_NAMESPACE)) {
      continue
    }

    if (
      column.parentColumnId !== undefined ||
      !comment.startsWith(SIXB_PRIMARY_KEY_COMMENT_PREFIX)
    ) {
      throwInvalidPrimaryKeyMetadata(tableName, column, comment)
    }

    const ordinalText = comment.slice(SIXB_PRIMARY_KEY_COMMENT_PREFIX.length)
    if (!/^(0|[1-9]\d*)$/.test(ordinalText)) {
      throwInvalidPrimaryKeyMetadata(tableName, column, comment)
    }

    const ordinal = Number(ordinalText)
    if (!Number.isSafeInteger(ordinal)) {
      throwInvalidPrimaryKeyMetadata(tableName, column, comment)
    }
    if (seenOrdinals.has(ordinal)) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset table '${tableName}' has duplicate primary-key ordinal '${ordinal}'.`
      )
    }
    seenOrdinals.add(ordinal)

    if (duckDbTypeToDatasetColumnType(column.columnType) !== "string") {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset table '${tableName}' primary-key column '${column.columnName}' must map to type 'string'.`
      )
    }
    if (column.nullsAllowed) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset table '${tableName}' primary-key column '${column.columnName}' must not be nullable.`
      )
    }

    keyedColumns.push({ column, ordinal })
  }

  if (keyedColumns.length === 0) {
    return undefined
  }

  keyedColumns.sort((left, right) => left.ordinal - right.ordinal)
  for (const [expectedOrdinal, keyedColumn] of keyedColumns.entries()) {
    if (keyedColumn.ordinal !== expectedOrdinal) {
      throw new LakeStorageError(
        `[SixbDuckLake] Dataset table '${tableName}' primary-key ordinals must be contiguous from 0.`
      )
    }
  }

  const columnNames = keyedColumns.map(({ column }) => column.columnName)
  if (columnNames.length === 1) {
    return columnNames[0]
  }

  return columnNames as [string, string, ...string[]]
}

function throwInvalidPrimaryKeyMetadata(
  tableName: string,
  column: DuckLakeCatalogColumn,
  comment: string
): never {
  throw new LakeStorageError(
    `[SixbDuckLake] Dataset table '${tableName}' has malformed primary-key metadata '${comment}' on column '${column.columnName}'.`
  )
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

  throw new LakeStorageError(
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
