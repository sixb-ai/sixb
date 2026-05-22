import type { DatasetColumnDefinition, DatasetDefinition } from "../datasets"
import { LakeStorageError } from "./errors"
import type { LakeStorage } from "./types"

export type DatasetSchemaUpdatePlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "addNullableColumns"
      readonly columns: readonly DatasetColumnDefinition[]
    }

export interface DatasetMetadataUpdatePlan {
  readonly descriptionChanged: boolean
  readonly partitionByChanged: boolean
}

export interface DatasetDefinitionUpdatePlan {
  readonly existing: DatasetDefinition
  readonly requested: DatasetDefinition
  readonly definition: DatasetDefinition
  readonly schema: DatasetSchemaUpdatePlan
  readonly metadata: DatasetMetadataUpdatePlan
  readonly changed: boolean
}

const SCHEMA_UPDATE_V1_POLICY =
  "Dataset definition updates V1 support only adding nullable columns."

/**
 * Build a provider-neutral update plan for two versions of the same dataset
 * definition. Core owns the definition diff; storage providers own how much of
 * the plan they can apply.
 */
export function planDatasetDefinitionUpdate(
  existing: DatasetDefinition,
  requested: DatasetDefinition
): DatasetDefinitionUpdatePlan {
  assertSameDataset(existing, requested)

  const addedColumns = getAddedColumnsAfterValidatingExistingColumns(existing, requested)
  assertAddedColumnsAreNullable(requested.id, addedColumns)

  const schema = toSchemaUpdatePlan(addedColumns)
  const definition = mergeDatasetDefinition(existing, requested, addedColumns)
  const metadata: DatasetMetadataUpdatePlan = {
    descriptionChanged: existing.description !== definition.description,
    partitionByChanged: !areStringArraysEqual(existing.partitionBy, definition.partitionBy),
  }

  return {
    existing: structuredClone(existing),
    requested: structuredClone(requested),
    definition,
    schema,
    metadata,
    changed: schema.kind !== "none" || metadata.descriptionChanged || metadata.partitionByChanged,
  }
}

/**
 * Strict providers can use this helper when they do not support schema
 * evolution. Metadata-only compatible additions are still merged.
 */
export function mergeStrictDatasetDefinition(options: {
  readonly existing?: DatasetDefinition | null
  readonly next: DatasetDefinition
}): DatasetDefinition {
  if (!options.existing) {
    return structuredClone(options.next)
  }

  const plan = planDatasetDefinitionUpdate(options.existing, options.next)
  if (plan.schema.kind !== "none") {
    throw new LakeStorageError(
      `[ParioLake] Dataset '${options.next.id}' cannot be redefined with an incompatible schema.`
    )
  }

  return structuredClone(plan.definition)
}

export interface AssertLakeDatasetDefinitionsCompatibleOptions {
  readonly lakeStorage: LakeStorage
  readonly definitions: readonly DatasetDefinition[]
}

export async function assertLakeDatasetDefinitionsCompatible(
  options: AssertLakeDatasetDefinitionsCompatibleOptions
): Promise<void> {
  const failures: string[] = []

  for (const definition of options.definitions) {
    try {
      await options.lakeStorage.assertDatasetDefinitionCompatible(definition)
    } catch (error) {
      failures.push(`- ${definition.id}: ${errorMessage(error)}`)
    }
  }

  if (failures.length > 0) {
    const details = failures.join("\n")
    throw new LakeStorageError(
      `[ParioLake] Lake dataset definition check failed for ${failures.length} dataset(s).\n${details}`
    )
  }
}

function assertSameDataset(existing: DatasetDefinition, requested: DatasetDefinition): void {
  if (existing.id !== requested.id) {
    throw new LakeStorageError(
      `[ParioLake] Cannot update dataset '${existing.id}' with definition for '${requested.id}'.`
    )
  }
}

