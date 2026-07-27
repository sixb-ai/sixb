import {
  type DatasetColumnDefinition,
  type DatasetDefinition,
  getDatasetRowValidationError,
  MaterializationValidationError,
  ObjectNotFoundError,
  OntologyValidationError,
  type Schema,
  type TelemetryProjectionDefinition,
} from "@sixb/core"
import { objectService } from "@sixb/core/internal/objects"
import { ProjectionWorkerError } from "./errors"
import { resolveProjectionSchema } from "./projection-schema"
import { normalizeProjectedValue } from "./projection-value-coercion"
import { type FlushContext, runStreamingProjection } from "./run-streaming-projection"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import { errorMessage, isBlank, isPlainObject } from "./utils"

interface RunTelemetryProjectionInput {
  readonly runtime: ProjectionWorkerContext
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly versionId: string
  readonly signal: AbortSignal
  readonly batchSize: number
  readonly onProgress?: ProjectionProgressReporter
}

interface TelemetryProjectionPlan {
  readonly projection: TelemetryProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly valueColumnType: DatasetColumnDefinition["type"]
  readonly valueSchema: Schema
  readonly readColumns: readonly string[]
}

interface ProjectedTelemetryItem {
  readonly id: string
  readonly properties: Record<string, unknown>
  readonly at: Date
}

type ProjectTelemetryRowResult =
  | { readonly ok: true; readonly item: ProjectedTelemetryItem | null }
  | { readonly ok: false; readonly errorMessage: string }

/**
 * Telemetry projections append points keyed by (object, property, at); the
 * timeseries store upserts on that identity, so replays are idempotent without
 * any worker-side dedup ledger. This mirrors the object/link projections:
 * read rows, project each, append in batches — sharing the streaming-batch
 * driver and contributing only the telemetry-specific row projection and flush.
 */
export async function runTelemetryProjection(
  input: RunTelemetryProjectionInput
): Promise<ProjectionExecutionResult> {
  const { runtime, projection, dataset, versionId, signal, batchSize, onProgress } = input
  const projectionPlan = buildTelemetryProjectionPlan({ runtime, projection, dataset })

  return runStreamingProjection<ProjectedTelemetryItem>({
    runtime,
    signal,
    batchSize,
    onProgress,
    spec: {
      datasetId: projection.datasetId,
      versionId,
      readColumns: projectionPlan.readColumns,
      projectRow(row) {
        const projected = projectTelemetryRow(projectionPlan, row)
        if (!projected.ok) {
          return { status: "fail", errorMessage: projected.errorMessage }
        }
        if (!projected.item) {
          return { status: "skip" }
        }
        return { status: "item", item: projected.item }
      },
      // A blank reading is a clean skip; an invalid projection is a row failure.
      onSkip: (counters) => {
        counters.telemetryPointsSkipped += 1
      },
      onFail: (counters) => {
        counters.telemetryRowsFailed += 1
      },
      flushBatch: (items, ctx) => appendTelemetryItems({ runtime, projection, items, ctx }),
    },
  })
}

async function appendTelemetryItems(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: TelemetryProjectionDefinition
  readonly items: readonly ProjectedTelemetryItem[]
  readonly ctx: FlushContext
}): Promise<void> {
  const { runtime, projection, items, ctx } = input
  const { counters, rememberError } = ctx

  const appendItems = (batch: readonly ProjectedTelemetryItem[]): Promise<void> =>
    objectService.appendTelemetry(runtime, projection.objectTypeId, batch)

  try {
    await appendItems(items)
    counters.telemetryPointsAppended += items.length
  } catch (error) {
    if (!isRecoverableTelemetryRowError(error)) {
      throw error
    }
    // Isolate the failing row: re-apply individually so the good rows still land.
    for (const item of items) {
      await appendSingleTelemetryItem({ appendItems, item, counters, rememberError })
    }
  }
}

