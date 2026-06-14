import { planEditBatch } from "../../edits"
import { type ActionRunStorage, actionSubjectsEqual } from "../action-runs"
import type { InMemoryObjectStorage } from "../objects"
import { EditStorageError } from "./errors"
import type { CommitEditBatchInput, EditCommitResult, EditStorage } from "./types"

export class InMemoryEditStorage implements EditStorage {
  constructor(
    private readonly objects: InMemoryObjectStorage,
    private readonly actionRuns: ActionRunStorage
  ) {}

  async commit(input: CommitEditBatchInput): Promise<EditCommitResult> {
    const existingRun = await this.actionRuns.getById({
      projectId: input.projectId,
      id: input.runId,
    })

    if (!existingRun) {
      throw new EditStorageError(
        `[Sixb] Action run '${input.runId}' not found for project '${input.projectId}'.`
      )
    }

    assertCommitRunMatchesInput(existingRun, input)

    if (existingRun.commit) {
      return {
        diff: existingRun.commit.diff,
        committedAt: existingRun.commit.committedAt,
        created: false,
      }
    }

    if (existingRun.status !== "running") {
      throw new EditStorageError(
        `[Sixb] Action run '${input.runId}' cannot commit edits from status '${existingRun.status}'.`
      )
    }

    const committedAt = new Date(input.committedAt ?? new Date())
    const snapshot = this.objects.snapshot()
    const plan = await planEditBatch({
      projectId: input.projectId,
      ontology: input.ontology,
      storage: { objects: this.objects },
      batch: input.batch,
    })

    try {
      this.objects.applyEditCommitPlan(input.projectId, plan, committedAt)
      await this.actionRuns.recordCommit({
        id: input.runId,
        projectId: input.projectId,
        committedAt,
        diff: plan.diff,
      })
    } catch (error) {
      this.objects.restore(snapshot)
      throw error
    }

    return {
      diff: plan.diff,
      committedAt,
      created: true,
    }
  }
}

function assertCommitRunMatchesInput(
  run: {
    readonly id: string
    readonly actionId: string
    readonly subject: CommitEditBatchInput["subject"]
    readonly idempotencyKey: string
  },
  input: CommitEditBatchInput
): void {
  if (run.actionId !== input.actionId) {
    throw new EditStorageError(
      `[Sixb] Action run '${input.runId}' belongs to action '${run.actionId}', not '${input.actionId}'.`
    )
  }

  if (!actionSubjectsEqual(run.subject, input.subject)) {
    throw new EditStorageError(
      `[Sixb] Action run '${input.runId}' cannot commit edits for a different subject.`
    )
  }

  if (input.idempotencyKey !== undefined && run.idempotencyKey !== input.idempotencyKey) {
    throw new EditStorageError(
      `[Sixb] Action run '${input.runId}' cannot commit edits with a different idempotency key.`
    )
  }
}
