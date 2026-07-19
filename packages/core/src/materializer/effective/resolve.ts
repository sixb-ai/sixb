import type { JsonValue } from "../../json"
import type {
  LinkOverride,
  ObjectOverride,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../../materialization/model"
import type {
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

function resolvedLink(
  ref: OntologyLinkRef,
  properties: Readonly<Record<string, JsonValue>> | undefined
): ResolvedLinkValue {
  if (properties === undefined) return { ref }
  return { ref, properties }
}
