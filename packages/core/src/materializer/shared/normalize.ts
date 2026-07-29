import type { EventActor } from "../../events/envelope"
import { assertJsonValue, cloneJsonValue, compareStrings, stableJsonStringify } from "../../json"
import { MaterializationValidationError } from "../../materialization/errors"
import type {
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  OntologyEditCommit,
  OntologyEditOperation,
  PinnedDatasetVersion,
  ProjectionEntityRef,
  ProjectionExecution,
  ProjectionSourceAssertion,
  ProjectionSourceEntry,
  ProjectionSourceRef,
  TelemetryAppend,
  TelemetryPointWrite,
  TelemetrySeriesRef,
} from "../../materialization/model"
import {
  linkRefKey,
  linkScopeKey,
  normalizeLinkRef,
  normalizeObjectRef,
  objectRefKey,
  projectionEntityKey,
  telemetryPointKey,
} from "../../materialization/refs"

export function normalizeJsonProperties(
  properties: Readonly<Record<string, unknown>>,
  label = "Properties"
): Readonly<Record<string, import("../../json").JsonValue>> {
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new MaterializationValidationError(`${label} must be a JSON object.`)
  }

  const normalized: Record<string, import("../../json").JsonValue> = {}
  for (const propertyId of Object.keys(properties).sort(compareStrings)) {
    if (propertyId.trim().length === 0) {
      throw new MaterializationValidationError(`${label} contains a blank property id.`)
    }
    const value = properties[propertyId]
    try {
      assertJsonValue(value, `${label}.${propertyId}`)
    } catch (error) {
      throw new MaterializationValidationError(
        error instanceof Error ? error.message : `${label}.${propertyId} must be JSON.`
      )
    }
    normalized[propertyId] = cloneJsonValue(value)
  }
  return Object.freeze(normalized)
}

function normalizeNonblank(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaterializationValidationError(`${label} must be a nonblank string.`)
  }
  return value
}

function normalizeEventActor(actor: EventActor): EventActor {
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) {
    throw new MaterializationValidationError("Event actor must be an object.")
  }
  if (actor.type !== "user" && actor.type !== "service" && actor.type !== "system") {
    throw new MaterializationValidationError(
      "Event actor type must be 'user', 'service', or 'system'."
    )
  }
  return Object.freeze({
    type: actor.type,
    id: normalizeNonblank(actor.id, "Event actor id"),
  })
}

function normalizeTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new MaterializationValidationError(`${label} must be a valid timestamp.`)
  }
  return new Date(milliseconds).toISOString()
}

function normalizePropertyIds(values: readonly string[], label: string): readonly string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    normalizeNonblank(value, label)
    if (seen.has(value)) {
      throw new MaterializationValidationError(`${label} contains duplicate '${value}'.`)
    }
    seen.add(value)
    normalized.push(value)
  }
  return Object.freeze(normalized.sort(compareStrings))
}

function normalizeOperation(operation: OntologyEditOperation): OntologyEditOperation {
  normalizeNonblank(operation.id, "Operation id")
  if (operation.kind === "object.create" || operation.kind === "object.upsert") {
    return Object.freeze({
      id: operation.id,
      kind: operation.kind,
      ref: normalizeObjectRef(operation.ref),
      properties: normalizeJsonProperties(operation.properties),
    })
  }
  if (operation.kind === "object.patch") {
    const set = normalizeJsonProperties(operation.set, `Operation '${operation.id}' set`)
    const unset = normalizePropertyIds(operation.unset, `Operation '${operation.id}' unset`)
    const reset = normalizePropertyIds(operation.reset, `Operation '${operation.id}' reset`)
    const setIds = new Set(Object.keys(set))
    for (const propertyId of [...unset, ...reset]) {
      if (setIds.has(propertyId)) {
        throw new MaterializationValidationError(
          `Operation '${operation.id}' property '${propertyId}' appears in set and unset/reset.`
        )
      }
    }
    for (const propertyId of unset) {
      if (reset.includes(propertyId)) {
        throw new MaterializationValidationError(
          `Operation '${operation.id}' property '${propertyId}' appears in unset and reset.`
        )
      }
    }
    return Object.freeze({
      id: operation.id,
      kind: operation.kind,
      ref: normalizeObjectRef(operation.ref),
      set,
      unset,
      reset,
    })
  }
  if (operation.kind === "object.delete" || operation.kind === "object.restore") {
    return Object.freeze({
      id: operation.id,
      kind: operation.kind,
      ref: normalizeObjectRef(operation.ref),
    })
  }
  if (operation.kind === "link.upsert") {
    return Object.freeze({
      id: operation.id,
      kind: operation.kind,
      ref: normalizeLinkRef(operation.ref),
      ...(operation.properties !== undefined
        ? { properties: normalizeJsonProperties(operation.properties) }
        : {}),
    })
  }
  if (operation.kind === "link.delete" || operation.kind === "link.reset") {
    return Object.freeze({
      id: operation.id,
      kind: operation.kind,
      ref: normalizeLinkRef(operation.ref),
    })
  }
  throw new MaterializationValidationError("Unknown ontology edit operation kind.")
}