function getAddedColumnsAfterValidatingExistingColumns(
  existing: DatasetDefinition,
  requested: DatasetDefinition
): readonly DatasetColumnDefinition[] {
  const existingColumns = existing.schema.columns
  const requestedColumnsByName = new Map(
    requested.schema.columns.map((column) => [column.name, column])
  )

  // Existing columns are matched by name, not position. Developers can reorder
  // declarations for readability without implying a storage-level schema change.
  for (const existingColumn of existingColumns) {
    const requestedColumn = requestedColumnsByName.get(existingColumn.name)
    if (requestedColumn === undefined) {
      throwUnsupportedSchemaUpdate(
        requested.id,
        `dropping column '${existingColumn.name}' is not supported`
      )
    }

    assertExistingColumnUnchanged(requested.id, existingColumn, requestedColumn)
  }

  const existingColumnNames = new Set(existingColumns.map((column) => column.name))
  return requested.schema.columns.filter((column) => !existingColumnNames.has(column.name))
}

function assertAddedColumnsAreNullable(
  datasetId: string,
  addedColumns: readonly DatasetColumnDefinition[]
): void {
  for (const column of addedColumns) {
    // Existing rows have no value for a new column. Until DatasetDefinition
    // supports defaults or backfills, only nullable columns are safe to add.
    if (!isNullable(column)) {
      throwUnsupportedSchemaUpdate(
        datasetId,
        `adding required column '${column.name}' is not supported`
      )
    }
  }
}

function assertExistingColumnUnchanged(
  datasetId: string,
  existing: DatasetColumnDefinition,
  requested: DatasetColumnDefinition
): void {
  if (existing.type !== requested.type) {
    throwUnsupportedSchemaUpdate(
      datasetId,
      `changing column '${existing.name}' type from '${existing.type}' to '${requested.type}' is not supported`
    )
  }

  if (isNullable(existing) !== isNullable(requested)) {
    throwUnsupportedSchemaUpdate(
      datasetId,
      `changing column '${existing.name}' nullability is not supported`
    )
  }
}

function toSchemaUpdatePlan(
  addedColumns: readonly DatasetColumnDefinition[]
): DatasetSchemaUpdatePlan {
  if (addedColumns.length === 0) {
    return { kind: "none" }
  }

  return {
    kind: "addNullableColumns",
    columns: cloneColumns(addedColumns),
  }
}

function mergeDatasetDefinition(
  existing: DatasetDefinition,
  requested: DatasetDefinition,
  addedColumns: readonly DatasetColumnDefinition[]
): DatasetDefinition {
  assertCompatibleMetadataField(
    requested.id,
    "description",
    existing.description,
    requested.description
  )
  assertCompatibleMetadataField(
    requested.id,
    "partitionBy",
    existing.partitionBy,
    requested.partitionBy
  )

  const columns = [...cloneColumns(existing.schema.columns), ...cloneColumns(addedColumns)]
  const partitionBy = requested.partitionBy ?? existing.partitionBy
  const description = requested.description ?? existing.description

  return {
    kind: "dataset",
    id: requested.id,
    schema: { columns },
    ...(partitionBy !== undefined ? { partitionBy: [...partitionBy] } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

function assertCompatibleMetadataField(
  datasetId: string,
  field: "description" | "partitionBy",
  existing: string | readonly string[] | undefined,
  requested: string | readonly string[] | undefined
): void {
  if (
    existing === undefined ||
    requested === undefined ||
    areDefinitionValuesEqual(existing, requested)
  ) {
    return
  }

  throw new LakeStorageError(
    `[ParioLake] Dataset '${datasetId}' cannot be redefined with an incompatible ${field}.`
  )
}

function areStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }

  return left.length === right.length && left.every((value, index) => value === right[index])
}

function areDefinitionValuesEqual(
  left: string | readonly string[],
  right: string | readonly string[]
): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return left === right
  }

  return areStringArraysEqual(left, right)
}

function isNullable(column: DatasetColumnDefinition): boolean {
  return column.nullable === true
}

function cloneColumns(
  columns: readonly DatasetColumnDefinition[]
): readonly DatasetColumnDefinition[] {
  return columns.map((column) => ({ ...column }))
}

function throwUnsupportedSchemaUpdate(datasetId: string, detail: string): never {
  throw new LakeStorageError(
    `[ParioLake] Dataset '${datasetId}' cannot apply schema update because ${detail}. ${SCHEMA_UPDATE_V1_POLICY}`
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
