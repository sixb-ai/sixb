import { createHash, randomUUID } from "node:crypto"
import { assertJsonValue, stableJsonStringify } from "../json"
import { MaterializationValidationError } from "./errors"
import { linkRefSortKey } from "./refs"
import type { EffectiveLinkSnapshot, PinnedDatasetVersion, ProjectionSourceRef } from "./types"

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

export function createActionIdempotencyKey(runId: string): string {
  return `action:${runId}:edits`
}

export function createRuntimeIdempotencyKey(requestId: string): string {
  return `runtime:${requestId}`
}

export function createProjectionIdempotencyKey(
  source: ProjectionSourceRef,
  datasetVersion: PinnedDatasetVersion,
  projectionRevision: string
): string {
  return `projection:${source.projectionId}:replace:${datasetVersion.versionId}:${projectionRevision}`
}

export function createRuntimeTelemetryIdempotencyKey(requestId: string): string {
  return `telemetry:runtime:${requestId}`
}

export function createProjectionTelemetryIdempotencyKey(input: {
  readonly source: ProjectionSourceRef
  readonly datasetVersion: PinnedDatasetVersion
  readonly batchOrdinal: number
}): string {
  return `telemetry:projection:${input.source.projectionId}:${input.datasetVersion.versionId}:${input.batchOrdinal}`
}

export interface FixedCommitIdentity {
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly commitId: string
  readonly committedAt: string
}

export function createFixedCommitIdentity(input: {
  readonly projectId: string
  readonly idempotencyKey: string
  readonly normalizedCallerIntent: unknown
  readonly now?: Date
}): FixedCommitIdentity {
  const committedAt = new Date(input.now ?? new Date())
  if (Number.isNaN(committedAt.getTime())) {
    throw new MaterializationValidationError("Materialization commit time must be a valid date.")
  }
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    requestHash: createRequestHash(input.normalizedCallerIntent),
    commitId: createCommitId(input.projectId, input.idempotencyKey),
    committedAt: committedAt.toISOString(),
  })
}

/** Fresh per replacement invocation; callers retain it unchanged across staging/retry. */
export function createProjectionGenerationId(): string {
  return randomUUID()
}

export function createLinkScopeFingerprint(links: readonly EffectiveLinkSnapshot[]): string {
  return sha256Canonical(
    [...links]
      .sort((left, right) => {
        const leftKey = linkRefSortKey(left.ref)
        const rightKey = linkRefSortKey(right.ref)
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      })
      .map((link) => ({
        ref: link.ref,
        properties: link.properties ?? {},
        lastCommitId: link.lastCommitId,
      }))
  )
}
