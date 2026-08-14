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
  readonly latestTelemetry: readonly StoredTelemetryPoint[]
}): ResolvedObjectValue | null {
  const properties = resolveObjectAuthority(input.source, input.override)
  if (!properties) return null

  properties[input.primaryPropertyId] = input.ref.primaryId
  applyLatestTelemetry(properties, input.latestTelemetry)
  return { ref: input.ref, properties }
}

function resolveObjectAuthority(
  source: StoredSourceObjectAssertion | null,
  override: ObjectOverride | null
): Record<string, JsonValue> | null {
  switch (override?.kind) {
    case "delete":
      return null
    case "create":
      return { ...override.properties }
    case "patch":
      if (!source) return null
      return applyObjectPatch(source.assertion.properties, override)
    default:
      if (!source) return null
      return { ...source.assertion.properties }
  }
}

function applyObjectPatch(
  sourceProperties: Readonly<Record<string, JsonValue>>,
  override: Extract<ObjectOverride, { readonly kind: "patch" }>
): Record<string, JsonValue> {
  const properties = { ...sourceProperties, ...override.set }
  for (const propertyId of override.unset) delete properties[propertyId]
  return properties
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
