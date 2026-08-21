import { randomUUID } from "node:crypto"
import { reportRunFailure } from "../error-reporting/capability"
import { createSixbError, toSixbFailure } from "../errors/internal"
import type { SixbFailure } from "../errors/types"
import type { RunDispatcher } from "../execution/dispatch"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { LakeStorage } from "../lake-storage"
import type { Queues } from "../queues"
import type { SixbDefinitions } from "../runtime/definitions"
import type { ExecutionRecord, ProjectionRunRecord, Storage } from "../storage"
import { ProjectionRunError } from "../storage"
import { findPrimitiveRunExecution } from "../storage/executions/run-link"
import {
  assertProjectionRunDurableExecution,
  assertProjectionRunIdentityMatches,
} from "../storage/projection-runs/provider"
import { getProjectionRegistry } from "./capability"
import { ProjectionValidationError } from "./errors"
import { createProjectionRunId } from "./run-id"
import {
  PROJECTION_RUN_FAILURE_CODES,
  type ProjectionDefinition,
  type ProjectionRunFailureCode,
} from "./types"

export const PROJECTION_TELEMETRY_BATCH_SIZE = 500

export interface ProjectionRunDispatchInput {
  readonly projectionId: string
  readonly datasetVersion: {
    readonly datasetId: string
    readonly versionId: string
    readonly createdAt: string
  }
  readonly metadata?: Readonly<Record<string, string>>
}

export interface ProjectionRunDispatchResult {
  readonly projectionId: string
  readonly runId: string
  readonly queuedAt: string
  readonly jobId?: string
  readonly created: boolean
}

export type ProjectionRunDispatchPort = RunDispatcher<
  ProjectionRunDispatchInput,
  ProjectionRunDispatchResult
>

export interface ProjectionRunDispatcherDependencies {
  readonly id: string
  readonly definitions: Pick<SixbDefinitions, "projections">
  readonly lakeStorage: Pick<LakeStorage, "getVersion">
  readonly storage: Storage
  readonly queues: Pick<Queues, "projections">
}

type PersistedProjectionRun =
  | { readonly publish: false; readonly run: ProjectionRunRecord }
  | {
      readonly publish: true
      readonly run: ProjectionRunRecord
      readonly queuedAt: Date
      readonly created: boolean
    }

/** Core-owned durable dispatch boundary for immutable dataset-version materialization. */
export class ProjectionRunDispatcher implements ProjectionRunDispatchPort {
  constructor(private readonly dependencies: ProjectionRunDispatcherDependencies) {}

  async dispatch(input: ProjectionRunDispatchInput): Promise<ProjectionRunDispatchResult> {
    assertDispatchInput(input)
    const registry = getProjectionRegistry(this.dependencies)
    const descriptor = registry.resolveDispatch(input.projectionId)
    if (descriptor.datasetId !== input.datasetVersion.datasetId) {
      throw new ProjectionValidationError(
        `[Sixb] Projection '${input.projectionId}' consumes dataset '${descriptor.datasetId}', not '${input.datasetVersion.datasetId}'.`
      )
    }
    const projection = this.dependencies.definitions.projections.getById(input.projectionId)
    if (!projection) {
      throw new ProjectionValidationError(`[Sixb] Unknown projection '${input.projectionId}'.`)
    }
    const version = await this.dependencies.lakeStorage.getVersion(
      input.datasetVersion.datasetId,
      input.datasetVersion.versionId
    )
    if (!version || version.createdAt.toISOString() !== input.datasetVersion.createdAt) {
      throw new ProjectionValidationError(
        `[Sixb] Dataset '${input.datasetVersion.datasetId}' version '${input.datasetVersion.versionId}' does not match its immutable metadata.`
      )
    }
    if (version.mode === "schema") {
      throw new ProjectionValidationError(
        `[Sixb] Projection '${input.projectionId}' cannot materialize a schema-only dataset version.`
      )
    }

    const { datasetId: _datasetId, ...semanticIdentity } = descriptor
    const identity = {
      ...semanticIdentity,
      datasetVersion: structuredClone(input.datasetVersion),
    }
    const runId = createProjectionRunId(this.dependencies.id, identity)
    const projectionRuns = requireProjectionRunStorage(this.dependencies.storage)
    const existing = await projectionRuns.getById({ projectId: this.dependencies.id, id: runId })
    const persisted = existing
      ? await reuseProjectionRun(this.dependencies, existing, identity)
      : await persistProjectionRun({
          dependencies: this.dependencies,
          runId,
          identity,
          projection,
          producerExecution: await resolveProducerExecution(
            this.dependencies.storage,
            this.dependencies.id,
            version.producer
          ),
        })

    if (!persisted.publish) return existingResult(persisted.run)
    return publishProjectionRun(this.dependencies, input.metadata, persisted)
  }
}

