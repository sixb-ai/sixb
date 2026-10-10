import { randomUUID } from "node:crypto"
import { createSixbError } from "../errors/internal"
import type { ActionRunParams, ActionRunRecord, CreateExecutionInput, Storage } from "../storage"
import { ActionRunError, isTerminalActionRun } from "../storage"
import { actionRunParamsEqual, actionSubjectsEqual } from "../storage/action-runs/idempotency"
import type { ExecutionRecord } from "../storage/executions"
import { createActionRunId, createActionRunIdempotencyKey } from "./run-id"
import type { ActionSubject } from "./types"

interface PersistActionRunInput {
  readonly projectId: string
  readonly storage: Storage
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  readonly runId?: string
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
  /** Runs before payload comparison so an existing run cannot cross authority owners. */
  readonly assertCanReuseExisting?: (storage: Storage, run: ActionRunRecord) => void | Promise<void>
  /** Checks that hold only for a run this call creates; a replayed run keeps its accepted params. */
  readonly assertNewRun?: () => Promise<void>
}

/** A run this request created, or the outcome of an earlier request with the same run id. */
export type PersistedActionRun =
  | {
      readonly kind: "created"
      readonly run: ActionRunRecord
      readonly execution: ExecutionRecord
    }
  | { readonly kind: "finished"; readonly run: ActionRunRecord }

/**
 * Persist an Action run with the durable execution it runs under, idempotently by run id.
 *
 * Both are written in one serializable transaction. A run id that already exists must carry the
 * same request: its terminal record answers this request without running anything, and while it
 * is still executing the request is refused as in progress.
 */
export async function persistActionRun(input: PersistActionRunInput): Promise<PersistedActionRun> {
  const runId = createActionRunId(input.runId)
  const actionRuns = requireActionRunStorage(input.storage)

  const existing = await actionRuns.getById({ projectId: input.projectId, id: runId })
  if (existing) return reuseActionRun(input, input.storage, existing)

  await input.assertNewRun?.()
  const execution = await input.createExecution(`exec_${randomUUID()}`, runId)
  try {
    return await input.storage.transaction(
      async (tx): Promise<PersistedActionRun> => {
        const transactionalRuns = requireActionRunStorage(tx)
        const raced = await transactionalRuns.getById({ projectId: input.projectId, id: runId })
        if (raced) return reuseActionRun(input, tx, raced)

        const created = await tx.executions.create(execution)
        const run = await transactionalRuns.queue({
          projectId: input.projectId,
          id: runId,
          executionId: created.id,
          actionId: input.actionId,
          subject: input.subject,
          params: input.params,
          idempotencyKey: createActionRunIdempotencyKey(input.projectId, runId),
          queuedAt: new Date(),
        })
        return { kind: "created", run, execution: created }
      },
      { isolation: "serializable" }
    )
  } catch (error) {
    // A concurrent request for the same run id won the insert.
    if (!(error instanceof ActionRunError)) throw error
    const raced = await actionRuns.getById({ projectId: input.projectId, id: runId })
    if (!raced) throw error
    return reuseActionRun(input, input.storage, raced)
  }
}

async function reuseActionRun(
  input: PersistActionRunInput,
  storage: Storage,
  existing: ActionRunRecord
): Promise<PersistedActionRun> {
  await input.assertCanReuseExisting?.(storage, existing)
  assertExistingRunMatchesRequest(existing, input)
  if (!isTerminalActionRun(existing)) {
    throw createSixbError(
      "action.run_in_progress",
      `[Sixb] Action run '${existing.id}' is already in progress.`,
      { details: { actionId: existing.actionId, runId: existing.id } }
    )
  }
  return { kind: "finished", run: existing }
}

function requireActionRunStorage(storage: Storage): NonNullable<Storage["actionRuns"]> {
  if (!storage.actionRuns) {
    throw new ActionRunError("[Sixb] Action run storage is not configured.")
  }
  return storage.actionRuns
}

function assertExistingRunMatchesRequest(
  existing: ActionRunRecord,
  request: Pick<PersistActionRunInput, "actionId" | "subject" | "params">
): void {
  if (
    existing.actionId !== request.actionId ||
    !actionSubjectsEqual(existing.subject, request.subject) ||
    !actionRunParamsEqual(existing.params, request.params)
  ) {
    throw new ActionRunError(
      `[Sixb] Action run '${existing.id}' already exists with a different request payload.`
    )
  }
}
