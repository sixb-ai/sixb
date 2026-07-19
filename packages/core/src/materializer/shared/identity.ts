import { randomUUID } from "node:crypto"

export type { OntologyMaterializationEventKind } from "../../materialization/identity"
export {
  createCommitId,
  createEventId,
  createRequestHash,
  materializationEventKindOrdinal,
  ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER,
  sha256Canonical,
} from "../../materialization/identity"

import { MaterializationValidationError } from "../../materialization/errors"
import { createCommitId, createRequestHash, sha256Canonical } from "../../materialization/identity"
import type {
  EffectiveLinkSnapshot,
  PinnedDatasetVersion,
  ProjectionSourceRef,
} from "../../materialization/model"
import { linkRefSortKey } from "../../materialization/refs"

export function createActionIdempotencyKey(runId: string): string {
  return `action:${runId}:edits`
}

export function createRuntimeIdempotencyKey(requestId: string): string {
  return `runtime:${requestId}`
}

export interface ProjectionMaterializationFingerprint {
  readonly source: ProjectionSourceRef
  readonly projectionKind: "object" | "link"
  readonly datasetVersion: PinnedDatasetVersion
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
}

export interface ProjectionTelemetryMaterializationFingerprint
  extends Omit<ProjectionMaterializationFingerprint, "projectionKind"> {
  readonly projectionKind: "telemetry"
  readonly batchOrdinal: number
}

function projectionFingerprintTuple(
  input: ProjectionMaterializationFingerprint | ProjectionTelemetryMaterializationFingerprint,
  protocol: "replacement" | "telemetry"
): readonly [string, string, string, string, string, string, string, string, string] {
  return [
    input.source.projectionId,
    input.projectionKind,
    protocol,
    input.datasetVersion.datasetId,
    input.datasetVersion.versionId,
    input.datasetVersion.createdAt,
    input.ontologyRevision,
    input.projectionRevision,
    input.ownershipHash,
  ]
}

export function createProjectionIdempotencyKey(
  input: ProjectionMaterializationFingerprint
): string {
  return `projection:replace:${sha256Canonical(projectionFingerprintTuple(input, "replacement"))}`
}

export function createRuntimeTelemetryIdempotencyKey(requestId: string): string {
  return `telemetry:runtime:${requestId}`
}

export function createProjectionTelemetryIdempotencyKey(
  input: ProjectionTelemetryMaterializationFingerprint
): string {
  return `telemetry:projection:${sha256Canonical([
    ...projectionFingerprintTuple(input, "telemetry"),
    input.batchOrdinal,
  ])}`
}

export interface CommitIdentity {
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly commitId: string
}

export interface TimedCommitIdentity extends CommitIdentity {
  readonly committedAt: string
}

export function createCommitIdentity(input: {
  readonly projectId: string
  readonly idempotencyKey: string
  readonly normalizedCallerIntent: unknown
}): CommitIdentity {
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    requestHash: createRequestHash(input.normalizedCallerIntent),
    commitId: createCommitId(input.projectId, input.idempotencyKey),
  })
}

export function timestampCommitIdentity(
  identity: CommitIdentity,
  now: Date = new Date()
): TimedCommitIdentity {
  const committedAt = new Date(now)
  if (Number.isNaN(committedAt.getTime())) {
    throw new MaterializationValidationError("Materialization commit time must be a valid date.")
  }
  return Object.freeze({
    ...identity,
    committedAt: committedAt.toISOString(),
  })
}

export function createTimedCommitIdentity(input: {
  readonly projectId: string
  readonly idempotencyKey: string
  readonly normalizedCallerIntent: unknown
  readonly now?: Date
}): TimedCommitIdentity {
  return timestampCommitIdentity(
    createCommitIdentity({
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      normalizedCallerIntent: input.normalizedCallerIntent,
    }),
    input.now
  )
}

/** Fresh per replacement invocation; callers retain it unchanged across staging/retry. */
export function createProjectionMaterializationId(): string {
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