async function persistProjectionRun(input: {
  readonly dependencies: ProjectionRunDispatcherDependencies
  readonly runId: string
  readonly identity: ProjectionRunRecord["identity"]
  readonly projection: ProjectionDefinition
  readonly producerExecution: ExecutionRecord | null
}): Promise<PersistedProjectionRun> {
  const execution = createPrimitiveExecutionRecord({
    id: `exec_${randomUUID()}`,
    primitive: { kind: "projection", id: input.identity.projectionId, runId: input.runId },
    origin: {
      type: "automatic",
      projectId: input.dependencies.id,
      source: {
        type: "datasetVersion",
        datasetId: input.identity.datasetVersion.datasetId,
        versionId: input.identity.datasetVersion.versionId,
      },
      correlationId: input.producerExecution?.correlationId ?? input.runId,
      ...(input.producerExecution?.requestedBy === undefined
        ? {}
        : { requestedBy: input.producerExecution.requestedBy }),
    },
  })
  const queuedAt = new Date()

  try {
    return await input.dependencies.storage.transaction(
      async (tx): Promise<PersistedProjectionRun> => {
        const projectionRuns = requireProjectionRunStorage(tx)
        const raced = await projectionRuns.getById({
          projectId: input.dependencies.id,
          id: input.runId,
        })
        if (raced) {
          await assertExistingRun(tx, raced, input.identity)
          return { publish: false, run: raced }
        }
        await tx.executions.create(execution)
        const run = await queueProjectionRun(projectionRuns, {
          id: input.runId,
          projectId: input.dependencies.id,
          executionId: execution.id,
          identity: input.identity,
          projection: input.projection,
          queuedAt,
        })
        return { publish: true, run, queuedAt, created: true }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    if (!(error instanceof ProjectionRunError)) throw error
    const raced = await requireProjectionRunStorage(input.dependencies.storage).getById({
      projectId: input.dependencies.id,
      id: input.runId,
    })
    if (!raced) throw error
    await assertExistingRun(input.dependencies.storage, raced, input.identity)
    return { publish: false, run: raced }
  }
}

async function reuseProjectionRun(
  dependencies: ProjectionRunDispatcherDependencies,
  existing: ProjectionRunRecord,
  identity: ProjectionRunRecord["identity"]
): Promise<PersistedProjectionRun> {
  await assertExistingRun(dependencies.storage, existing, identity)
  if (
    existing.status !== "failed" ||
    existing.error?.code !== "queue.enqueue_failed" ||
    !existing.error.retryable
  ) {
    return { publish: false, run: existing }
  }
  const queuedAt = new Date()
  const projectionRuns = requireProjectionRunStorage(dependencies.storage)
  try {
    const run = await requeueProjectionRun(projectionRuns, existing, queuedAt)
    return { publish: true, run, queuedAt, created: false }
  } catch (error) {
    if (!(error instanceof ProjectionRunError)) throw error
    const raced = await projectionRuns.getById({ projectId: existing.projectId, id: existing.id })
    if (
      !raced ||
      (raced.status === "failed" &&
        raced.error?.code === "queue.enqueue_failed" &&
        raced.error.retryable)
    ) {
      throw error
    }
    await assertExistingRun(dependencies.storage, raced, identity)
    return { publish: false, run: raced }
  }
}

async function publishProjectionRun(
  dependencies: ProjectionRunDispatcherDependencies,
  metadata: Readonly<Record<string, string>> | undefined,
  persisted: Extract<PersistedProjectionRun, { readonly publish: true }>
): Promise<ProjectionRunDispatchResult> {
  try {
    const [job] = await dependencies.queues.projections.enqueue({
      projectId: dependencies.id,
      jobs: [
        {
          id: persisted.run.id,
          type: "projection.run.requested",
          payload: { runId: persisted.run.id },
          ...(metadata === undefined ? {} : { metadata }),
        },
      ],
    })
    return {
      projectionId: persisted.run.identity.projectionId,
      runId: persisted.run.id,
      queuedAt: persisted.queuedAt.toISOString(),
      ...(job?.id ? { jobId: job.id } : {}),
      created: persisted.created,
    }
  } catch (error) {
    const failedAt = new Date()
    const failure = toEnqueueFailure(error, persisted.run, failedAt)
    const failed = await requireProjectionRunStorage(dependencies.storage).failEnqueue({
      projectId: dependencies.id,
      id: persisted.run.id,
      finishedAt: failedAt,
      error: failure,
    })
    reportRunFailure(dependencies, error, {
      projectId: dependencies.id,
      runKind: "projection",
      run: {
        runId: failed.id,
        projectionId: failed.identity.projectionId,
        projectionKind: failed.identity.projectionKind,
      },
      failure,
    })
    throw error
  }
}

async function assertExistingRun(
  storage: Storage,
  run: ProjectionRunRecord,
  identity: ProjectionRunRecord["identity"]
): Promise<void> {
  assertProjectionRunIdentityMatches(run, identity)
  await assertProjectionRunDurableExecution({
    executions: storage.executions,
    projectId: run.projectId,
    executionId: run.executionId,
    runId: run.id,
    projectionId: run.identity.projectionId,
    datasetId: run.identity.datasetVersion.datasetId,
    datasetVersionId: run.identity.datasetVersion.versionId,
  })
}

async function resolveProducerExecution(
  storage: Storage,
  projectId: string,
  producer:
    | {
        readonly kind: "sync" | "pipeline"
        readonly id?: string
        readonly runId?: string
      }
    | undefined
): Promise<ExecutionRecord | null> {
  if (!producer?.runId) return null
  if (producer.kind === "sync") {
    const run = await storage.syncRuns?.getById({ projectId, id: producer.runId })
    if (!run) return null
    assertProducerId(producer, run.syncId)
    return requireProducerExecution({
      executions: storage.executions,
      projectId,
      executionId: run.executionId,
      primitive: { kind: "sync", id: run.syncId, runId: run.id },
    })
  }

  const run = await storage.pipelineRuns?.getById({ projectId, id: producer.runId })
  if (!run) return null
  assertProducerId(producer, run.pipelineId)
  return requireProducerExecution({
    executions: storage.executions,
    projectId,
    executionId: run.executionId,
    primitive: { kind: "pipeline", id: run.pipelineId, runId: run.id },
  })
}

async function requireProducerExecution(input: {
  readonly executions: Storage["executions"]
  readonly projectId: string
  readonly executionId: string
  readonly primitive:
    | { readonly kind: "sync"; readonly id: string; readonly runId: string }
    | { readonly kind: "pipeline"; readonly id: string; readonly runId: string }
}): Promise<ExecutionRecord> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: input.primitive,
    sourceTypes: ["execution", "schedule", "event"],
  })
  if (execution) return execution
  throw new ProjectionValidationError(
    `[Sixb] Dataset producer run '${input.primitive.runId}' references an invalid execution.`
  )
}

