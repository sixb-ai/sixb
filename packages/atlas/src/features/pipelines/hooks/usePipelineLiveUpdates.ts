import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  datasetChangedKeys,
  type InvalidationKey,
  queryKey,
  queryKeyWithPath,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function usePipelineLiveUpdates(
  options: { enabled?: boolean; pipelineId?: string; runId?: string } = {}
) {
  const builder = options.runId ? events.pipelines().run(options.runId) : events.pipelines()

  useInvalidateOnEvent(
    builder,
    (event) => {
      if (options.pipelineId && event.payload.pipelineId !== options.pipelineId) return []

      const keys: InvalidationKey[] = [
        queryKey("listPipelines"),
        queryKey("listPipelineRuns"),
        queryKeyWithPath("getPipeline", { pipelineId: event.payload.pipelineId }),
        queryKeyWithPath("getPipelineRun", { runId: event.payload.runId }),
      ]

      if ("datasetId" in event.payload && event.payload.datasetId) {
        keys.push(...datasetChangedKeys(event.payload.datasetId))
      }

      return keys
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
