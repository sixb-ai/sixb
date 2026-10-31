import type { JsonValue } from "../../json"
import { MaterializationConflictError } from "../../materialization/errors"
import type {
  LinkOverride,
  LinkSlotOverride,
  ObjectOverride,
  OntologyLinkRef,
  OntologyLinkScopeRef,
  OntologyObjectRef,
} from "../../materialization/model"
import { linkRefKey } from "../../materialization/refs"
import type {
  StoredLinkSlotOverride,
  StoredObjectOverride,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
  StoredTelemetryPoint,
} from "../../storage/ontology"

export interface ResolvedObjectValue {
  readonly ref: OntologyObjectRef
  readonly properties: Readonly<Record<string, JsonValue>>
}

export interface ResolvedLinkValue {
  readonly ref: OntologyLinkRef
  readonly properties?: Readonly<Record<string, JsonValue>>
}

export function usableLinkSlotOverride(
  stored: StoredLinkSlotOverride | null
): LinkSlotOverride | null {
  if (!stored) return null
  if (stored.value.kind !== "legacy-conflict") return stored.value
  const { source, linkId } = stored.ref
  const scopeLabel = JSON.stringify([source.objectTypeId, source.primaryId, linkId])
  throw new MaterializationConflictError(
    "effective-state",
    `Cardinality-one link slot ${scopeLabel} could not be migrated automatically because it ` +
      "contains multiple legacy upsert overrides. Consolidate the stored overrides and clear " +
      "the migration conflict marker before materializing this scope."
  )
}

export interface EffectiveObjectInput {
  readonly ref: OntologyObjectRef
  readonly primaryPropertyId: string
  readonly source: StoredSourceObjectAssertion | null
  readonly override: ObjectOverride | null
  readonly editedAt: Readonly<Record<string, string>>
  readonly latestTelemetry: readonly StoredTelemetryPoint[]
}

/** What makes an object exist: a projection's source row, or an edit that created it. */
export type ObjectExistenceAuthority = "source" | "create"

/** One authority's candidate for a property: a value, or none, which clears it. */
export interface ObjectPropertyCandidate {
  readonly present: boolean
  readonly value?: JsonValue
}

/**
 * What decided one effective property. When a source row and an edit both hold a candidate, the
 * one that won keeps the other in `wonOver`.
 */
export type PropertyAuthority =
  | {
      readonly kind: "source"
      /** The edit the source row won over: only `mostRecent` lets a source win. */
      readonly wonOver?: {
        readonly candidate: ObjectPropertyCandidate
        readonly editedAt: string
        readonly sourceUpdatedAt: string
      }
    }
  | {
      readonly kind: "edit"
      readonly editedAt: string | undefined
      /** The source candidate the edit won over; `sourceUpdatedAt` is set under `mostRecent`. */
      readonly wonOver?: {
        readonly candidate: ObjectPropertyCandidate
        readonly sourceUpdatedAt: string | undefined
      }
    }
  | { readonly kind: "identity" }
  | { readonly kind: "telemetry"; readonly point: StoredTelemetryPoint }

/** An effective object with what decided its existence and each of its properties. */
export interface ExplainedObjectValue {
  readonly value: ResolvedObjectValue
  readonly existence: ObjectExistenceAuthority
  /** Every property resolution decided, one an authority cleared included. */
  readonly properties: ReadonlyMap<string, PropertyAuthority>
}

/** Receives each property decision as resolution makes it; a later one replaces an earlier one. */
type PropertyAuthorityRecorder = (propertyId: string, authority: PropertyAuthority) => void

interface ResolvedObjectAuthority {
  readonly properties: Record<string, JsonValue>
  readonly existence: ObjectExistenceAuthority
}

export function resolveEffectiveObject(input: EffectiveObjectInput): ResolvedObjectValue | null {
  return resolveObject(input)?.value ?? null
}

/**
 * Resolves the effective object exactly as {@link resolveEffectiveObject} does, and records what
 * decided its existence and each property: for callers that explain a value, such as lineage.
 */
export function explainEffectiveObject(input: EffectiveObjectInput): ExplainedObjectValue | null {
  const properties = new Map<string, PropertyAuthority>()
  const resolved = resolveObject(input, (propertyId, authority) => {
    properties.set(propertyId, authority)
  })
  if (!resolved) return null

  return { ...resolved, properties }
}