function assertProducerId(
  producer: { readonly kind: "sync" | "pipeline"; readonly id?: string; readonly runId?: string },
  runOwnerId: string
): void {
  if (producer.id === undefined || producer.id === runOwnerId) return
  throw new ProjectionValidationError(
    `[Sixb] Dataset producer '${producer.kind}:${producer.id}' does not match run '${producer.runId}'.`
  )
}

function requireProjectionRunStorage(storage: Storage): NonNullable<Storage["projectionRuns"]> {
  if (storage.projectionRuns) return storage.projectionRuns
  throw new ProjectionValidationError("[Sixb] Projection run storage is not configured.")
}

function queueProjectionRun(
  storage: NonNullable<Storage["projectionRuns"]>,
  input: {
    readonly id: string
    readonly projectId: string
    readonly executionId: string
    readonly identity: ProjectionRunRecord["identity"]
    readonly projection: ProjectionDefinition
    readonly queuedAt: Date
  }
): Promise<ProjectionRunRecord> {
  const common = {
    id: input.id,
    projectId: input.projectId,
    executionId: input.executionId,
    queuedAt: input.queuedAt,
  }
  switch (input.projection._tag) {
    case "ObjectProjectionDefinition":
      if (input.identity.projectionKind !== "object") {
        throw invalidProjectionDefinition(input.id)
      }
      return storage.queue({
        ...common,
        identity: input.identity,
        target: { objectTypeId: input.projection.objectTypeId },
      })
    case "LinkProjectionDefinition":
      if (input.identity.projectionKind !== "link") {
        throw invalidProjectionDefinition(input.id)
      }
      return storage.queue({
        ...common,
        identity: input.identity,
        target: {
          sourceObjectTypeId: input.projection.sourceObjectTypeId,
          targetObjectTypeId: input.projection.targetObjectTypeId,
        },
      })
    case "TelemetryProjectionDefinition":
      if (input.identity.projectionKind !== "telemetry") {
        throw invalidProjectionDefinition(input.id)
      }
      return storage.queue({
        ...common,
        identity: input.identity,
        target: { objectTypeId: input.projection.objectTypeId },
        fixedBatchSize: PROJECTION_TELEMETRY_BATCH_SIZE,
      })
  }
}

