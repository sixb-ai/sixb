/**
 * Declarative trigger that can request a sync or pipeline run.
 *
 * Multiple triggers on the same definition use OR semantics: any matching
 * trigger can request a run independently.
 *
 * The `status` field on `sync.finished` and `pipeline.finished` is currently
 * limited to `"succeeded"`. Future versions may extend this to `"failed"` or
 * `"any"` to support error-driven workflows.
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

/** Runtime type guard for values discovered as triggers. */
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
