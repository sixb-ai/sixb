import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import { workflowChangedKeys } from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useWorkflowLiveUpdates(
  options: { enabled?: boolean; workflowId?: string; runId?: string } = {}
) {
  const builder = options.runId ? events.workflows().run(options.runId) : events.workflows()

  useInvalidateOnEvent(
    builder,
    (event) => {
      if (options.workflowId && event.payload.workflowId !== options.workflowId) return []

      return workflowChangedKeys(event.payload.workflowId, event.payload.runId)
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
