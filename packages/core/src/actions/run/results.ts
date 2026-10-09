import { createSixbError } from "../../errors/internal"
import type { ActionRunFailure, ActionRunRecord } from "../../storage"
import type { ActionRunResult } from "./types"

export function requireFinishedAt(input: {
  readonly actionId: string
  readonly runId: string
  readonly finishedAt: Date | undefined
}): Date {
  if (input.finishedAt) {
    return input.finishedAt
  }

  throw createSixbError(
    "internal.unexpected",
    `[Sixb] Action run '${input.runId}' finished without a finishedAt timestamp.`,
    { details: { actionId: input.actionId, runId: input.runId } }
  )
}

export function failedResult(
  runId: string,
  actionId: string,
  run: ActionRunRecord,
  failure: ActionRunFailure
): ActionRunResult {
  return {
    id: runId,
    actionId,
    subject: run.subject,
    status: "failed",
    startedAt: run.startedAt ?? run.queuedAt,
    finishedAt: requireFinishedAt({ actionId, runId, finishedAt: run.finishedAt }),
    error: failure,
    record: run,
  }
}
