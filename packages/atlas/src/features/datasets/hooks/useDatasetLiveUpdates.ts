import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import { datasetChangedKeys } from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useDatasetLiveUpdates(options: { enabled?: boolean; datasetId?: string } = {}) {
  useInvalidateOnEvent(
    events.datasets(),
    (event) => {
      if (options.datasetId && event.payload.datasetId !== options.datasetId) return []
      return datasetChangedKeys(event.payload.datasetId)
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
