import { MaterializationValidationError } from "../../materialization/errors"
import type {
  EditCommitResult,
  OntologyEditCommit,
  OntologyEditOperation,
  OntologyMaterializationOrigin,
  OntologyOperationOutcome,
} from "../../materialization/model"
import { isActionMaterializationRunStorage, type Storage } from "../../storage"
import type {
  MaterializationLinkScopeState,
  MaterializationSession,
  OntologyCommitWrite,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { replayCommit, withSerializationRetry } from "../execution/commit-lifecycle"
import { drainStagedEvents, drainStagedWork } from "../execution/work-executor"
import {
  createActionIdempotencyKey,
  createRuntimeIdempotencyKey,
  createTimedCommitIdentity,
  type TimedCommitIdentity,
} from "../shared/identity"
import { normalizeOntologyEditCommit } from "../shared/normalize"
import {
  applyEditOperation,
  type EditUndoJournal,
  type EditWorkingState,
  undoEditJournal,
} from "./operations"
import { stageEditPlan } from "./plan"
import type { WorkingLink, WorkingObject } from "./working-state"

type NormalizedEditCommit = ReturnType<typeof normalizeOntologyEditCommit>

interface PreparedEditCommit {
  readonly input: NormalizedEditCommit
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
}

export async function commitEdits(
  context: MaterializerContext,
  raw: OntologyEditCommit
): Promise<EditCommitResult> {
  const command = prepareEditCommit(context, raw)
  await assertActionRun(context.storage, context.projectId, command.input)

  const replay = await replayEditCommit(context, command)
  if (replay) return replay

  return executeEditCommit(context, command)
}

function prepareEditCommit(
  context: Pick<MaterializerContext, "projectId" | "clock">,
  raw: OntologyEditCommit
): PreparedEditCommit {
  const input = normalizeOntologyEditCommit(raw)
  const idempotencyKey = editIdempotencyKey(input)
  const identity = createTimedCommitIdentity({
    projectId: context.projectId,
    idempotencyKey,
    normalizedCallerIntent: input,
    now: context.clock(),
  })
  return { input, identity, origin: input.source }
}

function editIdempotencyKey(input: NormalizedEditCommit): string {
  if (input.source.kind === "action") {
    return createActionIdempotencyKey(input.source.runId)
  }
  return createRuntimeIdempotencyKey(input.source.requestId)
}

async function assertActionRun(
  storage: Storage,
  projectId: string,
  input: NormalizedEditCommit
): Promise<void> {
  if (input.source.kind !== "action") return
  if (!isActionMaterializationRunStorage(storage.actionRuns)) {
    throw new MaterializationValidationError(
      "Storage does not provide Action run capabilities required by this commit."
    )
  }
  await storage.actionRuns.assertMaterializationRun({
    projectId,
    actionId: input.source.actionId,
    runId: input.source.runId,
  })
}

async function replayEditCommit(
  context: MaterializerContext,
  command: PreparedEditCommit
): Promise<EditCommitResult | null> {
  const replay = await replayCommit<EditCommitResult>(context, command.identity)
  if (!replay || command.input.source.kind !== "action") return replay
  return withSerializationRetry(context, () =>
    context.storage.transaction(
      async (storage) => {
        await assertActionRun(storage, context.projectId, command.input)
        return replayCommit<EditCommitResult>(context, command.identity, storage)
      },
      { isolation: "serializable" }
    )
  )
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
  await assertActionRun(storage, context.projectId, command.input)

  const replay = await replayCommit<EditCommitResult>(context, command.identity, storage)
  if (replay) return replay

  const session = await beginEditMaterialization(context, storage, command)
  const workingState = createEditWorkingState()
  const outcomes = await applyEditOperations(
    context,
    storage.ontology.materializations,
    session,
    workingState,
    command
  )
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
    origin: command.origin,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
    intent: {
      kind: "edit",
      mode: command.input.mode,
      operationCount: command.input.operations.length,
    },
    committedAt: command.identity.committedAt,
  }
  if (command.input.actor === undefined) return commit
  return { ...commit, actor: command.input.actor }
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

function createEditWorkingState(): EditWorkingState {
  return {
    objects: new Map<string, WorkingObject>(),
    links: new Map<string, WorkingLink>(),
    scopeSnapshots: new Map<string, MaterializationLinkScopeState>(),
  }
}

async function applyEditOperations(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  command: PreparedEditCommit
): Promise<OntologyOperationOutcome[]> {
  const outcomes: OntologyOperationOutcome[] = []
  const groupByOperationId = operationGroupIndex(command.input)
  const operations = command.input.operations
  let index = 0

  while (index < operations.length) {
    const group = groupByOperationId.get(operations[index]?.id ?? "")
    const run =
      group === undefined ? 1 : groupRunLength(operations, index, group, groupByOperationId)
    if (run === 1) {
      const operation = operations[index]
      if (operation)
        outcomes.push(
          await applyOneEditOperation(context, storage, session, state, operation, command)
        )
      index += 1
      continue
    }
    outcomes.push(
      ...(await applyEditOperationGroup(
        context,
        storage,
        session,
        state,
        command,
        operations.slice(index, index + run)
      ))
    )
    index += run
  }
  return outcomes
}

async function applyOneEditOperation(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  operation: OntologyEditOperation,
  command: PreparedEditCommit
): Promise<OntologyOperationOutcome> {
  try {
    return await applyEditOperation(context, storage, session, state, operation, command.identity)
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
async function applyEditOperationGroup(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  command: PreparedEditCommit,
  group: readonly OntologyEditOperation[]
): Promise<OntologyOperationOutcome[]> {
  const journal: EditUndoJournal = []
  const applied: OntologyOperationOutcome[] = []

  for (const operation of group) {
    let outcome: OntologyOperationOutcome
    try {
      outcome = await applyEditOperation(
        context,
        storage,
        session,
        state,
        operation,
        command.identity,
        journal
      )
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

function operationGroupIndex(input: NormalizedEditCommit): ReadonlyMap<string, number> {
  const byId = new Map<string, number>()
  if (input.mode !== "continue" || input.operationGroups === undefined) return byId
  for (const [group, ids] of input.operationGroups.entries()) {
    for (const id of ids) byId.set(id, group)
  }
  return byId
}

/** Length of the contiguous run of operations at `start` that belong to `group`. */
function groupRunLength(
  operations: readonly OntologyEditOperation[],
  start: number,
  group: number,
  groupByOperationId: ReadonlyMap<string, number>
): number {
  let length = 0
  while (
    start + length < operations.length &&
    groupByOperationId.get(operations[start + length]?.id ?? "") === group
  ) {
    length += 1
  }
  return length
}

function isRecoverableEditValidation(
  input: NormalizedEditCommit,
  error: unknown
): error is MaterializationValidationError {
  if (input.mode === "atomic") return false
  return error instanceof MaterializationValidationError
}

function editPlanContext(command: PreparedEditCommit) {
  const context = { identity: command.identity, origin: command.origin }
  if (command.input.actor === undefined) return context
  return { ...context, actor: command.input.actor }
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
