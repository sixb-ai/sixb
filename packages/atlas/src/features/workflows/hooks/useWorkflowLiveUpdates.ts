import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import { type InvalidationKey, queryKey, queryKeyWithPath } from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useWorkflowLiveUpdates(
  options: { enabled?: boolean; workflowId?: string; runId?: string } = {}
) {
  const builder = options.runId ? events.workflows().run(options.runId) : events.workflows()

  useInvalidateOnEvent(
    builder,
    (event) => {
      if (options.workflowId && event.payload.workflowId !== options.workflowId) return []

      const keys: InvalidationKey[] = [
        queryKey("listWorkflows"),
        queryKey("listWorkflowRuns"),
        queryKey("listWorkflowInterventions"),
        queryKeyWithPath("getWorkflow", { workflowId: event.payload.workflowId }),
        queryKeyWithPath("getWorkflowRun", { runId: event.payload.runId }),
      ]

      return keys
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
