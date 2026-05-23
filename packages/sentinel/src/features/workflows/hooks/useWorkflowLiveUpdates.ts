import { useSixbEvents } from "@sixb/client"
import {
  getWorkflowQueryKey,
  getWorkflowRunQueryKey,
  listWorkflowRunsInfiniteQueryKey,
  listWorkflowRunsQueryKey,
  listWorkflowsQueryKey,
} from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"

const workflowEventTypes = [
  "workflow.run.queued",
  "workflow.run.started",
  "workflow.run.node.started",
  "workflow.run.node.finished",
  "workflow.run.finished",
] as const

const invalidationDelayMs = 100

export function useWorkflowLiveUpdates() {
  const queryClient = useQueryClient()
  const workflowIdsRef = useRef(new Set<string>())
  const runIdsRef = useRef(new Set<string>())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const workflowIds = Array.from(workflowIdsRef.current)
    const runIds = Array.from(runIdsRef.current)
    workflowIdsRef.current.clear()
    runIdsRef.current.clear()

    void Promise.all([
      queryClient.invalidateQueries({ queryKey: listWorkflowsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listWorkflowRunsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listWorkflowRunsInfiniteQueryKey() }),
      ...workflowIds.map((workflowId) =>
        queryClient.invalidateQueries({
          queryKey: getWorkflowQueryKey({ path: { workflowId } }),
        })
      ),
      ...runIds.map((runId) =>
        queryClient.invalidateQueries({
          queryKey: getWorkflowRunQueryKey({ path: { runId } }),
        })
      ),
    ])
  }

  const scheduleFlush = () => {
    if (timerRef.current) return
    timerRef.current = setTimeout(flush, invalidationDelayMs)
  }

  useSixbEvents({
    topic: "workflows",
    types: workflowEventTypes,
    onEvent(event) {
      workflowIdsRef.current.add(event.payload.workflowId)
      runIdsRef.current.add(event.payload.runId)
      scheduleFlush()
    },
  })

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])
}
