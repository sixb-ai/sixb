import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  PinnedDatasetVersion,
  ProjectionMaterializationIdentity,
  ProjectionRunFinishInput,
  ProjectionRunTerminalDecision,
} from "../../materialization/model"
import type { ProjectionDefinition, ResolvedProjection } from "../../projections/types"
import type { OntologyCommitRecord } from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { withSerializationRetry } from "../execution/commit-lifecycle"
import {
  type LockedProjectionExecution,
  lockProjectionRunForMaterialization,
} from "../execution/run-correlation"
import {
  assertMaterializerRunExecution,
  assertTrustedPrimitiveMutationExecution,
  ensureMaterializerExecution,
  type MaterializerExecution,
  prepareMaterializerExecution,
} from "../execution/scope"
import type { MaterializerCommand } from "../materializer"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionExecution,
  normalizeProjectionSourceRef,
} from "../shared/normalize"
import { createProjectionRunMaterializationIdentity } from "../shared/projection-run"

interface PreparedProjectionRunFinish {
  readonly projectId: string
  readonly input: ProjectionRunFinishInput
  /**
   * The deployed definition a success must match. A failure needs none: it only has to hold the
   * run's execution token, and it must stay possible after a deploy changed or removed the
   * projection, or the run and its candidate could never end.
   */
  readonly deployed: DeployedProjectionIdentity | null
  readonly finishedAt: Date
  readonly execution: MaterializerExecution
}

interface DeployedProjectionIdentity {
  readonly identity: ProjectionMaterializationIdentity
  readonly resolved: ResolvedProjection<ProjectionDefinition>
}

export async function finishProjectionRun(
  context: MaterializerContext,
  raw: MaterializerCommand<ProjectionRunFinishInput>
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
  raw: MaterializerCommand<ProjectionRunFinishInput>
): PreparedProjectionRunFinish {
  assertValidTerminalDecision(raw.input)
  const source = normalizeProjectionSourceRef(raw.input.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.input.datasetVersion)
  const projectionExecution = normalizeProjectionExecution(raw.input.execution)
  const input = { ...raw.input, source, datasetVersion, execution: projectionExecution }
  return {
    projectId: context.projectId,
    input,
    deployed: input.status === "succeeded" ? resolveDeployedProjection(context, input) : null,
    finishedAt: new Date(raw.input.finishedAt ?? context.clock()),
    execution: prepareMaterializerExecution(context.projectId, raw.scope),
  }
}

function resolveDeployedProjection(
  context: Pick<MaterializerContext, "projectionRegistry">,
  input: ProjectionRunFinishInput
): DeployedProjectionIdentity {
  const resolved =
    input.protocol === "replacement"
      ? context.projectionRegistry.resolveSource(input.source.projectionId)
      : context.projectionRegistry.resolveTelemetry(input.source.projectionId)
  if (resolved.datasetId !== input.datasetVersion.datasetId) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
    )
  }
  const identity = createProjectionRunMaterializationIdentity({
    resolved,
    datasetVersion: input.datasetVersion,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
  })
  return { identity, resolved }
}

async function finishProjectionRunTransaction(
  storage: MaterializerStorage,
  command: PreparedProjectionRunFinish
): Promise<void> {
  await ensureMaterializerExecution(storage.executions, command.execution)
  assertTrustedPrimitiveMutationExecution(command.execution, {
    kind: "projection",
    id: command.input.source.projectionId,
    runId: command.input.execution.projectionRunId,
  })
  const { projectionRuns, run } = command.deployed
    ? await lockProjectionRunForMaterialization(storage, {
        projectId: command.projectId,
        projectionRunId: command.input.execution.projectionRunId,
        executionToken: command.input.execution.executionToken,
        identity: command.deployed.identity,
        resolved: command.deployed.resolved,
      })
    : await lockProjectionRunAsStored(storage, command)
  assertMaterializerRunExecution(command.execution, run.executionId, `Projection run '${run.id}'`)

  if (command.input.protocol === "replacement") {
    await assertReplacementTerminalDecision(storage, command)
    if (command.input.status !== "succeeded") {
      // The candidate belongs to the run: once the run ends, nothing may adopt or activate it.
      await storage.ontology.sources.abandon({
        kind: "run",
        projectId: command.projectId,
        source: command.input.source,
        execution: command.input.execution,
        abandonedAt: command.finishedAt.toISOString(),
      })
    }
  }

  await projectionRuns.finish({
    id: command.input.execution.projectionRunId,
    projectId: command.projectId,
    executionToken: command.input.execution.executionToken,
    identity: run.identity,
    ...terminalDecision(command.input),
    finishedAt: command.finishedAt,
  })
}

/** Locks a run by the identity it was pinned with, for a decision that needs no definition. */
async function lockProjectionRunAsStored(
  storage: MaterializerStorage,
  command: PreparedProjectionRunFinish
): Promise<LockedProjectionExecution> {
  const projectionRuns = storage.projectionRuns
  if (!projectionRuns) {
    throw new MaterializationValidationError(
      "Storage transaction does not provide projection run capabilities."
    )
  }
  const { input } = command
  const stored = await projectionRuns.getById({
    projectId: command.projectId,
    id: input.execution.projectionRunId,
  })
  if (
    !stored ||
    stored.identity.projectionId !== input.source.projectionId ||
    stored.identity.protocol !== input.protocol ||
    !datasetVersionsEqual(stored.identity.datasetVersion, input.datasetVersion)
  ) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection run '${input.execution.projectionRunId}' does not match its finish decision.`
    )
  }
  const run = await projectionRuns.lockForMaterialization({
    id: stored.id,
    projectId: command.projectId,
    executionToken: input.execution.executionToken,
    identity: stored.identity,
  })
  return { projectionRuns, run }
}

function assertValidTerminalDecision(input: ProjectionRunFinishInput): void {
  if (input.protocol !== "replacement" && input.protocol !== "telemetry") {
    throw new MaterializationValidationError("Projection finish protocol is invalid.")
  }
  if (input.status !== "succeeded" && input.status !== "failed" && input.status !== "cancelled") {
    throw new MaterializationValidationError("Projection finish status must be terminal.")
  }
  const inputExhausted = "inputExhausted" in input ? input.inputExhausted : undefined
  if (input.status === "succeeded" && input.protocol === "telemetry") {
    if (inputExhausted === true) return
    throw new MaterializationValidationError(
      "Telemetry projection success requires an explicit exhausted-input acknowledgement."
    )
  }
  if (inputExhausted !== undefined) {
    throw new MaterializationValidationError(
      "Only telemetry projection success can acknowledge exhausted input."
    )
  }
}

function terminalDecision(input: ProjectionRunFinishInput): ProjectionRunTerminalDecision {
  if (input.status !== "succeeded") {
    return {
      protocol: input.protocol,
      status: input.status,
      ...(input.error === undefined ? {} : { error: input.error }),
    }
  }
  if (input.protocol === "telemetry") {
    return { protocol: "telemetry", status: "succeeded", inputExhausted: true }
  }
  return { protocol: "replacement", status: "succeeded" }
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
  const { input } = command
  const identity = command.deployed?.identity
  if (
    !identity ||
    commit.origin.kind !== "projection" ||
    commit.executionId !== command.execution.executionId ||
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
