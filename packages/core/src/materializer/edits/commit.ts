import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  EditCommitResult,
  OntologyEditCommit,
  OntologyEditOperation,
  OntologyMaterializationOrigin,
  OntologyOperationOutcome,
} from "../../materialization/model"
import type { Storage } from "../../storage"
import type { MaterializationSession, OntologyCommitWrite } from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { replayCommit, withSerializationRetry } from "../execution/commit-lifecycle"
import {
  assertMaterializerRunExecution,
  assertRuntimeMutationExecution,
  assertTrustedPrimitiveMutationExecution,
  ensureMaterializerExecution,
  type MaterializerExecution,
  prepareMaterializerExecution,
} from "../execution/scope"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import type { MaterializerCommand } from "../materializer"
import {
  createActionIdempotencyKey,
  createRuntimeIdempotencyKey,
  createTimedCommitIdentity,
  type TimedCommitIdentity,
} from "../shared/identity"
import { normalizeOntologyEditCommit } from "../shared/normalize"
import { compileEditExecutionUnits, type EditExecutionUnit } from "./execution-units"
import { loadEditWorkingState } from "./load-state"
import { applyEditOperation, type EditUndoJournal, undoEditJournal } from "./operations"
import { stageEditPlan } from "./plan"
import type { EditWorkingState } from "./working-state"

type NormalizedEditCommit = ReturnType<typeof normalizeOntologyEditCommit>

interface PreparedEditCommit {
  readonly input: NormalizedEditCommit
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
  readonly execution: MaterializerExecution
}

export async function commitEdits(
  context: MaterializerContext,
  raw: MaterializerCommand<OntologyEditCommit>
): Promise<EditCommitResult> {
  const command = prepareEditCommit(context, raw)
  return executeEditCommit(context, command)
}

function prepareEditCommit(
  context: Pick<MaterializerContext, "projectId" | "clock">,
  raw: MaterializerCommand<OntologyEditCommit>
): PreparedEditCommit {
  const input = normalizeOntologyEditCommit(raw.input)
  const idempotencyKey = editIdempotencyKey(input)
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: input,
    now: context.clock(),
  })
  return {
    input,
    identity,
    origin: input.source,
    execution: prepareMaterializerExecution(context.projectId, raw.scope),
  }
}

function editIdempotencyKey(input: NormalizedEditCommit): string {
  if (input.source.kind === "action") {
    return createActionIdempotencyKey(input.source.runId)
  }
  return createRuntimeIdempotencyKey(input.source.requestId)
}

async function lockActionRunForMaterialization(
  storage: Storage,
  projectId: string,
  input: NormalizedEditCommit,
  execution: MaterializerExecution
): Promise<void> {
  if (input.source.kind !== "action") return
  if (!storage.actionRuns) {
    throw new MaterializationValidationError(
      "Storage does not provide Action run capabilities required by this commit."
    )
  }
  const run = await storage.actionRuns.lockForMaterialization({
    projectId,
    actionId: input.source.actionId,
    runId: input.source.runId,
  })
  assertMaterializerRunExecution(execution, run.executionId, `Action run '${run.id}'`)
}

