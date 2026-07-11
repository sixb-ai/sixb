import { TriggerValidationError } from "./errors"
import type { RunTrigger } from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new TriggerValidationError(`Trigger ${field} must not be empty.`)
}

/** @deprecated Use `defineSchedule(id).on(events.sync(sync).succeeded())`. */
export function syncFinished(syncId: string): RunTrigger {
  assertNonEmpty(syncId, "syncId")
  return { type: "sync.finished", syncId, status: "succeeded" }
}

/** @deprecated Use `defineSchedule(id).on(events.pipeline(pipeline).succeeded())`. */
export function pipelineFinished(pipelineId: string): RunTrigger {
  assertNonEmpty(pipelineId, "pipelineId")
  return { type: "pipeline.finished", pipelineId, status: "succeeded" }
}

/** @deprecated Use `defineSchedule(id).on(events.dataset(dataset).updated())`. */
export function datasetUpdated(datasetId: string): RunTrigger {
  assertNonEmpty(datasetId, "datasetId")
  return { type: "dataset.updated", datasetId }
}