function deduplicateExpectations<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string
): readonly T[] {
  const byKey = new Map<string, T>()
  for (const value of values) {
    const key = keyOf(value)
    const existing = byKey.get(key)
    if (existing && stableJsonStringify(existing) !== stableJsonStringify(value)) {
      throw new MaterializationValidationError(`${label} has contradictory values for ${key}.`)
    }
    byKey.set(key, value)
  }
  return Object.freeze(
    [...byKey.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, value]) => value)
  )
}

function normalizeExpectedObject(value: ExpectedObjectRevision): ExpectedObjectRevision {
  const ref = normalizeObjectRef(value.ref)
  if (!value.exists) return Object.freeze({ ref, exists: false })
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new MaterializationValidationError("Expected object version must be a positive integer.")
  }
  return Object.freeze({
    ref,
    exists: true,
    version: value.version,
    lastCommitId: normalizeNonblank(value.lastCommitId, "Expected object lastCommitId"),
  })
}

function normalizeExpectedLink(value: ExpectedLinkRevision): ExpectedLinkRevision {
  const ref = normalizeLinkRef(value.ref)
  if (!value.exists) return Object.freeze({ ref, exists: false })
  return Object.freeze({
    ref,
    exists: true,
    lastCommitId: normalizeNonblank(value.lastCommitId, "Expected link lastCommitId"),
  })
}

function normalizeExpectedLinkScope(value: ExpectedLinkScopeRevision): ExpectedLinkScopeRevision {
  return Object.freeze({
    source: normalizeObjectRef(value.source),
    linkId: normalizeNonblank(value.linkId, "Expected link scope link id"),
    fingerprint: normalizeNonblank(value.fingerprint, "Expected link scope fingerprint"),
  })
}

/**
 * Validates that every grouped id exists exactly once across the declared groups.
 *
 * A group naming an unknown or repeated id would silently widen or split the unit a caller item
 * relies on, so both are rejected before any operation applies.
 */
function normalizeOperationGroups(
  groups: readonly (readonly string[])[],
  operationIds: ReadonlyMap<string, number>
): readonly (readonly string[])[] {
  const grouped = new Set<string>()
  const normalized = groups.map((group) => {
    if (group.length < 2) {
      throw new MaterializationValidationError(
        "Operation groups must contain at least two operations."
      )
    }

    const positions = group.map((id) => {
      const position = operationIds.get(id)
      if (position === undefined) {
        throw new MaterializationValidationError(
          `Operation group references unknown operation id '${id}'.`
        )
      }
      if (grouped.has(id)) {
        throw new MaterializationValidationError(
          `Operation id '${id}' appears in more than one operation group.`
        )
      }
      grouped.add(id)
      return position
    })

    const first = positions[0]!
    if (positions.some((position, index) => position !== first + index)) {
      throw new MaterializationValidationError(
        "Operation groups must list a contiguous run in operation order."
      )
    }
    return { first, ids: Object.freeze([...group]) }
  })

  normalized.sort((left, right) => left.first - right.first)
  return Object.freeze(normalized.map(({ ids }) => ids))
}

