import { isFileRef } from "../blob-storage"
import { isJsonValue } from "../json"
import { DatasetValidationError } from "./errors"
import type {
  DatasetColumnDefinition,
  DatasetColumnType,
  DatasetDefinition,
  DatasetSchema,
} from "./types"

const datasetColumnTypes = new Set<DatasetColumnType>([
  "string",
  "boolean",
  "int64",
  "float64",
  "decimal",
  "date",
  "timestamp",
  "json",
  "fileRef",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isValidDateValue(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function isDateString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function isTimestampString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function matchesColumnType(value: unknown, type: DatasetColumnType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "int64":
      return (
        (typeof value === "number" && Number.isInteger(value)) ||
        (typeof value === "string" && /^-?\d+$/.test(value))
      )
    case "float64":
      return typeof value === "number" && Number.isFinite(value)
    case "decimal":
      return (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value))
      )
    case "date":
      return isValidDateValue(value) || isDateString(value)
    case "timestamp":
      return isValidDateValue(value) || isTimestampString(value)
    case "json":
      return isJsonValue(value)
    case "fileRef":
      return isFileRef(value)
  }
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  createError: (message: string) => Error
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(`${field} must not be empty.`)
  }
}

export function assertDatasetColumnDefinition(
  column: unknown,
  createError: (message: string) => Error,
  fieldPrefix = "Dataset column"
): asserts column is DatasetColumnDefinition {
  if (!isRecord(column)) {
    throw createError(`${fieldPrefix} must be an object.`)
  }

  assertNonEmptyString(column.name, `${fieldPrefix} name`, createError)

  if (!datasetColumnTypes.has(column.type as DatasetColumnType)) {
    throw createError(
      `${fieldPrefix} '${column.name}' has an invalid type '${String(column.type)}'.`
    )
  }

  if (column.nullable !== undefined && typeof column.nullable !== "boolean") {
    throw createError(`${fieldPrefix} '${column.name}' nullable must be a boolean.`)
  }
}

function assertDatasetSchema(
  schema: unknown,
  createError: (message: string) => Error
): asserts schema is DatasetSchema {
  if (!isRecord(schema) || !Array.isArray(schema.columns)) {
    throw createError("Dataset definitions must declare a schema.")
  }

  const seenColumnNames = new Set<string>()
  for (const column of schema.columns) {
    assertDatasetColumnDefinition(column, createError)

    if (seenColumnNames.has(column.name)) {
      throw createError(`Dataset schema contains a duplicate column '${column.name}'.`)
    }

    seenColumnNames.add(column.name)
  }
}

export function assertDatasetDefinition(
  definition: unknown,
  createError: (message: string) => Error = (message) => new DatasetValidationError(message)
): asserts definition is DatasetDefinition {
  if (!isRecord(definition)) {
    throw createError("Dataset definition must be an object.")
  }

  if (definition.kind !== "dataset") {
    throw createError("Dataset definition kind must be 'dataset'.")
  }

  assertNonEmptyString(definition.id, "Dataset id", createError)
  assertDatasetSchema(definition.schema, createError)

  if (definition.partitionBy !== undefined) {
    if (!Array.isArray(definition.partitionBy)) {
      throw createError("Dataset partitionBy must be an array of column names.")
    }

    const columnNames = new Set(definition.schema.columns.map((column) => column.name))
    for (const columnName of definition.partitionBy) {
      assertNonEmptyString(columnName, "Dataset partition column", createError)
      if (!columnNames.has(columnName)) {
        throw createError(`Dataset partition column '${columnName}' is not declared in the schema.`)
      }
    }
  }

  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw createError("Dataset description must be a string.")
  }
}

export function isDatasetDefinition(value: unknown): value is DatasetDefinition {
  try {
    assertDatasetDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function getDatasetRowValidationError(
  row: unknown,
  dataset: DatasetDefinition
): string | null {
  if (!isPlainObject(row)) {
    return `Dataset '${dataset.id}' rows must be plain objects.`
  }

  const columnsByName = new Map(
    dataset.schema.columns.map((column) => [column.name, column] as const)
  )

  for (const columnName of Object.keys(row)) {
    if (!columnsByName.has(columnName)) {
      return `Dataset '${dataset.id}' row contains unknown column '${columnName}'.`
    }
  }

  for (const column of dataset.schema.columns) {
    const hasValue = Object.hasOwn(row, column.name)
    const value = row[column.name]

    // Treat `undefined` the same as an omitted field so callers either send a real
    // value or use `null` explicitly on nullable columns.
    if (!hasValue || value === undefined) {
      if (!column.nullable) {
        return `Dataset '${dataset.id}' row is missing required column '${column.name}'.`
      }
      continue
    }

    if (value === null) {
      if (!column.nullable) {
        return `Dataset '${dataset.id}' column '${column.name}' does not allow null values.`
      }
      continue
    }

    if (!matchesColumnType(value, column.type)) {
      return `Dataset '${dataset.id}' column '${column.name}' must match type '${column.type}'.`
    }
  }

  return null
}