function requeueProjectionRun(
  storage: NonNullable<Storage["projectionRuns"]>,
  run: ProjectionRunRecord,
  queuedAt: Date
): Promise<ProjectionRunRecord> {
  const common = {
    id: run.id,
    projectId: run.projectId,
    executionId: run.executionId,
    queuedAt,
  }
  switch (run.identity.projectionKind) {
    case "object": {
      if (!("objectTypeId" in run.target)) throw invalidProjectionDefinition(run.id)
      return storage.queue({ ...common, identity: run.identity, target: run.target })
    }
    case "link": {
      if (!("sourceObjectTypeId" in run.target)) throw invalidProjectionDefinition(run.id)
      return storage.queue({ ...common, identity: run.identity, target: run.target })
    }
    case "telemetry": {
      if (!("objectTypeId" in run.target) || !run.telemetryCheckpoint) {
        throw invalidProjectionDefinition(run.id)
      }
      return storage.queue({
        ...common,
        identity: run.identity,
        target: run.target,
        fixedBatchSize: run.telemetryCheckpoint.fixedBatchSize,
      })
    }
  }
}

function invalidProjectionDefinition(runId: string): ProjectionValidationError {
  return new ProjectionValidationError(
    `[Sixb] Projection run '${runId}' has inconsistent definition metadata.`
  )
}

function existingResult(run: ProjectionRunRecord): ProjectionRunDispatchResult {
  return {
    projectionId: run.identity.projectionId,
    runId: run.id,
    queuedAt: run.queuedAt.toISOString(),
    created: false,
  }
}

function assertDispatchInput(input: ProjectionRunDispatchInput): void {
  for (const [field, value] of [
    ["projectionId", input.projectionId],
    ["datasetId", input.datasetVersion.datasetId],
    ["versionId", input.datasetVersion.versionId],
  ] as const) {
    if (!value.trim())
      throw new ProjectionValidationError(`[Sixb] Projection ${field} is required.`)
  }
  const timestamp = Date.parse(input.datasetVersion.createdAt)
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== input.datasetVersion.createdAt
  ) {
    throw new ProjectionValidationError("[Sixb] Projection dataset version timestamp is invalid.")
  }
}

function toEnqueueFailure(
  error: unknown,
  run: ProjectionRunRecord,
  at: Date
): SixbFailure<ProjectionRunFailureCode> {
  const enqueueError = createSixbError(
    "queue.enqueue_failed",
    `[Sixb] Could not enqueue Projection run '${run.id}'.`,
    {
      cause: error,
      details: {
        projectionId: run.identity.projectionId,
        projectionKind: run.identity.projectionKind,
        runId: run.id,
        phase: "enqueue",
      },
    }
  )
  return toSixbFailure(enqueueError, { allowedCodes: PROJECTION_RUN_FAILURE_CODES, at })
}
