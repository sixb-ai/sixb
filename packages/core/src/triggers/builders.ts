import { TriggerValidationError } from "./errors"
import type { RunTrigger } from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new TriggerValidationError(`Trigger ${field} must not be empty.`)
  }
}

/** Trigger that fires when a named sync run succeeds. */
export function syncFinished(syncId: string): RunTrigger {
  assertNonEmpty(syncId, "syncId")
  return { type: "sync.finished", syncId, status: "succeeded" }
}

/** Trigger that fires when a named pipeline run succeeds. */
export function pipelineFinished(pipelineId: string): RunTrigger {
  assertNonEmpty(pipelineId, "pipelineId")
  return { type: "pipeline.finished", pipelineId, status: "succeeded" }
}

/** Trigger that fires when a named dataset receives a new committed version. */
export function datasetUpdated(datasetId: string): RunTrigger {
  assertNonEmpty(datasetId, "datasetId")
  return { type: "dataset.updated", datasetId }
}
