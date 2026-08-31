import type {
  EditOntologyCommitIntent,
  OntologyCommitWrite,
  ProjectionOntologyCommitIntent,
  TelemetryOntologyCommitIntent,
} from "./commits"
import type { MaterializationPlanHeader } from "./materializations"
import {
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertTimestamp,
  invalidCorrelation,
} from "./provider-validation"

/** Validates provider-neutral commit identity and intent/origin correlation. */
export function assertMaterializationHeader({ commit }: MaterializationPlanHeader): void {
  assertCommitEnvelope(commit)

  switch (commit.intent.kind) {
    case "edit":
      assertEditCommit(commit, commit.intent)
      break
    case "projection":
      assertProjectionCommit(commit, commit.intent)
      break
    case "telemetry":
      assertTelemetryCommit(commit, commit.intent)
      break
  }
}

function assertCommitEnvelope(commit: OntologyCommitWrite): void {
  assertNonblank(commit.projectId, "Materialization project id")
  assertNonblank(commit.id, "Materialization commit id")
  assertNonblank(commit.idempotencyKey, "Materialization idempotency key")
  assertNonblank(commit.requestHash, "Materialization request hash")
  assertNonblank(commit.executionId, "Materialization execution id")
  assertNonblank(commit.ontologyRevision, "Materialization ontology revision")
  assertTimestamp(commit.committedAt, "Materialization commit time")
}

function assertEditCommit(commit: OntologyCommitWrite, intent: EditOntologyCommitIntent): void {
  assertNonnegativeInteger(intent.operationCount, "Edit commit operation count")

  switch (commit.origin.kind) {
    case "action":
      assertNonblank(commit.origin.actionId, "Action origin action id")
      assertNonblank(commit.origin.runId, "Action origin run id")
      return
    case "runtime":
      assertNonblank(commit.origin.requestId, "Runtime origin request id")
      return
    default:
      invalidCorrelation("Edit commit origin does not correlate with its intent.")
  }
}

function assertProjectionCommit(
  commit: OntologyCommitWrite,
  intent: ProjectionOntologyCommitIntent
): void {
  if (commit.origin.kind !== "projection") {
    invalidCorrelation("Projection commit origin does not correlate with its intent.")
  }

  assertProjectionSemanticMetadata(commit)
  assertNonblank(commit.origin.projectionRunId, "Projection run id")
  assertTimestamp(intent.datasetVersion.createdAt, "Projection dataset version createdAt")

  if (commit.origin.projectionId !== intent.source.projectionId) {
    invalidCorrelation("Projection commit origin does not match its projection.")
  }
  if (
    commit.origin.datasetId !== intent.datasetVersion.datasetId ||
    commit.origin.datasetVersionId !== intent.datasetVersion.versionId
  ) {
    invalidCorrelation("Projection commit origin does not match its dataset version.")
  }
}

function assertTelemetryCommit(
  commit: OntologyCommitWrite,
  intent: TelemetryOntologyCommitIntent
): void {
  if (commit.origin.kind !== "telemetry") {
    invalidCorrelation("Telemetry commit origin does not correlate with its intent.")
  }

  assertTelemetryPointCounts(intent)
  if (intent.source.kind === "runtime") {
    assertRuntimeTelemetryCommit(commit)
    return
  }
  assertProjectionTelemetryCommit(commit, intent.source, intent.inputPointCount)
}

function assertTelemetryPointCounts(intent: TelemetryOntologyCommitIntent): void {
  assertNonnegativeInteger(intent.pointCount, "Telemetry commit point count")
  assertNonnegativeInteger(intent.inputPointCount, "Telemetry commit input point count")
  if (intent.inputPointCount < intent.pointCount) {
    invalidCorrelation(
      "Telemetry input point count cannot be lower than its canonical point count."
    )
  }
}

function assertRuntimeTelemetryCommit(commit: OntologyCommitWrite): void {
  if (commit.origin.kind !== "telemetry" || commit.origin.source.kind !== "runtime") {
    invalidCorrelation("Runtime telemetry origin does not correlate with its intent.")
  }
  if (commit.projectionRevision !== undefined || commit.ownershipHash !== undefined) {
    invalidCorrelation("Runtime telemetry commit contains projection-only metadata.")
  }
  assertNonblank(commit.origin.source.requestId, "Runtime telemetry request id")
}

function assertProjectionTelemetryCommit(
  commit: OntologyCommitWrite,
  source: Extract<TelemetryOntologyCommitIntent["source"], { readonly kind: "projection" }>,
  inputPointCount: number
): void {
  if (commit.origin.kind !== "telemetry" || commit.origin.source.kind !== "projection") {
    invalidCorrelation("Projection telemetry origin does not correlate with its intent.")
  }

  const origin = commit.origin.source
  assertProjectionSemanticMetadata(commit)
  assertNonblank(origin.projectionRunId, "Telemetry projection run id")
  assertTimestamp(source.datasetVersion.createdAt, "Telemetry dataset version createdAt")
  assertProjectionTelemetryBatch(source, inputPointCount)

  if (origin.projectionId !== source.projection.projectionId) {
    invalidCorrelation("Projection telemetry origin does not match its projection.")
  }
  if (
    origin.datasetId !== source.datasetVersion.datasetId ||
    origin.datasetVersionId !== source.datasetVersion.versionId
  ) {
    invalidCorrelation("Projection telemetry origin does not match its dataset version.")
  }
  if (origin.batchOrdinal !== source.batchOrdinal) {
    invalidCorrelation("Projection telemetry origin does not match its batch ordinal.")
  }
}

function assertProjectionTelemetryBatch(
  source: Extract<TelemetryOntologyCommitIntent["source"], { readonly kind: "projection" }>,
  inputPointCount: number
): void {
  assertNonnegativeInteger(source.batchOrdinal, "Projection telemetry batch ordinal")
  assertPositiveInteger(source.sourceRowCount, "Projection telemetry source row count")
  assertNonnegativeInteger(source.sourceRowsSkipped, "Projection telemetry skipped row count")

  if (source.sourceRowsSkipped > source.sourceRowCount) {
    invalidCorrelation("Projection telemetry skipped rows exceed its source row count.")
  }
  if (inputPointCount < source.sourceRowCount - source.sourceRowsSkipped) {
    invalidCorrelation(
      "Projection telemetry input points do not account for every non-skipped source row."
    )
  }
  if (typeof source.inputExhausted !== "boolean") {
    invalidCorrelation("Projection telemetry input exhaustion marker is invalid.")
  }
}

function assertProjectionSemanticMetadata(commit: OntologyCommitWrite): void {
  if (commit.projectionRevision === undefined || commit.ownershipHash === undefined) {
    invalidCorrelation("Projection materialization is missing semantic identity metadata.")
  }
  assertNonblank(commit.projectionRevision, "Projection revision")
  assertNonblank(commit.ownershipHash, "Projection ownership hash")
}
