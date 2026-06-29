import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  type InvalidationKey,
  objectDetailKey,
  queryKey,
  queryKeyWithPath,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useActionLiveUpdates(
  options: { enabled?: boolean; runId?: string; actionId?: string } = {}
) {
  const enabled = options.enabled ?? true
  const builder = options.runId
    ? events.actions().run(options.runId)
    : options.actionId
      ? events.actions().action(options.actionId)
      : events.actions()

  useInvalidateOnEvent(
    builder,
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
    { enabled, debounceMs }
  )
}