export function normalizeOntologyEditCommit(input: OntologyEditCommit): OntologyEditCommit {
  const operationIds = new Map<string, number>()
  const operations = input.operations.map((operation, index) => {
    const normalized = normalizeOperation(operation)
    if (operationIds.has(normalized.id)) {
      throw new MaterializationValidationError(`Duplicate operation id '${normalized.id}'.`)
    }
    operationIds.set(normalized.id, index)
    return normalized
  })

  if (input.mode === "continue") {
    return Object.freeze({
      mode: "continue",
      source: Object.freeze({
        kind: "runtime",
        requestId: normalizeNonblank(input.source.requestId, "Runtime request id"),
      }),
      ...(input.actor !== undefined ? { actor: normalizeEventActor(input.actor) } : {}),
      operations: Object.freeze(operations),
      ...(input.operationGroups !== undefined
        ? { operationGroups: normalizeOperationGroups(input.operationGroups, operationIds) }
        : {}),
    })
  }

  const source =
    input.source.kind === "action"
      ? Object.freeze({
          kind: "action" as const,
          actionId: normalizeNonblank(input.source.actionId, "Action id"),
          runId: normalizeNonblank(input.source.runId, "Action run id"),
        })
      : Object.freeze({
          kind: "runtime" as const,
          requestId: normalizeNonblank(input.source.requestId, "Runtime request id"),
        })
  const expectedObjects = input.expectedObjects.map(normalizeExpectedObject)
  const expectedLinks = input.expectedLinks.map(normalizeExpectedLink)
  const expectedLinkScopes = input.expectedLinkScopes.map(normalizeExpectedLinkScope)

  return Object.freeze({
    mode: "atomic",
    source,
    ...(input.actor !== undefined ? { actor: normalizeEventActor(input.actor) } : {}),
    operations: Object.freeze(operations),
    expectedObjects: deduplicateExpectations(
      expectedObjects,
      (value) => objectRefKey(value.ref),
      "Expected objects"
    ),
    expectedLinks: deduplicateExpectations(
      expectedLinks,
      (value) => linkRefKey(value.ref),
      "Expected links"
    ),
    expectedLinkScopes: deduplicateExpectations(
      expectedLinkScopes,
      (value) => linkScopeKey(value.source, value.linkId),
      "Expected link scopes"
    ),
  })
}

export function normalizeProjectionSourceRef(source: ProjectionSourceRef): ProjectionSourceRef {
  return Object.freeze({
    projectionId: normalizeNonblank(source.projectionId, "Projection id"),
  })
}

export function normalizePinnedDatasetVersion(version: PinnedDatasetVersion): PinnedDatasetVersion {
  return Object.freeze({
    datasetId: normalizeNonblank(version.datasetId, "Dataset id"),
    versionId: normalizeNonblank(version.versionId, "Dataset version id"),
    createdAt: normalizeTimestamp(version.createdAt, "Dataset version createdAt"),
  })
}

export function normalizeProjectionRunId(runId: string): string {
  return normalizeNonblank(runId, "Projection run id")
}

export function normalizeProjectionExecution(input: ProjectionExecution): ProjectionExecution {
  return Object.freeze({
    projectionRunId: normalizeProjectionRunId(input.projectionRunId),
    executionToken: normalizeNonblank(input.executionToken, "Projection execution token"),
  })
}

function normalizeProjectionEntity(entity: ProjectionEntityRef): ProjectionEntityRef {
  return entity.kind === "object"
    ? Object.freeze({ kind: "object", ref: normalizeObjectRef(entity.ref) })
    : Object.freeze({ kind: "link", ref: normalizeLinkRef(entity.ref) })
}

function normalizeProjectionAssertion(
  assertion: ProjectionSourceAssertion
): ProjectionSourceAssertion {
  return assertion.kind === "object"
    ? Object.freeze({
        kind: "object",
        ref: normalizeObjectRef(assertion.ref),
        properties: normalizeJsonProperties(assertion.properties),
      })
    : Object.freeze({
        kind: "link",
        ref: normalizeLinkRef(assertion.ref),
        ...(assertion.properties !== undefined
          ? { properties: normalizeJsonProperties(assertion.properties) }
          : {}),
      })
}

export function normalizeProjectionSourceEntry(
  input: ProjectionSourceEntry
): ProjectionSourceEntry {
  const root = normalizeProjectionEntity(input.root)
  const seen = new Set<string>()
  const assertions = input.assertions.map((assertion) => {
    const normalized = normalizeProjectionAssertion(assertion)
    const key = projectionEntityKey(normalized)
    if (seen.has(key)) {
      throw new MaterializationValidationError(`Projection entry repeats asserted entity ${key}.`)
    }
    seen.add(key)
    return normalized
  })
  const rootKey = projectionEntityKey(root)
  if (!seen.has(rootKey)) {
    throw new MaterializationValidationError(
      `Projection entry must contain an assertion matching root ${rootKey}.`
    )
  }
  if (root.kind === "object") {
    const objectAssertions = assertions.filter((assertion) => assertion.kind === "object")
    if (objectAssertions.length !== 1 || projectionEntityKey(objectAssertions[0]) !== rootKey) {
      throw new MaterializationValidationError(
        "An object projection root must contain exactly its matching object assertion plus links."
      )
    }
    for (const assertion of assertions) {
      if (
        assertion.kind === "link" &&
        objectRefKey(assertion.ref.source) !== objectRefKey(root.ref)
      ) {
        throw new MaterializationValidationError(
          "An object projection root may contain only links sourced from that root."
        )
      }
    }
  } else if (
    assertions.length !== 1 ||
    assertions[0].kind !== "link" ||
    projectionEntityKey(assertions[0]) !== rootKey
  ) {
    throw new MaterializationValidationError(
      "A link projection root must contain exactly its matching link assertion."
    )
  }
  return Object.freeze({
    root,
    assertions: Object.freeze(
      assertions.sort((left, right) =>
        compareStrings(projectionEntityKey(left), projectionEntityKey(right))
      )
    ),
  })
}

