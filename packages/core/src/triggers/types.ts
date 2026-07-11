/**
 * @deprecated Define a named event schedule with `defineSchedule(...).on(events.*)` instead.
 * Kept temporarily while existing sync and pipeline bindings migrate.
 */
export type RunTrigger =
  | { readonly type: "schedule"; readonly scheduleId: string }
  | { readonly type: "sync.finished"; readonly syncId: string; readonly status: "succeeded" }
  | {
      readonly type: "pipeline.finished"
      readonly pipelineId: string
      readonly status: "succeeded"
    }
  | { readonly type: "dataset.updated"; readonly datasetId: string }

/** @deprecated Internal compatibility guard for legacy run triggers. */
export function isRunTrigger(value: unknown): value is RunTrigger {
  if (!isRecord(value)) return false

  switch (value.type) {
    case "schedule":
      return typeof value.scheduleId === "string"
    case "sync.finished":
      return typeof value.syncId === "string" && value.status === "succeeded"
    case "pipeline.finished":
      return typeof value.pipelineId === "string" && value.status === "succeeded"
    case "dataset.updated":
      return typeof value.datasetId === "string"
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
