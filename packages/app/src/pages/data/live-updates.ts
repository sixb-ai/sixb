import { events, useInvalidateOnEvent } from "@sixb/client/hooks"

// Query keys follow the generated client's shape: `[{ _id, path?, query? }]`. Invalidating with a
// partial key refreshes every query that matches it.
type InvalidationKey = readonly unknown[]
const key = (id: string, path?: Record<string, unknown>): InvalidationKey =>
  path ? [{ _id: id, path }] : [{ _id: id }]

function datasetChangedKeys(datasetId: string): InvalidationKey[] {
  return [
    key("listDatasets"),
    key("getDataset", { datasetId }),
    key("listDatasetVersions", { datasetId }),
    key("listDatasetRows", { datasetId }),
  ]
}

const debounceMs = 100

/** Refreshes sync lists and runs as their events arrive. */
export function useSyncLiveUpdates(options: { syncId?: string } = {}) {
  useInvalidateOnEvent(
    events.syncs(),
    (event) => {
      if (options.syncId && event.payload.syncId !== options.syncId) return []
      const keys = [
        key("listSyncs"),
        key("listSyncRuns"),
        key("getSync", { syncId: event.payload.syncId }),
      ]
      if ("datasetId" in event.payload && event.payload.datasetId) {
        keys.push(...datasetChangedKeys(event.payload.datasetId))
      }
      return keys
    },
    { debounceMs }
  )
}

/** Refreshes pipeline lists and runs as their events arrive. */
export function usePipelineLiveUpdates(options: { pipelineId?: string } = {}) {
  useInvalidateOnEvent(
    events.pipelines(),
    (event) => {
      if (options.pipelineId && event.payload.pipelineId !== options.pipelineId) return []
      const keys = [
        key("listPipelines"),
        key("listPipelineRuns"),
        key("getPipeline", { pipelineId: event.payload.pipelineId }),
        key("getPipelineRun", { runId: event.payload.runId }),
      ]
      if ("datasetId" in event.payload && event.payload.datasetId) {
        keys.push(...datasetChangedKeys(event.payload.datasetId))
      }
      return keys
    },
    { debounceMs }
  )
}

/** Refreshes dataset lists, versions and rows as new versions commit. */
export function useDatasetLiveUpdates(options: { datasetId?: string } = {}) {
  useInvalidateOnEvent(
    events.datasets(),
    (event) => {
      if (options.datasetId && event.payload.datasetId !== options.datasetId) return []
      return datasetChangedKeys(event.payload.datasetId)
    },
    { debounceMs }
  )
}
