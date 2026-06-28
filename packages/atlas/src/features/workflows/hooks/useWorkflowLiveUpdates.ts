import {
  events,
  getWorkflowQueryKey,
  getWorkflowRunQueryKey,
  listWorkflowRunsInfiniteQueryKey,
  listWorkflowRunsQueryKey,
  listWorkflowsQueryKey,
  useInvalidateOnEvent,
} from "@sixb/client/hooks"

export function useWorkflowLiveUpdates() {
  useInvalidateOnEvent(
    events.workflows(),
    (event) => [
      listWorkflowsQueryKey(),
      listWorkflowRunsQueryKey(),
      listWorkflowRunsInfiniteQueryKey(),
      getWorkflowQueryKey({ path: { workflowId: event.payload.workflowId } }),
      getWorkflowRunQueryKey({ path: { runId: event.payload.runId } }),
    ],
    { debounceMs: 100 }
  )
}
