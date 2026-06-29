import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  datasetChangedKeys,
  type InvalidationKey,
  queryKey,
  queryKeyWithPath,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useSyncLiveUpdates(options: { enabled?: boolean; syncId?: string } = {}) {
  useInvalidateOnEvent(
    events.syncs(),
    (event) => {
      if (options.syncId && event.payload.syncId !== options.syncId) return []

      const keys: InvalidationKey[] = [
        queryKey("listSyncs"),
        queryKey("listSyncRuns"),
        queryKeyWithPath("getSync", { syncId: event.payload.syncId }),
      ]

      if ("datasetId" in event.payload && event.payload.datasetId) {
        keys.push(...datasetChangedKeys(event.payload.datasetId))
      }

      return keys
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
