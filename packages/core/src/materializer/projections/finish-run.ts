import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  PinnedDatasetVersion,
  ProjectionMaterializationIdentity,
  ProjectionRunFinishInput,
} from "../../materialization/model"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { OntologyCommitRecord } from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { withSerializationRetry } from "../execution/commit-lifecycle"
import { lockProjectionRunForMaterialization } from "../execution/run-correlation"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionExecution,
  normalizeProjectionSourceRef,
} from "../shared/normalize"
import { createProjectionRunMaterializationIdentity } from "../shared/projection-run"

interface PreparedProjectionRunFinish {
  readonly projectId: string
  readonly input: ProjectionRunFinishInput
  readonly identity: ProjectionMaterializationIdentity
  readonly resolved: ResolvedProjection<ProjectionDefinition>
  readonly finishedAt: Date
}

export async function finishProjectionRun(
  context: MaterializerContext,
  raw: ProjectionRunFinishInput
): Promise<void> {
  const command = prepareProjectionRunFinish(context, raw)
  await withSerializationRetry(context, () =>
    context.storage.transaction((storage) => finishProjectionRunTransaction(storage, command), {
      isolation: "serializable",
    })
  )
}

function prepareProjectionRunFinish(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry" | "clock">,
  raw: ProjectionRunFinishInput
): PreparedProjectionRunFinish {
  const source = normalizeProjectionSourceRef(raw.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.datasetVersion)
  const execution = normalizeProjectionExecution(raw.execution)
  const resolved =
    raw.protocol === "replacement"
      ? context.projectionRegistry.resolveSource(source.projectionId)
      : context.projectionRegistry.resolveTelemetry(source.projectionId)
  if (resolved.datasetId !== datasetVersion.datasetId) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
    )
  }
  const identity = createProjectionRunMaterializationIdentity({
    resolved,
    datasetVersion,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
  })
  return {
    projectId: context.projectId,
    input: { ...raw, source, datasetVersion, execution },
    identity,
    resolved,
    finishedAt: context.clock(),
  }
}

async function finishProjectionRunTransaction(
  storage: MaterializerStorage,
  command: PreparedProjectionRunFinish
): Promise<void> {
  const { projectionRuns } = await lockProjectionRunForMaterialization(storage, {
    projectId: command.projectId,
    projectionRunId: command.input.execution.projectionRunId,
    executionToken: command.input.execution.executionToken,
    identity: command.identity,
    resolved: command.resolved,
  })

  if (command.input.protocol === "replacement") {
    await assertReplacementTerminalDecision(storage, command)
  }

  await projectionRuns.finish({
    id: command.input.execution.projectionRunId,
    projectId: command.projectId,
    executionToken: command.input.execution.executionToken,
    identity: command.identity,
    status: command.input.status,
    ...(command.input.status === "succeeded" ? {} : { errorMessage: command.input.errorMessage }),
    finishedAt: command.finishedAt,
  })
}

async function assertReplacementTerminalDecision(
  storage: MaterializerStorage,
  command: PreparedProjectionRunFinish
): Promise<void> {
  const commit = await storage.ontology.commits.getByOrigin({
    projectId: command.projectId,
    origin: {
      kind: "projection",
      projectionRunId: command.input.execution.projectionRunId,
    },
  })
  if (command.input.status === "succeeded") {
    if (!commit) {
      throw new MaterializationConflictError(
        "run-correlation",
        `Projection replacement run '${command.input.execution.projectionRunId}' cannot succeed before its ontology commit exists.`
      )
    }
    assertReplacementCommitCorrelation(commit, command)
    return
  }
  if (commit) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection replacement run '${command.input.execution.projectionRunId}' cannot finish as '${command.input.status}' after its ontology commit exists.`
    )
  }
}

function assertReplacementCommitCorrelation(
  commit: OntologyCommitRecord,
  command: PreparedProjectionRunFinish
): void {
  const { input, identity } = command
  if (
    commit.origin.kind !== "projection" ||
    commit.intent.kind !== "projection" ||
    commit.result.kind !== "projection" ||
    commit.origin.projectionRunId !== input.execution.projectionRunId ||
    commit.origin.projectionId !== input.source.projectionId ||
    commit.intent.source.projectionId !== input.source.projectionId ||
    !datasetVersionsEqual(commit.intent.datasetVersion, input.datasetVersion) ||
    commit.ontologyRevision !== identity.ontologyRevision ||
    commit.projectionRevision !== identity.projectionRevision ||
    commit.ownershipHash !== identity.ownershipHash
  ) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection replacement run '${input.execution.projectionRunId}' commit identity does not match.`
    )
  }
}

function datasetVersionsEqual(left: PinnedDatasetVersion, right: PinnedDatasetVersion): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.versionId === right.versionId &&
    left.createdAt === right.createdAt
  )
}
