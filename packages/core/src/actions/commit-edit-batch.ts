import type { EditBatchInput, EditCommitDiff, SerializationRetryOptions } from "../edits"
import { planEditBatch, runWithStorageSerializationRetry } from "../edits"
import { buildEditCommitPlanEvents, type EventDraft } from "../events"
import type { OntologyRegistry } from "../ontology/registry"
import type { ActionRunRecord, ActionRunStorage } from "../storage/action-runs"
import { actionSubjectsEqual } from "../storage/action-runs"
import type { Storage } from "../storage/types"
import { ActionEditCommitError } from "./errors"
import type { ActionSubject } from "./types"

export type { SerializationRetryOptions } from "../edits"

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
  /** Overrides the serialization-failure retry pacing; defaults are applied per field. */
  readonly serializationRetry?: SerializationRetryOptions
}

export interface ActionEditCommitResult {
  readonly diff: EditCommitDiff
  readonly events: readonly EventDraft[]
  readonly committedAt: Date
  readonly created: boolean
}

export interface CommitActionEditBatchResult {
  readonly run: ActionRunRecord
  readonly commit: ActionEditCommitResult
}

/**
 * Atomically commits the legacy local `.edits()` phase for an action run.
 *
 * TODO(ontology-materializer/phase-6): Remove after the Action worker routes edits through the
 * ontology Materializer and reads the authoritative ontology commit result.
 *
 * This helper is the core orchestration boundary for local action writes: it validates that the
 * persisted run still matches the requested action identity, derives the EditBatch plan from the
 * current transaction state, applies object/link writes, and records the ActionRun commit trail in
 * the same storage transaction.
 *
 * The transaction requests serializable isolation because EditBatch validation is state-dependent
 * (for example cardinality-one links). The path takes no advisory locks or fixed lock ordering;
 * concurrency correctness rests entirely on serializable isolation plus the retry below. The
 * same-run idempotency short-circuit (returning the recorded commit when `run.commit` is already
 * set) likewise relies on that isolation to resolve the read-then-write race between two commits of
 * the same run: under serializable, the loser observes a serialization failure and retries into the
 * idempotent branch instead of double-applying.
 *
 * Provider-classified serialization failures are retried since this callback is storage-only and
 * deterministic. `committedAt` is fixed before retrying so every attempt represents the same logical
 * commit. Retries use full-jitter exponential backoff (see {@link SerializationRetryOptions}) so a
 * herd of conflicting commits de-synchronizes instead of re-colliding in lock-step.
 *
 * This helper is the single retry boundary for edit commits: callers must route every edit commit
 * through it rather than calling `storage.transaction` directly, which (by design) does not retry.
 */
export async function commitActionEditBatch(
  input: CommitActionEditBatchInput
): Promise<CommitActionEditBatchResult> {
  const committedAt = input.committedAt ?? new Date()
  return runWithStorageSerializationRetry(
    () => commitActionEditBatchOnce(input, committedAt),
    input.serializationRetry
  )
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
            events: [],
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
      const domainEvents = buildEditCommitPlanEvents({
        plan,
        idempotencyKeyPrefix: `action.commit:${input.runId}`,
        origin: {
          kind: "action",
          actionId: input.actionId,
          runId: input.runId,
        },
      })

      return {
        run: committedRun,
        commit: {
          diff: plan.diff,
          events: domainEvents,
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
