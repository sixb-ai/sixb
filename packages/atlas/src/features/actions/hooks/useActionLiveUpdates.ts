import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  type InvalidationKey,
  objectDetailKey,
  queryKey,
  queryKeyWithPath,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

/** Refresh action runs, and the objects they edited, as runs are requested and recorded. */
export function useActionLiveUpdates() {
  useInvalidateOnEvent(
    events.actions(),
    (event) => {
      const keys: InvalidationKey[] = [
        queryKey("listActionRuns"),
        queryKeyWithPath("getActionRun", { runId: event.payload.runId }),
      ]

      if (event.type !== "action.requested" && event.payload.subject.kind === "object") {
        keys.push(
          objectDetailKey(event.payload.subject.objectTypeId, event.payload.subject.primaryId)
        )
      }

      return keys
    },
    { debounceMs }
  )
}
