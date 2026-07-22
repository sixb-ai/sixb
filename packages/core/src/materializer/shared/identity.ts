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
  ProjectionMaterializationIdentity,
} from "../../materialization/model"
import { compareLinkRefs } from "../../materialization/refs"

export function createActionIdempotencyKey(runId: string): string {
  return `action:${runId}:edits`
}

export function createRuntimeIdempotencyKey(requestId: string): string {
  return `runtime:${requestId}`
}

type ReplacementMaterializationIdentity = Extract<
  ProjectionMaterializationIdentity,
  { readonly protocol: "replacement" }
>
type TelemetryMaterializationIdentity = Extract<
  ProjectionMaterializationIdentity,
  { readonly protocol: "telemetry" }
>

function projectionIdentityTuple(
  input: ProjectionMaterializationIdentity
): readonly [string, string, string, string, string, string, string, string, string] {
  return [
    input.projectionId,
    input.projectionKind,
    input.protocol,
    input.datasetVersion.datasetId,
    input.datasetVersion.versionId,
    input.datasetVersion.createdAt,
    input.ontologyRevision,
    input.projectionRevision,
    input.ownershipHash,
  ]
}

export function createProjectionIdempotencyKey(
  identity: ReplacementMaterializationIdentity
): string {
  return `projection:replace:${sha256Canonical(projectionIdentityTuple(identity))}`
}

export function createRuntimeTelemetryIdempotencyKey(requestId: string): string {
  return `telemetry:runtime:${requestId}`
}

export function createProjectionTelemetryIdempotencyKey(
  identity: TelemetryMaterializationIdentity,
  batchOrdinal: number
): string {
  return `telemetry:projection:${sha256Canonical([
    ...projectionIdentityTuple(identity),
    batchOrdinal,
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
      .sort((left, right) => compareLinkRefs(left.ref, right.ref))
      .map((link) => ({
        ref: link.ref,
        properties: link.properties ?? {},
        lastCommitId: link.lastCommitId,
      }))
  )
}
