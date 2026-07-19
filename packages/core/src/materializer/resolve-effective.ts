import type { JsonValue } from "../json"
import type {
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
  StoredTelemetryPoint,
} from "../storage/ontology"
import type { LinkOverride, ObjectOverride, OntologyLinkRef, OntologyObjectRef } from "./types"

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
  if (input.override?.kind === "delete") return null
  let properties: Record<string, JsonValue>
  if (input.override?.kind === "create") {
    properties = { ...input.override.properties }
  } else {
    if (!input.source) return null
    properties = { ...input.source.assertion.properties }
    if (input.override?.kind === "patch") {
      Object.assign(properties, input.override.set)
      for (const propertyId of input.override.unset) delete properties[propertyId]
    }
  }
  properties[input.primaryPropertyId] = input.ref.primaryId
  for (const point of input.latestTelemetry) properties[point.series.propertyId] = point.value
  return { ref: input.ref, properties }
}

export function resolveEffectiveLink(input: {
  readonly ref: OntologyLinkRef
  readonly source: StoredSourceLinkAssertion | null
  readonly override: LinkOverride | null
  readonly sourceEndpointExists: boolean
  readonly targetEndpointExists: boolean
}): ResolvedLinkValue | null {
  if (
    !input.sourceEndpointExists ||
    !input.targetEndpointExists ||
    input.override?.kind === "delete"
  ) {
    return null
  }
  if (input.override?.kind === "upsert") {
    return {
      ref: input.ref,
      ...(input.override.properties !== undefined ? { properties: input.override.properties } : {}),
    }
  }
  if (!input.source) return null
  return {
    ref: input.ref,
    ...(input.source.assertion.properties !== undefined
      ? { properties: input.source.assertion.properties }
      : {}),
  }
}
