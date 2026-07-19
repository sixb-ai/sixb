import { createHash } from "node:crypto"
import { assertJsonValue, stableJsonStringify } from "../json"

export const ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER = Object.freeze([
  "object.created",
  "object.updated",
  "object.deleted",
  "link.created",
  "link.updated",
  "link.deleted",
  "telemetry.appended",
] as const)

export type OntologyMaterializationEventKind =
  (typeof ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER)[number]

export function materializationEventKindOrdinal(kind: OntologyMaterializationEventKind): number {
  return ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER.indexOf(kind)
}

export function sha256Canonical(value: unknown): string {
  assertJsonValue(value, "Canonical hash input")
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex")
}

export function createRequestHash(normalizedCallerIntent: unknown): string {
  return sha256Canonical(normalizedCallerIntent)
}

export function createCommitId(projectId: string, idempotencyKey: string): string {
  return sha256Canonical([projectId, idempotencyKey])
}

export function createEventId(projectId: string, commitId: string, ordinal: number): string {
  return sha256Canonical([projectId, commitId, ordinal])
}
