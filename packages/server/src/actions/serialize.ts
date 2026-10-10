import type { ActionRunRecord } from "@sixb/core/storage"
import { ActionRunDetailSchema, ActionRunSummarySchema } from "../schemas/actions"
import { toIsoString } from "../utils/http"

/** The run summary run listings answer with. */
export function serializeActionRunSummary(
  run: ActionRunRecord
): ReturnType<typeof ActionRunSummarySchema.parse> {
  return ActionRunSummarySchema.parse({
    id: run.id,
    projectId: run.projectId,
    actionId: run.actionId,
    subject: run.subject,
    status: run.status,
    phase: run.phase,
    queuedAt: toIsoString(run.queuedAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    error: run.error,
  })
}

/** The run detail every route that returns one run answers with. */
export function serializeActionRunDetail(
  run: ActionRunRecord
): ReturnType<typeof ActionRunDetailSchema.parse> {
  return ActionRunDetailSchema.parse({
    ...serializeActionRunSummary(run),
    params: run.params,
    writeback: run.writeback
      ? run.writeback.status === "succeeded"
        ? {
            status: "succeeded",
            completedAt: toIsoString(run.writeback.completedAt),
            result: run.writeback.result,
          }
        : {
            status: "failed",
            completedAt: toIsoString(run.writeback.completedAt),
            error: run.writeback.error,
          }
      : undefined,
    effects: run.effects
      ? run.effects.status === "succeeded"
        ? {
            status: "succeeded",
            completedAt: toIsoString(run.effects.completedAt),
          }
        : {
            status: "failed",
            completedAt: toIsoString(run.effects.completedAt),
            error: run.effects.error,
          }
      : undefined,
  })
}
