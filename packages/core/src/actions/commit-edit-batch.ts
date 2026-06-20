import type { EditBatchInput, EditCommitDiff } from "../edits"
import { planEditBatch } from "../edits"
import type { OntologyRegistry } from "../ontology/registry"
import type { ActionRunRecord, ActionRunStorage } from "../storage/action-runs"
import { actionSubjectsEqual } from "../storage/action-runs"
import { isStorageSerializationFailure } from "../storage/errors"
import type { Storage } from "../storage/types"
import { ActionEditCommitError } from "./errors"
import type { ActionSubject } from "./types"

const EDIT_COMMIT_MAX_SERIALIZATION_ATTEMPTS = 3

export interface CommitActionEditBatchInput {
  readonly storage: Storage
  readonly projectId: string
  readonly runId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly ontology: Pick<
    OntologyRegistry,
    "resolveObjectType" | "getPrimaryPropertyId" | "getValueTypesById" | "isValidLinkTarget"
  >
  readonly batch: EditBatchInput
  readonly committedAt?: Date
  readonly idempotencyKey?: string
}

export interface ActionEditCommitResult {
  readonly diff: EditCommitDiff
  readonly committedAt: Date
  readonly created: boolean
}

export interface CommitActionEditBatchResult {
  readonly run: ActionRunRecord
  readonly commit: ActionEditCommitResult
}

/**
 * Atomically commits the local `.edits()` phase for an action run.
 *
 * This helper is the core orchestration boundary for local action writes: it validates that the
 * persisted run still matches the requested action identity, derives the EditBatch plan from the
 * current transaction state, applies object/link writes, and records the ActionRun commit trail in
 * the same storage transaction.
 *
 * The transaction requests serializable isolation because EditBatch validation is state-dependent
 * (for example cardinality-one links). Provider-classified serialization failures are retried since
 * this callback is storage-only and deterministic. `committedAt` is fixed before retrying so every
 * attempt represents the same logical commit.
 */
export async function commitActionEditBatch(
  input: CommitActionEditBatchInput
): Promise<CommitActionEditBatchResult> {
  const committedAt = input.committedAt ?? new Date()
  return commitActionEditBatchWithSerializationRetry(input, committedAt, 1)
}

async function commitActionEditBatchWithSerializationRetry(
  input: CommitActionEditBatchInput,
  committedAt: Date,
  attempt: number
): Promise<CommitActionEditBatchResult> {
  try {
    return await commitActionEditBatchOnce(input, committedAt)
  } catch (error) {
    if (!shouldRetrySerializationFailure(error, attempt)) {
      throw error
    }

    return commitActionEditBatchWithSerializationRetry(input, committedAt, attempt + 1)
  }
}

function shouldRetrySerializationFailure(error: unknown, attempt: number): boolean {
  return isStorageSerializationFailure(error) && attempt < EDIT_COMMIT_MAX_SERIALIZATION_ATTEMPTS
}

async function commitActionEditBatchOnce(
  input: CommitActionEditBatchInput,
  committedAt: Date
): Promise<CommitActionEditBatchResult> {
  return input.storage.transaction(
    async (tx) => {
      const actionRuns = requireActionRunStorage(tx, input.runId)
      const run = await actionRuns.getById({
        projectId: input.projectId,
        id: input.runId,
      })

      if (!run) {
        throw new ActionEditCommitError(
          `[Sixb] Action run '${input.runId}' not found for project '${input.projectId}'.`
        )
      }

      assertCommitRunMatchesInput(run, input)

      if (run.commit) {
        return {
          run,
          commit: {
            diff: run.commit.diff,
            committedAt: run.commit.committedAt,
            created: false,
          },
        }
      }

      if (run.status !== "running") {
        throw new ActionEditCommitError(
          `[Sixb] Action run '${input.runId}' cannot commit edits from status '${run.status}'.`
        )
      }

      const plan = await planEditBatch({
        projectId: input.projectId,
        ontology: input.ontology,
        storage: { objects: tx.objects },
        batch: input.batch,
      })

      await tx.objects.applyEditCommitPlan({
        projectId: input.projectId,
        plan,
        committedAt,
      })

      const committedRun = await actionRuns.recordCommit({
        projectId: input.projectId,
        id: input.runId,
        committedAt,
        diff: plan.diff,
      })

      return {
        run: committedRun,
        commit: {
          diff: plan.diff,
          committedAt,
          created: true,
        },
      }
    },
    { isolation: "serializable" }
  )
}

function requireActionRunStorage(storage: Storage, runId: string): ActionRunStorage {
  if (!storage.actionRuns) {
    throw new ActionEditCommitError(
      `[Sixb] Action run '${runId}' cannot commit edits without action run storage.`
    )
  }

  return storage.actionRuns
}

function assertCommitRunMatchesInput(
  run: Pick<ActionRunRecord, "actionId" | "subject" | "idempotencyKey">,
  input: Pick<CommitActionEditBatchInput, "runId" | "actionId" | "subject" | "idempotencyKey">
): void {
  if (run.actionId !== input.actionId) {
    throw new ActionEditCommitError(
      `[Sixb] Action run '${input.runId}' belongs to action '${run.actionId}', not '${input.actionId}'.`
    )
  }

  if (!actionSubjectsEqual(run.subject, input.subject)) {
    throw new ActionEditCommitError(
      `[Sixb] Action run '${input.runId}' cannot commit edits for a different subject.`
    )
  }

  if (input.idempotencyKey !== undefined && run.idempotencyKey !== input.idempotencyKey) {
    throw new ActionEditCommitError(
      `[Sixb] Action run '${input.runId}' cannot commit edits with a different idempotency key.`
    )
  }
}
