import { events, useInvalidateOnEvent } from "@sixb/client/hooks"

// Query keys follow the generated client's shape, `[{ _id, path? }]`; a partial key refreshes every
// query that matches it, the paged run list's included.
const key = (id: string, path?: Record<string, unknown>): readonly unknown[] =>
  path ? [{ _id: id, path }] : [{ _id: id }]

/** Refreshes workflow run lists and runs as their events arrive; `runId` narrows it to one run. */
export function useWorkflowRunLiveUpdates(runId?: string) {
  useInvalidateOnEvent(
    runId ? events.workflows().run(runId) : events.workflows(),
    (event) => [
      key("listWorkflowRuns"),
      key("getWorkflowAgentNodeExecution"),
      key("getWorkflowRun", { runId: event.payload.runId }),
    ],
    { debounceMs: 100 }
  )
}