async function appendSingleTelemetryItem(input: {
  readonly appendItems: (batch: readonly ProjectedTelemetryItem[]) => Promise<void>
  readonly item: ProjectedTelemetryItem
  readonly counters: FlushContext["counters"]
  readonly rememberError: FlushContext["rememberError"]
}): Promise<void> {
  const { appendItems, item, counters, rememberError } = input
  try {
    await appendItems([item])
    counters.telemetryPointsAppended += 1
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      // A reading for an object that does not exist yet is a benign, retryable
      // skip (matching object/link projections); a later run after the object
      // is created appends the point.
      counters.rowsSkipped += 1
      counters.telemetryPointsSkipped += 1
      return
    }
    if (!isRecoverableTelemetryRowError(error)) {
      throw error
    }
    counters.rowsSkipped += 1
    counters.telemetryRowsFailed += 1
    rememberError(errorMessage(error))
  }
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
  if (rowValidationError) {
    return { ok: false, errorMessage: rowValidationError }
  }

  if (!isPlainObject(row)) {
    return {
      ok: false,
      errorMessage: `Dataset '${dataset.id}' rows must be plain objects.`,
    }
  }

  const objectId = row[projection.objectIdField]
  const at = row[projection.atField]
  const value = row[projection.valueField]
  if (isBlank(objectId) || isBlank(at) || isBlank(value)) {
    return { ok: true, item: null }
  }

  const parsedAt = parseTelemetryTimestamp(at)
  if (!parsedAt) {
    return {
      ok: false,
      errorMessage: `[SixbProjectionWorker] Telemetry projection '${projection.id}' at field '${projection.atField}' has invalid timestamp value '${String(at)}'.`,
    }
  }

  const normalized = normalizeProjectedValue({
    columnType: plan.valueColumnType,
    schema: plan.valueSchema,
    value,
  })
  if (!normalized.ok) {
    return {
      ok: false,
      errorMessage: `[SixbProjectionWorker] Telemetry projection '${projection.id}' value from dataset column '${projection.valueField}' (${plan.valueColumnType}) ${normalized.errorMessage}.`,
    }
  }

  const properties: Record<string, unknown> = {}
  const unit = projection.unitField === undefined ? undefined : row[projection.unitField]
  properties[projection.propertyId] = isBlank(unit)
    ? normalized.value
    : { value: normalized.value, unit }

  return {
    ok: true,
    item: {
      id: String(objectId),
      properties,
      at: parsedAt,
    },
  }
}

// Calendar date or datetime with an optional zone designator. Tolerates
// non-zero-padded month / day / hour fields. A trailing "Z" or a numeric
// ±HH:MM / ±HHMM offset names the zone; its absence means UTC. Capture groups:
// year, month, day, hour, minute, second, fraction, zone.
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

// Parse a telemetry `at` value to an absolute instant from explicit calendar
// components, never via new Date(string) — which would fall back to local-time
// parsing for non-ISO forms and silently roll over out-of-range fields. The
// written wall-clock fields are validated as a real calendar date/time
// (timezone-independent) before the named offset is applied, so a row
// materializes at the same instant regardless of the worker process timezone
// and an invalid timestamp is rejected rather than shifted.
export function parseTelemetryTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== "string") {
    return null
  }

  const match = TELEMETRY_TIMESTAMP.exec(value.trim())
  if (match === null) {
    return null
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match

  const offsetMinutes = parseZoneOffsetMinutes(zone)
  if (offsetMinutes === null) {
    return null
  }

  const components: TimestampComponents = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    milliseconds: fraction === undefined ? 0 : Math.trunc(Number(`0.${fraction}`) * 1000),
  }

  // Build the wall-clock instant as if UTC, then re-read every field to reject
  // any that rolled over (e.g. "2026-02-29", "...09:99", "...24:00"). Calendar
  // validity is timezone-independent, so this guards both zone-less and zoned
  // inputs; only after it round-trips do we shift by the offset.
  const wallClock = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    components.milliseconds
  )
  if (!wallClockMatchesComponents(wallClock, components)) {
    return null
  }

  return new Date(wallClock - offsetMinutes * 60_000)
}

// Returns the offset in minutes to subtract from the wall-clock UTC instant, or
// null if the offset is out of range. Zone-less and "Z" inputs are UTC (0).
function parseZoneOffsetMinutes(zone: string | undefined): number | null {
  if (zone === undefined || zone === "Z" || zone === "z") {
    return 0
  }
  const digits = zone.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4))
  if (hours > 23 || minutes > 59) {
    return null
  }
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

function isRecoverableTelemetryRowError(error: unknown): boolean {
  return (
    error instanceof ObjectNotFoundError ||
    error instanceof OntologyValidationError ||
    error instanceof MaterializationValidationError
  )
}
