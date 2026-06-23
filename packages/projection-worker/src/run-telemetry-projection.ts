import {
  type DatasetColumnDefinition,
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  ObjectNotFoundError,
  OntologyValidationError,
  objectService,
  type Schema,
  type TelemetryProjectionDefinition,
} from "@sixb/core"
import { ProjectionWorkerError } from "./errors"
import { resolveProjectionSchema } from "./projection-schema"
import { normalizeProjectedValue } from "./projection-value-coercion"
import { type FlushContext, runStreamingProjection } from "./run-streaming-projection"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import { errorMessage, isBlank } from "./utils"

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

// A trailing "Z" or a numeric ±HH:MM / ±HHMM offset names the zone, so the
// instant is unambiguous and the engine can resolve it as-is.
const TIMESTAMP_WITH_EXPLICIT_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

// Zone-less calendar date or datetime, tolerating non-zero-padded month / day /
// hour fields. Capture groups: year, month, day, hour, minute, second, fraction.
const ZONE_LESS_TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/

// Parse a telemetry `at` value to an absolute instant. Zone-less inputs are
// interpreted as UTC by building the instant from explicit components via
// Date.UTC, so a row materializes at the same instant regardless of the worker
// process timezone. We never hand a zone-less string to new Date(), which would
// silently fall back to local-time parsing for any non-ISO (e.g. non-padded)
// form and break the (series, at) idempotency invariant across worker hosts.
export function parseTelemetryTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()

  if (TIMESTAMP_WITH_EXPLICIT_ZONE.test(trimmed)) {
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const match = ZONE_LESS_TIMESTAMP.exec(trimmed)
  if (match === null) {
    return null
  }
  const [, year, month, day, hour, minute, second, fraction] = match
  const milliseconds = fraction === undefined ? 0 : Math.trunc(Number(`0.${fraction}`) * 1000)
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hour === undefined ? 0 : Number(hour),
      minute === undefined ? 0 : Number(minute),
      second === undefined ? 0 : Number(second),
      milliseconds
    )
  )
  // Reject calendar rollover (e.g. "2026-13-01" → 2027) so an out-of-range
  // timestamp is flagged as invalid rather than silently shifted.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null
  }
  return date
}

function isRecoverableTelemetryRowError(error: unknown): boolean {
  return error instanceof ObjectNotFoundError || error instanceof OntologyValidationError
}

function isPlainObject(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
