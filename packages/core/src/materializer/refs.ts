import { compareStrings } from "../json"
import { MaterializationValidationError } from "./errors"
import type {
  OntologyLinkRef,
  OntologyObjectRef,
  ProjectionEntityRef,
  TelemetrySeriesRef,
} from "./types"

const textEncoder = new TextEncoder()

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaterializationValidationError(`${label} must be a nonblank string.`)
  }
}

export function normalizeObjectRef(ref: OntologyObjectRef): OntologyObjectRef {
  assertIdentifier(ref.objectTypeId, "Object type id")
  assertIdentifier(ref.primaryId, "Object primary id")
  return Object.freeze({ objectTypeId: ref.objectTypeId, primaryId: ref.primaryId })
}

export function normalizeLinkRef(ref: OntologyLinkRef): OntologyLinkRef {
  assertIdentifier(ref.linkId, "Link id")
  return Object.freeze({
    source: normalizeObjectRef(ref.source),
    linkId: ref.linkId,
    target: normalizeObjectRef(ref.target),
  })
}

export function objectRefKey(ref: OntologyObjectRef): string {
  return JSON.stringify([ref.objectTypeId, ref.primaryId])
}

export function linkRefKey(ref: OntologyLinkRef): string {
  return JSON.stringify([
    ref.source.objectTypeId,
    ref.source.primaryId,
    ref.linkId,
    ref.target.objectTypeId,
    ref.target.primaryId,
  ])
}

export function projectionEntityKey(entity: ProjectionEntityRef): string {
  return entity.kind === "object"
    ? JSON.stringify(["object", entity.ref.objectTypeId, entity.ref.primaryId])
    : JSON.stringify([
        "link",
        entity.ref.source.objectTypeId,
        entity.ref.source.primaryId,
        entity.ref.linkId,
        entity.ref.target.objectTypeId,
        entity.ref.target.primaryId,
      ])
}

export function linkOwnershipKey(sourceObjectTypeId: string, linkId: string): string {
  return JSON.stringify([sourceObjectTypeId, linkId])
}

export function telemetryOwnershipKey(objectTypeId: string, propertyId: string): string {
  return JSON.stringify([objectTypeId, propertyId])
}

export function telemetrySeriesKey(series: TelemetrySeriesRef): string {
  return JSON.stringify([series.object.objectTypeId, series.object.primaryId, series.propertyId])
}

export function telemetryPointKey(series: TelemetrySeriesRef, at: string): string {
  return JSON.stringify([
    series.object.objectTypeId,
    series.object.primaryId,
    series.propertyId,
    at,
  ])
}

/**
 * A provider-collation-independent byte key. Providers compare this lowercase hexadecimal value
 * verbatim; all ontology identity structure is supplied by core in the canonical JSON tuple.
 */
export function canonicalIdentitySortKey(parts: readonly string[]): string {
  let result = ""
  for (const byte of textEncoder.encode(JSON.stringify(parts))) {
    result += byte.toString(16).padStart(2, "0")
  }
  return result
}

export function utf8JsonByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength
}

export function objectRefSortKey(ref: OntologyObjectRef): string {
  return canonicalIdentitySortKey([ref.objectTypeId, ref.primaryId])
}

export function linkRefSortKey(ref: OntologyLinkRef): string {
  return canonicalIdentitySortKey([
    ref.source.objectTypeId,
    ref.source.primaryId,
    ref.linkId,
    ref.target.objectTypeId,
    ref.target.primaryId,
  ])
}

export function linkScopeKey(source: OntologyObjectRef, linkId: string): string {
  return JSON.stringify([source.objectTypeId, source.primaryId, linkId])
}

export function linkScopeSortKey(source: OntologyObjectRef, linkId: string): string {
  return canonicalIdentitySortKey([source.objectTypeId, source.primaryId, linkId])
}

export function telemetryPointSortKey(series: TelemetrySeriesRef, at: string): string {
  return canonicalIdentitySortKey([
    series.object.objectTypeId,
    series.object.primaryId,
    series.propertyId,
    at,
  ])
}

export function compareObjectRefs(left: OntologyObjectRef, right: OntologyObjectRef): number {
  return compareStrings(objectRefSortKey(left), objectRefSortKey(right))
}

export function compareLinkRefs(left: OntologyLinkRef, right: OntologyLinkRef): number {
  return compareStrings(linkRefSortKey(left), linkRefSortKey(right))
}