async function validateMutationExecution(
  storage: Storage,
  projectId: string,
  input: NormalizedEditCommit,
  execution: MaterializerExecution
): Promise<void> {
  if (input.source.kind !== "action") {
    assertRuntimeMutationExecution(execution)
    return
  }
  assertTrustedPrimitiveMutationExecution(execution, {
    kind: "action",
    id: input.source.actionId,
    runId: input.source.runId,
  })
  if (!storage.actionRuns) {
    throw new MaterializationValidationError(
      "Storage does not provide Action run capabilities required by this commit."
    )
  }
  const run = await storage.actionRuns.getById({ projectId, id: input.source.runId })
  if (!run) {
    throw new MaterializationValidationError(`Action run '${input.source.runId}' was not found.`)
  }
  if (run.actionId !== input.source.actionId) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Action run '${run.id}' does not belong to action '${input.source.actionId}'.`
    )
  }
  assertMaterializerRunExecution(execution, run.executionId, `Action run '${run.id}'`)
}

async function executeEditCommit(
  context: MaterializerContext,
  command: PreparedEditCommit
): Promise<EditCommitResult> {
  return withSerializationRetry(context, () =>
    context.storage.transaction((storage) => executeEditTransaction(context, storage, command), {
      isolation: "serializable",
    })
  )
}

async function executeEditTransaction(
  context: MaterializerContext,
  storage: MaterializerStorage,
  command: PreparedEditCommit
): Promise<EditCommitResult> {
  await ensureMaterializerExecution(storage.executions, command.execution)
  await validateMutationExecution(storage, context.projectId, command.input, command.execution)

  const replay = await replayCommit<EditCommitResult>(
    context,
    command.identity,
    command.execution.executionId,
    storage
  )
  if (replay) return replay

  await lockActionRunForMaterialization(
    storage,
    context.projectId,
    command.input,
    command.execution
  )

  const session = await beginEditMaterialization(context, storage, command)
  const workingState = await loadEditWorkingState(
    context,
    storage.ontology.materializations,
    session,
    command.input.operations
  )
  const outcomes = applyEditOperations(context, workingState, command)
  const changes = await stageEditPlan(
    context,
    storage.ontology.materializations,
    session,
    workingState,
    editPlanContext(command)
  )
  await drainStagedWork(context, storage.ontology.materializations, session)
  const eventCount = await drainStagedEvents(
    context,
    storage.ontology.materializations,
    session,
    command.identity
  )

  const result: EditCommitResult = {
    kind: "edit",
    commitId: command.identity.commitId,
    created: true,
    eventCount,
    committedAt: command.identity.committedAt,
    outcomes,
    changes,
  }
  return finalizeEditMaterialization(storage, session, result)
}

async function beginEditMaterialization(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry">,
  storage: MaterializerStorage,
  command: PreparedEditCommit
): Promise<MaterializationSession> {
  const commit = buildEditCommit(context, command)
  return storage.ontology.materializations.begin({
    commit,
    expected: {
      sources: [],
      ...editExpectations(command.input),
      points: [],
    },
  })
}

function buildEditCommit(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry">,
  command: PreparedEditCommit
): OntologyCommitWrite {
  const commit: OntologyCommitWrite = {
    projectId: context.projectId,
    id: command.identity.commitId,
    idempotencyKey: command.identity.idempotencyKey,
    requestHash: command.identity.requestHash,
    executionId: command.execution.executionId,
    origin: command.origin,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
    intent: {
      kind: "edit",
      mode: command.input.mode,
      operationCount: command.input.operations.length,
    },
    committedAt: command.identity.committedAt,
  }
  if (command.execution.actor === undefined) return commit
  return { ...commit, actor: command.execution.actor }
}

function editExpectations(input: NormalizedEditCommit) {
  if (input.mode === "atomic") {
    return {
      objects: input.expectedObjects,
      links: input.expectedLinks,
      linkScopes: input.expectedLinkScopes,
    }
  }
  return { objects: [], links: [], linkScopes: [] }
}

function applyEditOperations(
  context: MaterializerContext,
  state: EditWorkingState,
  command: PreparedEditCommit
): OntologyOperationOutcome[] {
  const outcomes: OntologyOperationOutcome[] = []
  const units = compileEditExecutionUnits(command.input)
  for (const unit of units) {
    outcomes.push(...applyEditExecutionUnit(context, state, command, unit))
  }
  return outcomes
}

function applyEditExecutionUnit(
  context: MaterializerContext,
  state: EditWorkingState,
  command: PreparedEditCommit,
  unit: EditExecutionUnit
): OntologyOperationOutcome[] {
  if (unit.kind === "atomic-group") {
    return applyEditOperationGroup(context, state, command, unit.operations)
  }
  return [applyOneEditOperation(context, state, unit.operation, command)]
}

function applyOneEditOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: OntologyEditOperation,
  command: PreparedEditCommit
): OntologyOperationOutcome {
  try {
    return applyEditOperation(context, state, operation, command.identity)
  } catch (error) {
    if (!isRecoverableEditValidation(command.input, error)) throw error
    return { id: operation.id, ok: false, error: { code: "validation", message: error.message } }
  }
}

/**
 * Applies one grouped item, rolling the whole group back if any operation in it fails.
 *
 * Without this, continue mode would leave an item half-applied: a cardinality-one reassignment
 * whose `link.delete` succeeded and whose `link.upsert` failed would report an item error while the
 * original edge stayed deleted.
 */
function applyEditOperationGroup(
  context: MaterializerContext,
  state: EditWorkingState,
  command: PreparedEditCommit,
  group: readonly OntologyEditOperation[]
): OntologyOperationOutcome[] {
  const journal: EditUndoJournal = []
  const applied: OntologyOperationOutcome[] = []

  for (const operation of group) {
    let outcome: OntologyOperationOutcome
    try {
      outcome = applyEditOperation(context, state, operation, command.identity, journal)
    } catch (error) {
      if (!isRecoverableEditValidation(command.input, error)) throw error
      undoEditJournal(journal)
      return failedEditGroup(group, error.message)
    }
    if (!outcome.ok) {
      undoEditJournal(journal)
      return failedEditGroup(group, outcome.error.message)
    }
    applied.push(outcome)
  }
  return applied
}

/** Reports every id in a rolled-back group as failed, so no position looks applied. */
function failedEditGroup(
  group: readonly OntologyEditOperation[],
  message: string
): OntologyOperationOutcome[] {
  return group.map((operation) => ({
    id: operation.id,
    ok: false as const,
    error: { code: "validation" as const, message },
  }))
}

function isRecoverableEditValidation(
  input: NormalizedEditCommit,
  error: unknown
): error is MaterializationValidationError {
  if (input.mode === "atomic") return false
  return error instanceof MaterializationValidationError
}

function editPlanContext(command: PreparedEditCommit) {
  const context = {
    identity: command.identity,
    origin: command.origin,
    correlationId: command.execution.correlationId,
  }
  if (command.execution.actor === undefined) return context
  return { ...context, actor: command.execution.actor }
}

async function finalizeEditMaterialization(
  storage: MaterializerStorage,
  session: MaterializationSession,
  result: EditCommitResult
): Promise<EditCommitResult> {
  const applied = await storage.ontology.materializations.finalize({
    session,
    finalization: { sourceActivations: [], result },
  })
  return applied.commit.result as EditCommitResult
}