/** The one place the rules live: both functions above resolve through it. */
function resolveObject(
  input: EffectiveObjectInput,
  record?: PropertyAuthorityRecorder
): { readonly value: ResolvedObjectValue; readonly existence: ObjectExistenceAuthority } | null {
  const resolved = resolveObjectAuthority(input.source, input.override, input.editedAt, record)
  if (!resolved) return null

  const { properties, existence } = resolved
  properties[input.primaryPropertyId] = input.ref.primaryId
  record?.(input.primaryPropertyId, { kind: "identity" })

  applyLatestTelemetry(properties, input.latestTelemetry, record)
  return { value: { ref: input.ref, properties }, existence }
}

function resolveObjectAuthority(
  source: StoredSourceObjectAssertion | null,
  override: ObjectOverride | null,
  editedAt: Readonly<Record<string, string>>,
  record: PropertyAuthorityRecorder | undefined
): ResolvedObjectAuthority | null {
  switch (override?.kind) {
    case "delete":
      return null
    case "create":
      if (!source) {
        for (const propertyId of Object.keys(override.properties)) {
          record?.(propertyId, { kind: "edit", editedAt: editedAt[propertyId] })
        }
        return { properties: { ...override.properties }, existence: "create" }
      }
      return resolveSourceAndEdits(source, override, editedAt, record)
    case "patch":
      if (!source) return null
      return resolveSourceAndEdits(source, override, editedAt, record)
    default:
      if (!source) return null
      recordSourceProperties(source, record)
      return { properties: { ...source.assertion.properties }, existence: "source" }
  }
}

function resolveSourceAndEdits(
  source: StoredSourceObjectAssertion,
  override: Exclude<ObjectOverride, { readonly kind: "delete" }>,
  editedAt: Readonly<Record<string, string>>,
  record: PropertyAuthorityRecorder | undefined
): ResolvedObjectAuthority {
  const properties = { ...source.assertion.properties }
  const absentSourcePropertyIds = new Set(source.assertion.absentSourcePropertyIds ?? [])
  const sourceUpdatedAt = source.assertion.sourceUpdatedAt
  recordSourceProperties(source, record)

  for (const propertyId of objectEditCandidateIds(override, editedAt)) {
    const edit = objectEditCandidate(override, propertyId)
    const editTimestamp = editedAt[propertyId]
    const hasSourceCandidate =
      Object.hasOwn(source.assertion.properties, propertyId) ||
      absentSourcePropertyIds.has(propertyId)
    const sourceWins =
      hasSourceCandidate &&
      sourceUpdatedAt !== undefined &&
      editTimestamp !== undefined &&
      sourceUpdatedAt.localeCompare(editTimestamp) >= 0

    if (sourceWins) {
      record?.(propertyId, {
        kind: "source",
        wonOver: { candidate: edit, editedAt: editTimestamp, sourceUpdatedAt },
      })
      continue
    }

    applyObjectEditCandidate(properties, propertyId, edit)
    if (!record) continue

    const wonOver = hasSourceCandidate
      ? { candidate: propertyCandidate(source.assertion.properties, propertyId), sourceUpdatedAt }
      : undefined
    record(propertyId, { kind: "edit", editedAt: editTimestamp, ...(wonOver ? { wonOver } : {}) })
  }
  return { properties, existence: "source" }
}

function recordSourceProperties(
  source: StoredSourceObjectAssertion,
  record: PropertyAuthorityRecorder | undefined
): void {
  if (!record) return
  for (const propertyId of Object.keys(source.assertion.properties)) {
    record(propertyId, { kind: "source" })
  }
}

function objectEditCandidateIds(
  override: Exclude<ObjectOverride, { readonly kind: "delete" }>,
  editedAt: Readonly<Record<string, string>>
): string[] {
  const ids = new Set(Object.keys(editedAt))
  if (override.kind === "create") {
    for (const propertyId of Object.keys(override.properties)) ids.add(propertyId)
  } else {
    for (const propertyId of Object.keys(override.set)) ids.add(propertyId)
    for (const propertyId of override.unset) ids.add(propertyId)
  }
  return [...ids]
}

function objectEditCandidate(
  override: Exclude<ObjectOverride, { readonly kind: "delete" }>,
  propertyId: string
): ObjectPropertyCandidate {
  return propertyCandidate(
    override.kind === "create" ? override.properties : override.set,
    propertyId
  )
}

function propertyCandidate(
  values: Readonly<Record<string, JsonValue>>,
  propertyId: string
): ObjectPropertyCandidate {
  return Object.hasOwn(values, propertyId)
    ? { present: true, value: values[propertyId] }
    : { present: false }
}

