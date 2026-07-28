import {
  type DatasetColumnDefinition,
  type DatasetDefinition,
  getDatasetRowValidationError,
  isJsonValue,
  MaterializationValidationError,
  type Schema,
  type TelemetryProjectionDefinition,
} from "@sixb/core"
import type { TelemetryPointWrite } from "@sixb/core/internal/materialization"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { ProjectionWorkerError } from "./errors"
import { resolveProjectionSchema } from "./projection-schema"
import { normalizeProjectedValue } from "./projection-value-coercion"
import type { ClaimedProjectionExecution, ProjectionWorkerContext } from "./types"
import { isBlank, isPlainObject, throwIfAborted } from "./utils"

export const TELEMETRY_PROJECTION_BATCH_SIZE = 500

interface TelemetryProjectionPlan {
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly valueColumnType: DatasetColumnDefinition["type"]
  readonly valueSchema: Schema
  readonly readColumns: readonly string[]
}

type ProjectTelemetryRowResult =
  | { readonly kind: "point"; readonly point: TelemetryPointWrite }
  | { readonly kind: "skip" }
  | { readonly kind: "invalid"; readonly message: string }

/**
 * Consumes stable physical row batches from the durable checkpoint.
 *
 * A full batch is committed inside the loop body, before `for await` requests the next row. EOF
 * after an exact multiple is therefore represented by guarded completion, not a fake empty commit.
 */
export async function runTelemetryProjection(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly execution: ClaimedProjectionExecution
  readonly signal: AbortSignal
}): Promise<void> {
  const { runtime, projection, dataset, execution, signal } = input
  const checkpoint = execution.run.telemetryCheckpoint
  if (!checkpoint) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Telemetry projection run '${execution.run.id}' has no checkpoint.`
    )
  }
  if (checkpoint.inputExhausted) return

  const plan = buildTelemetryProjectionPlan({ runtime, projection, dataset })
  const batch: unknown[] = []
  let batchOrdinal = checkpoint.nextBatchOrdinal

  for await (const row of runtime.lakeStorage.readRows({
    datasetId: execution.run.datasetId,
    versionId: execution.run.datasetVersionId,
    columns: plan.readColumns,
    offset: checkpoint.nextRowOffset,
  })) {
    throwIfAborted(signal)
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
  if (batch.length === 0) return
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
    points.push(projected.point)
  }

  throwIfAborted(signal)
  await getOntologyMutationRuntime(runtime).appendTelemetry({
    source: {
      kind: "projection",
      projection: { projectionId: execution.run.projectionId },
      datasetVersion: {
        datasetId: execution.run.datasetId,
        versionId: execution.run.datasetVersionId,
        createdAt: execution.run.datasetVersionCreatedAt,
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
}): TelemetryProjectionPlan {
  const { runtime, projection, dataset } = input
  const objectType = runtime.ontology.getObjectTypeById(projection.objectTypeId)
  const property = objectType?.properties.find(
    (candidate) => candidate.id === projection.propertyId
  )
  const valueColumn = dataset.schema.columns.find((column) => column.name === projection.valueField)
  if (!objectType || !property || !valueColumn) {
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Telemetry projection '${projection.id}' was not validated before execution.`
    )
  }

  return {
    projection,
    dataset,
    valueColumnType: valueColumn.type,
    valueSchema: resolveProjectionSchema(property.schema, runtime.ontology.getValueTypesById()),
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
      projection.valueField,
      ...(projection.unitField !== undefined ? [projection.unitField] : []),
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
  const value = row[projection.valueField]
  if (isBlank(objectId) || isBlank(at) || isBlank(value)) return { kind: "skip" }
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

  const normalized = normalizeProjectedValue({
    columnType: plan.valueColumnType,
    schema: plan.valueSchema,
    value,
  })
  if (!normalized.ok || !isJsonValue(normalized.value)) {
    return {
      kind: "invalid",
      message: `Telemetry projection '${projection.id}' value field '${projection.valueField}' is invalid${normalized.ok ? "" : `: ${normalized.errorMessage}`}.`,
    }
  }

  const rawUnit = projection.unitField === undefined ? undefined : row[projection.unitField]
  if (!isBlank(rawUnit) && typeof rawUnit !== "string") {
    return {
      kind: "invalid",
      message: `Telemetry projection '${projection.id}' unit field '${projection.unitField}' must be a string.`,
    }
  }

  return {
    kind: "point",
    point: {
      series: {
        object: { objectTypeId: projection.objectTypeId, primaryId: objectId },
        propertyId: projection.propertyId,
      },
      value: normalized.value,
      at: parsedAt.toISOString(),
      ...(typeof rawUnit === "string" && rawUnit.trim().length > 0 ? { unit: rawUnit } : {}),
    },
  }
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

const TELEMETRY_TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?([zZ]|[+-]\d{2}:?\d{2})?$/

interface TimestampComponents {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly milliseconds: number
}

export function parseTelemetryTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== "string") return null

  const match = TELEMETRY_TIMESTAMP.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const offsetMinutes = parseZoneOffsetMinutes(zone)
  if (offsetMinutes === null) return null

  const components: TimestampComponents = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    milliseconds: fraction === undefined ? 0 : Math.trunc(Number(`0.${fraction}`) * 1000),
  }
  const wallClock = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    components.milliseconds
  )
  if (!wallClockMatchesComponents(wallClock, components)) return null
  return new Date(wallClock - offsetMinutes * 60_000)
}

function parseZoneOffsetMinutes(zone: string | undefined): number | null {
  if (zone === undefined || zone === "Z" || zone === "z") return 0
  const digits = zone.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4))
  if (hours > 23 || minutes > 59) return null
  return (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes)
}

function wallClockMatchesComponents(wallClock: number, components: TimestampComponents): boolean {
  const date = new Date(wallClock)
  return (
    date.getUTCFullYear() === components.year &&
    date.getUTCMonth() === components.month - 1 &&
    date.getUTCDate() === components.day &&
    date.getUTCHours() === components.hour &&
    date.getUTCMinutes() === components.minute &&
    date.getUTCSeconds() === components.second
  )
}
