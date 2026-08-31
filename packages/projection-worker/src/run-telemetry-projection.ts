import {
  type DatasetColumnDefinition,
  type DatasetDefinition,
  getDatasetRowValidationError,
  isJsonValue,
  MaterializationValidationError,
  type Schema,
  type TelemetryProjectionDefinition,
  type TelemetryProjectionPropertyMapping,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { TelemetryPointWrite } from "@sixb/core/internal/materialization"
import { parseDatasetTimestamp } from "@sixb/core/internal/projections"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { resolveProjectionSchema } from "./projection-schema"
import { normalizeProjectedValue } from "./projection-value-coercion"
import type { ClaimedProjectionExecution, ProjectionWorkerContext } from "./types"
import { isBlank, isPlainObject, throwIfAborted } from "./utils"

interface TelemetryProjectionPlan {
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly properties: readonly TelemetryProjectionPropertyPlan[]
  readonly readColumns: readonly string[]
}

interface TelemetryProjectionPropertyPlan {
  readonly propertyId: string
  readonly mapping: TelemetryProjectionPropertyMapping
  readonly valueColumnType: DatasetColumnDefinition["type"]
  readonly valueSchema: Schema
}

type ProjectTelemetryRowResult =
  | { readonly kind: "points"; readonly points: readonly TelemetryPointWrite[] }
  | { readonly kind: "skip" }
  | { readonly kind: "invalid"; readonly message: string }

/**
 * Consumes stable physical row batches from the durable checkpoint.
 *
 * A full batch is committed inside the loop body, before `for await` requests the next row. EOF
 * after an exact multiple is acknowledged by the fenced terminal write, not a fake empty commit.
 */
export async function runTelemetryProjection(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly version: DatasetVersion
  readonly execution: ClaimedProjectionExecution
  readonly signal: AbortSignal
}): Promise<{ readonly protocol: "telemetry"; readonly inputExhausted: true }> {
  const { runtime, projection, dataset, version, execution, signal } = input
  const errorDetails = {
    projectionId: projection.id,
    runId: execution.run.id,
    datasetId: execution.run.identity.datasetVersion.datasetId,
    versionId: execution.run.identity.datasetVersion.versionId,
  }
  const checkpoint = execution.run.telemetryCheckpoint
  if (!checkpoint) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbProjectionWorker] Telemetry projection run '${execution.run.id}' has no checkpoint.`,
      { details: errorDetails }
    )
  }
  if (checkpoint.inputExhausted) return telemetryInputExhausted()

  const plan = buildTelemetryProjectionPlan({ runtime, projection, dataset, errorDetails })
  const batch: unknown[] = []
  let batchOrdinal = checkpoint.nextBatchOrdinal
  let attemptRowsRead = 0

  for await (const row of runtime.lakeStorage.readRows({
    datasetId: execution.run.identity.datasetVersion.datasetId,
    versionId: execution.run.identity.datasetVersion.versionId,
    columns: plan.readColumns,
    offset: checkpoint.nextRowOffset,
  })) {
    throwIfAborted(signal)
    attemptRowsRead += 1
    assertWithinPinnedInput({
      ...errorDetails,
      expectedRows: version.rowCount,
      rowsRead: checkpoint.nextRowOffset + attemptRowsRead,
    })
    batch.push(row)
    if (batch.length !== checkpoint.fixedBatchSize) continue

    await appendPhysicalBatch({
      runtime,
      execution,
      plan,
      rows: batch.splice(0, batch.length),
      batchOrdinal,
      inputExhausted: false,
      signal,
    })
    batchOrdinal += 1
  }

  throwIfAborted(signal)
  assertCompletePinnedInput({
    ...errorDetails,
    expectedRows: version.rowCount,
    rowsRead: checkpoint.nextRowOffset + attemptRowsRead,
  })
  if (batch.length > 0) {
    await appendPhysicalBatch({
      runtime,
      execution,
      plan,
      rows: batch,
      batchOrdinal,
      inputExhausted: true,
      signal,
    })
  }
  return telemetryInputExhausted()
}

function telemetryInputExhausted() {
  return { protocol: "telemetry" as const, inputExhausted: true as const }
}

function assertWithinPinnedInput(input: {
  readonly projectionId: string
  readonly runId: string
  readonly datasetId: string
  readonly versionId: string
  readonly expectedRows: number | undefined
  readonly rowsRead: number
}): void {
  if (input.expectedRows === undefined || input.rowsRead <= input.expectedRows) return
  throw createSixbError(
    "dataset.version_read_inconsistent",
    `[SixbProjectionWorker] Telemetry projection run '${input.runId}' read more than its ${input.expectedRows} pinned rows.`,
    {
      details: {
        projectionId: input.projectionId,
        runId: input.runId,
        datasetId: input.datasetId,
        versionId: input.versionId,
        expectedRows: input.expectedRows,
        rowsRead: input.rowsRead,
      },
    }
  )
}

function assertCompletePinnedInput(input: {
  readonly projectionId: string
  readonly runId: string
  readonly datasetId: string
  readonly versionId: string
  readonly expectedRows: number | undefined
  readonly rowsRead: number
}): void {
  if (input.expectedRows === undefined || input.rowsRead === input.expectedRows) return
  throw createSixbError(
    "dataset.version_read_inconsistent",
    `[SixbProjectionWorker] Telemetry projection run '${input.runId}' reached EOF after ${input.rowsRead} of ${input.expectedRows} pinned rows.`,
    {
      details: {
        projectionId: input.projectionId,
        runId: input.runId,
        datasetId: input.datasetId,
        versionId: input.versionId,
        expectedRows: input.expectedRows,
        rowsRead: input.rowsRead,
      },
    }
  )
}

async function appendPhysicalBatch(input: {
  readonly runtime: ProjectionWorkerContext
  readonly execution: ClaimedProjectionExecution
  readonly plan: TelemetryProjectionPlan
  readonly rows: readonly unknown[]
  readonly batchOrdinal: number
  readonly inputExhausted: boolean
  readonly signal: AbortSignal
}): Promise<void> {
  const { runtime, execution, plan, rows, batchOrdinal, inputExhausted, signal } = input
  const points: TelemetryPointWrite[] = []
  let sourceRowsSkipped = 0

  for (const row of rows) {
    throwIfAborted(signal)
    const projected = projectTelemetryRow(plan, row)
    if (projected.kind === "invalid") {
      throw new MaterializationValidationError(projected.message)
    }
    if (projected.kind === "skip") {
      sourceRowsSkipped += 1
      continue
    }
    points.push(...projected.points)
  }

  throwIfAborted(signal)
  await getOntologyMutationRuntime(runtime).appendTelemetry({
    source: {
      kind: "projection",
      projection: { projectionId: execution.run.identity.projectionId },
      datasetVersion: {
        datasetId: execution.run.identity.datasetVersion.datasetId,
        versionId: execution.run.identity.datasetVersion.versionId,
        createdAt: execution.run.identity.datasetVersion.createdAt,
      },
      execution: execution.execution,
      batchOrdinal,
      sourceRowCount: rows.length,
      sourceRowsSkipped,
      inputExhausted,
    },
    points,
  })
}

function buildTelemetryProjectionPlan(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly errorDetails: Readonly<Record<string, string>>
}): TelemetryProjectionPlan {
  const { runtime, projection, dataset, errorDetails } = input
  const objectType = runtime.ontology.getObjectTypeById(projection.objectTypeId)
  if (!objectType) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbProjectionWorker] Telemetry projection '${projection.id}' was not validated before execution.`,
      {
        details: {
          ...errorDetails,
          objectTypeId: projection.objectTypeId,
        },
      }
    )
  }

  const propertiesById = new Map(objectType.properties.map((property) => [property.id, property]))
  const columnsByName = new Map(dataset.schema.columns.map((column) => [column.name, column]))
  const properties = Object.entries(projection.properties)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([propertyId, mapping]): TelemetryProjectionPropertyPlan => {
      const property = propertiesById.get(propertyId)
      const valueColumn = columnsByName.get(mapping.valueField)
      if (!property || !valueColumn) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbProjectionWorker] Telemetry projection '${projection.id}' was not validated before execution.`,
          {
            details: {
              ...errorDetails,
              objectTypeId: projection.objectTypeId,
              propertyId,
              columnName: mapping.valueField,
            },
          }
        )
      }

      return {
        propertyId,
        mapping,
        valueColumnType: valueColumn.type,
        valueSchema: resolveProjectionSchema(
          property.schema,
          runtime.ontology.getValueTypesById(),
          {
            details: {
              ...errorDetails,
              objectTypeId: objectType.id,
              propertyId,
              columnName: valueColumn.name,
            },
          }
        ),
      }
    })

  return {
    projection,
    dataset,
    properties,
    readColumns: telemetryProjectionReadColumns(projection),
  }
}

function telemetryProjectionReadColumns(
  projection: TelemetryProjectionDefinition
): readonly string[] {
  return [
    ...new Set([
      projection.objectIdField,
      projection.atField,
      ...Object.values(projection.properties).flatMap((mapping) => [
        mapping.valueField,
        ...(mapping.unitField !== undefined ? [mapping.unitField] : []),
      ]),
    ]),
  ]
}

function projectTelemetryRow(
  plan: TelemetryProjectionPlan,
  row: unknown
): ProjectTelemetryRowResult {
  const { projection, dataset } = plan
  const rowValidationError = getDatasetRowValidationError(row, dataset, {
    columns: plan.readColumns,
  })
  if (rowValidationError) return { kind: "invalid", message: rowValidationError }
  if (!isPlainObject(row)) {
    return { kind: "invalid", message: `Dataset '${dataset.id}' rows must be plain objects.` }
  }

  const objectId = row[projection.objectIdField]
  const at = row[projection.atField]
  if (isBlank(objectId) || isBlank(at)) return { kind: "skip" }
  if (plan.properties.every((property) => isBlank(row[property.mapping.valueField]))) {
    return { kind: "skip" }
  }
  if (typeof objectId !== "string") {
    return invalidIdentity(projection, projection.objectIdField)
  }

  const parsedAt = parseTelemetryTimestamp(at)
  if (!parsedAt) {
    return {
      kind: "invalid",
      message: `Telemetry projection '${projection.id}' field '${projection.atField}' has invalid timestamp '${String(at)}'.`,
    }
  }

  const points: TelemetryPointWrite[] = []
  for (const property of plan.properties) {
    const value = row[property.mapping.valueField]
    if (isBlank(value)) continue

    const normalized = normalizeProjectedValue({
      columnType: property.valueColumnType,
      schema: property.valueSchema,
      value,
    })
    if (!normalized.ok || !isJsonValue(normalized.value)) {
      return {
        kind: "invalid",
        message: `Telemetry projection '${projection.id}' property '${property.propertyId}' value field '${property.mapping.valueField}' is invalid${normalized.ok ? "" : `: ${normalized.errorMessage}`}.`,
      }
    }

    const rawUnit =
      property.mapping.unitField === undefined ? undefined : row[property.mapping.unitField]
    if (!isBlank(rawUnit) && typeof rawUnit !== "string") {
      return {
        kind: "invalid",
        message: `Telemetry projection '${projection.id}' property '${property.propertyId}' unit field '${property.mapping.unitField}' must be a string.`,
      }
    }

    points.push({
      series: {
        object: { objectTypeId: projection.objectTypeId, primaryId: objectId },
        propertyId: property.propertyId,
      },
      value: normalized.value,
      at: parsedAt.toISOString(),
      ...(typeof rawUnit === "string" && rawUnit.trim().length > 0 ? { unit: rawUnit } : {}),
    })
  }

  return points.length === 0 ? { kind: "skip" } : { kind: "points", points }
}

function invalidIdentity(
  projection: TelemetryProjectionDefinition,
  field: string
): ProjectTelemetryRowResult {
  return {
    kind: "invalid",
    message: `Telemetry projection '${projection.id}' identity field '${field}' must be a non-empty string.`,
  }
}

export const parseTelemetryTimestamp = parseDatasetTimestamp