function applyObjectEditCandidate(
  properties: Record<string, JsonValue>,
  propertyId: string,
  candidate: ObjectPropertyCandidate
): void {
  if (candidate.present) properties[propertyId] = candidate.value as JsonValue
  else delete properties[propertyId]
}

export function storedObjectEditedAt(stored: StoredObjectOverride | null): Record<string, string> {
  if (!stored || stored.value.kind === "delete") return {}
  const editedAt = { ...(stored.editedAt ?? {}) }
  const candidateIds =
    stored.value.kind === "create"
      ? Object.keys(stored.value.properties)
      : [...Object.keys(stored.value.set), ...stored.value.unset]
  for (const propertyId of candidateIds) editedAt[propertyId] ??= stored.updatedAt
  return editedAt
}

function applyLatestTelemetry(
  properties: Record<string, JsonValue>,
  latestTelemetry: readonly StoredTelemetryPoint[],
  record: PropertyAuthorityRecorder | undefined
): void {
  for (const point of latestTelemetry) {
    properties[point.series.propertyId] = point.value
    record?.(point.series.propertyId, { kind: "telemetry", point })
  }
}

/**
 * Which authority selects an effective link: its source assertion, or its managed override, which
 * is the edge's own for a cardinality-many link and its slot's for a cardinality-one link.
 */
export type LinkAuthority = "source" | "override"

/** Receives the authority of the edge a link resolution selects, for callers that explain it. */
type LinkAuthorityRecorder = (authority: LinkAuthority) => void

export function resolveEffectiveLink(
  input: {
    readonly ref: OntologyLinkRef
    readonly source: StoredSourceLinkAssertion | null
    readonly override: LinkOverride | null
    readonly sourceEndpointExists: boolean
    readonly targetEndpointExists: boolean
  },
  record?: LinkAuthorityRecorder
): ResolvedLinkValue | null {
  if (!input.sourceEndpointExists || !input.targetEndpointExists) return null
  if (input.override?.kind === "delete") return null

  if (input.override?.kind === "upsert") {
    record?.("override")
    return resolvedLink(input.ref, input.override.properties)
  }
  if (!input.source) return null
  record?.("source")
  return resolvedLink(input.ref, input.source.assertion.properties)
}

/** Resolves the effective edge selected by a cardinality-one link slot. */
export function resolveEffectiveLinkSlot(
  input: {
    readonly scope: OntologyLinkScopeRef
    readonly source: StoredSourceLinkAssertion | null
    readonly override: LinkSlotOverride | null
    readonly endpointExists: (ref: OntologyObjectRef) => boolean
  },
  record?: LinkAuthorityRecorder
): ResolvedLinkValue | null {
  if (!input.endpointExists(input.scope.source)) return null
  if (input.override?.kind === "clear") return null

  if (input.override?.kind === "set") {
    if (!input.endpointExists(input.override.target)) return null
    record?.("override")
    return resolvedLink(
      {
        source: input.scope.source,
        linkId: input.scope.linkId,
        target: input.override.target,
      },
      input.override.properties
    )
  }

  if (!input.source || !input.endpointExists(input.source.assertion.ref.target)) return null
  record?.("source")
  return resolvedLink(input.source.assertion.ref, input.source.assertion.properties)
}

/**
 * Resolves one exact edge as a member of its cardinality-one link slot. `record` hears the
 * authority of the edge the slot selects, which is this one only when it returns an edge.
 */
export function resolveEffectiveLinkSlotMember(
  input: {
    readonly ref: OntologyLinkRef
    readonly source: StoredSourceLinkAssertion | null
    readonly override: LinkSlotOverride | null
    readonly endpointExists: (ref: OntologyObjectRef) => boolean
  },
  record?: LinkAuthorityRecorder
): ResolvedLinkValue | null {
  const resolved = resolveEffectiveLinkSlot(
    {
      scope: { source: input.ref.source, linkId: input.ref.linkId },
      source: input.source,
      override: input.override,
      endpointExists: input.endpointExists,
    },
    record
  )
  return resolved && linkRefKey(resolved.ref) === linkRefKey(input.ref) ? resolved : null
}

function resolvedLink(
  ref: OntologyLinkRef,
  properties: Readonly<Record<string, JsonValue>> | undefined
): ResolvedLinkValue {
  if (properties === undefined) return { ref }
  return { ref, properties }
}