function normalizeTelemetrySeries(series: TelemetrySeriesRef): TelemetrySeriesRef {
  return Object.freeze({
    object: normalizeObjectRef(series.object),
    propertyId: normalizeNonblank(series.propertyId, "Telemetry property id"),
  })
}

function normalizeTelemetryPoint(point: TelemetryPointWrite): TelemetryPointWrite {
  try {
    assertJsonValue(point.value, "Telemetry point value")
  } catch (error) {
    throw new MaterializationValidationError(
      error instanceof Error ? error.message : "Telemetry point value must be JSON."
    )
  }
  return Object.freeze({
    series: normalizeTelemetrySeries(point.series),
    value: cloneJsonValue(point.value),
    ...(point.unit !== undefined
      ? { unit: normalizeNonblank(point.unit, "Telemetry point unit") }
      : {}),
    at: normalizeTimestamp(point.at, "Telemetry point timestamp"),
  })
}

export function normalizeTelemetryAppend(input: TelemetryAppend): TelemetryAppend {
  const pointsByKey = new Map<string, TelemetryPointWrite>()
  for (const point of input.points) {
    const normalized = normalizeTelemetryPoint(point)
    const key = telemetryPointKey(normalized.series, normalized.at)
    const existing = pointsByKey.get(key)
    if (
      input.source.kind === "runtime" &&
      existing &&
      stableJsonStringify(existing) !== stableJsonStringify(normalized)
    ) {
      throw new MaterializationValidationError(`Conflicting telemetry points for ${key}.`)
    }
    // Projection batches follow stable physical source order: the last occurrence wins. Runtime
    // callers remain strict because contradictory points usually indicate a request bug.
    pointsByKey.set(key, normalized)
  }
  const points = [...pointsByKey.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, point]) => point)
  const source =
    input.source.kind === "runtime"
      ? Object.freeze({
          kind: "runtime" as const,
          requestId: normalizeNonblank(input.source.requestId, "Runtime request id"),
        })
      : Object.freeze({
          kind: "projection" as const,
          projection: normalizeProjectionSourceRef(input.source.projection),
          datasetVersion: normalizePinnedDatasetVersion(input.source.datasetVersion),
          execution: normalizeProjectionExecution(input.source.execution),
          batchOrdinal: input.source.batchOrdinal,
          sourceRowCount: input.source.sourceRowCount,
          sourceRowsSkipped: input.source.sourceRowsSkipped,
          inputExhausted: input.source.inputExhausted,
        })
  if (source.kind === "projection") {
    if (!Number.isSafeInteger(source.batchOrdinal) || source.batchOrdinal < 0) {
      throw new MaterializationValidationError(
        "Telemetry projection batch ordinal must be a nonnegative safe integer."
      )
    }
    if (!Number.isSafeInteger(source.sourceRowCount) || source.sourceRowCount < 0) {
      throw new MaterializationValidationError(
        "Telemetry projection sourceRowCount must be a nonnegative safe integer."
      )
    }
    if (!Number.isSafeInteger(source.sourceRowsSkipped) || source.sourceRowsSkipped < 0) {
      throw new MaterializationValidationError(
        "Telemetry projection sourceRowsSkipped must be a nonnegative safe integer."
      )
    }
    if (source.sourceRowsSkipped > source.sourceRowCount) {
      throw new MaterializationValidationError(
        "Telemetry projection sourceRowsSkipped cannot exceed sourceRowCount."
      )
    }
    if (typeof source.inputExhausted !== "boolean") {
      throw new MaterializationValidationError(
        "Telemetry projection inputExhausted must be a boolean."
      )
    }
  }
  return Object.freeze({
    source,
    ...(input.actor !== undefined ? { actor: normalizeEventActor(input.actor) } : {}),
    points: Object.freeze(points),
  })
}
