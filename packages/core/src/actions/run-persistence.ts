import { randomUUID } from "node:crypto"
import type { ActionRunParams, ActionRunRecord, CreateExecutionInput, Storage } from "../storage"
import { ActionRunError } from "../storage"
import { actionRunRequestsEqual } from "../storage/action-runs/idempotency"
import type { ExecutionRecord } from "../storage/executions"
import type { PendingActionRun } from "./run/types"
import { createActionRunIdempotencyKey } from "./run-id"
import type { ActionSubject } from "./types"

/** What a request asks its run id to run. */
export interface ActionRunRequestPayload {
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
}

/** A run that already exists under a requested run id, recorded or still executing. */
export type ExistingActionRun = Pick<
  ActionRunRecord,
  "id" | "executionId" | "actionId" | "subject" | "params"
>

/** Refuses an existing run the requesting caller may not have. */
export type AssertCanReuseActionRun = (run: ExistingActionRun) => void | Promise<void>

/**
 * Answer a request with the run that already exists under its run id only when its caller may have
 * that run, and only for the same request.
 *
 * The caller's right to the run is checked first, so that a refused caller learns nothing about it,
 * not even whether it carries the same request.
 */
export async function assertCanReuseActionRun(
  run: ExistingActionRun,
  request: {
    readonly payload: ActionRunRequestPayload
    readonly assertCanReuse: AssertCanReuseActionRun
  }
): Promise<void> {
  await request.assertCanReuse(run)
  if (!actionRunRequestsEqual(run, request.payload)) {
    throw new ActionRunError(
      `[Sixb] Action run '${run.id}' already exists with a different request payload.`
    )
  }
}

interface PersistActionRunInput {
  readonly projectId: string
  readonly storage: Storage
  readonly runId: string
  readonly payload: ActionRunRequestPayload
  readonly createExecution: (executionId: string, runId: string) => Promise<CreateExecutionInput>
  readonly assertCanReuse: AssertCanReuseActionRun
  /** Checks that hold only for a run this call creates; a replayed run keeps its accepted params. */
  readonly assertNewRun?: () => Promise<void>
}

/** A run this request is to execute, or the record of an earlier request with the same run id. */
export type PersistedActionRun =
  | {
      readonly kind: "new"
      readonly run: PendingActionRun
      readonly execution: ExecutionRecord
    }
  | { readonly kind: "recorded"; readonly run: ActionRunRecord }

/**
 * Persist what a requested run needs before it executes: the durable execution it runs under.
 *
 * Nothing else is stored before the run ends. A run id that is already recorded must carry the same
 * request, and its record answers this request without running anything.
 */
export async function persistActionRun(input: PersistActionRunInput): Promise<PersistedActionRun> {
  const { projectId, runId, payload } = input
  if (!input.storage.actionRuns) {
    throw new ActionRunError("[Sixb] Action run storage is not configured.")
  }

  const recorded = await input.storage.actionRuns.getById({ projectId, id: runId })
  if (recorded) {
    await assertCanReuseActionRun(recorded, input)
    return { kind: "recorded", run: recorded }
  }

  await input.assertNewRun?.()
  // The execution is immutable provenance, created before the run executes: its record references
  // it, and so do the commit of its edits and the model calls it makes.
  const execution = await input.storage.executions.create(
    await input.createExecution(`exec_${randomUUID()}`, runId)
  )
  return {
    kind: "new",
    run: {
      id: runId,
      projectId,
      executionId: execution.id,
      actionId: payload.actionId,
      subject: payload.subject,
      params: payload.params,
      idempotencyKey: createActionRunIdempotencyKey(projectId, runId),
    },
    execution,
  }
}
