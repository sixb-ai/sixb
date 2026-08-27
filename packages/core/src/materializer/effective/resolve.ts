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

export function resolveEffectiveObject(input: {
  readonly ref: OntologyObjectRef
  readonly primaryPropertyId: string
  readonly source: StoredSourceObjectAssertion | null
  readonly override: ObjectOverride | null
  readonly editedAt: Readonly<Record<string, string>>
  readonly latestTelemetry: readonly StoredTelemetryPoint[]
}): ResolvedObjectValue | null {
  const properties = resolveObjectAuthority(input.source, input.override, input.editedAt)
  if (!properties) return null

  properties[input.primaryPropertyId] = input.ref.primaryId
  applyLatestTelemetry(properties, input.latestTelemetry)
  return { ref: input.ref, properties }
}

function resolveObjectAuthority(
  source: StoredSourceObjectAssertion | null,
  override: ObjectOverride | null,
  editedAt: Readonly<Record<string, string>>
): Record<string, JsonValue> | null {
  switch (override?.kind) {
    case "delete":
      return null
    case "create":
      if (!source) return { ...override.properties }
      return resolveSourceAndEdits(source, override, editedAt)
    case "patch":
      if (!source) return null
      return resolveSourceAndEdits(source, override, editedAt)
    default:
      if (!source) return null
      return { ...source.assertion.properties }
  }
}

function resolveSourceAndEdits(
  source: StoredSourceObjectAssertion,
  override: Exclude<ObjectOverride, { readonly kind: "delete" }>,
  editedAt: Readonly<Record<string, string>>
): Record<string, JsonValue> {
  const properties = { ...source.assertion.properties }
  const policy = source.assertion.conflictResolution ?? { strategy: "editsWin" }
  const projectedPropertyIds = new Set(
    source.assertion.projectedPropertyIds ?? Object.keys(source.assertion.properties)
  )

  for (const propertyId of objectEditCandidateIds(override, editedAt)) {
    const edit = objectEditCandidate(override, propertyId)
    const editTimestamp = editedAt[propertyId]
    const sourceWins =
      projectedPropertyIds.has(propertyId) &&
      policy.strategy === "mostRecent" &&
      source.assertion.sourceUpdatedAt !== undefined &&
      editTimestamp !== undefined &&
      source.assertion.sourceUpdatedAt.localeCompare(editTimestamp) >= 0

    if (!sourceWins) applyObjectEditCandidate(properties, propertyId, edit)
  }
  return properties
}

interface ObjectPropertyCandidate {
  readonly present: boolean
  readonly value?: JsonValue
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
  const values = override.kind === "create" ? override.properties : override.set
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
  latestTelemetry: readonly StoredTelemetryPoint[]
): void {
  for (const point of latestTelemetry) properties[point.series.propertyId] = point.value
}

export function resolveEffectiveLink(input: {
  readonly ref: OntologyLinkRef
  readonly source: StoredSourceLinkAssertion | null
  readonly override: LinkOverride | null
  readonly sourceEndpointExists: boolean
  readonly targetEndpointExists: boolean
}): ResolvedLinkValue | null {
  if (!input.sourceEndpointExists || !input.targetEndpointExists) return null
  if (input.override?.kind === "delete") return null

  if (input.override?.kind === "upsert") {
    return resolvedLink(input.ref, input.override.properties)
  }
  if (!input.source) return null
  return resolvedLink(input.ref, input.source.assertion.properties)
}

/** Resolves the effective edge selected by a cardinality-one link slot. */
export function resolveEffectiveLinkSlot(input: {
  readonly scope: OntologyLinkScopeRef
  readonly source: StoredSourceLinkAssertion | null
  readonly override: LinkSlotOverride | null
  readonly endpointExists: (ref: OntologyObjectRef) => boolean
}): ResolvedLinkValue | null {
  if (!input.endpointExists(input.scope.source)) return null
  if (input.override?.kind === "clear") return null

  if (input.override?.kind === "set") {
    if (!input.endpointExists(input.override.target)) return null
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
  return resolvedLink(input.source.assertion.ref, input.source.assertion.properties)
}

/** Resolves one exact edge as a member of its cardinality-one link slot. */
export function resolveEffectiveLinkSlotMember(input: {
  readonly ref: OntologyLinkRef
  readonly source: StoredSourceLinkAssertion | null
  readonly override: LinkSlotOverride | null
  readonly endpointExists: (ref: OntologyObjectRef) => boolean
}): ResolvedLinkValue | null {
  const resolved = resolveEffectiveLinkSlot({
    scope: { source: input.ref.source, linkId: input.ref.linkId },
    source: input.source,
    override: input.override,
    endpointExists: input.endpointExists,
  })
  return resolved && linkRefKey(resolved.ref) === linkRefKey(input.ref) ? resolved : null
}

function resolvedLink(
  ref: OntologyLinkRef,
  properties: Readonly<Record<string, JsonValue>> | undefined
): ResolvedLinkValue {
  if (properties === undefined) return { ref }
  return { ref, properties }
}
