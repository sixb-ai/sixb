import {
  getAgentRunQueryKey,
  getAgentThreadQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadsQueryKey,
  useAgentRunStream,
} from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useReducer, useRef } from "react"
import { createLiveRunState, type LiveRunState, liveRunReducer } from "./liveRun"

export interface UseThreadStreamOptions {
  readonly threadId: string | null
  readonly runId: string | null
}

export interface UseThreadStreamResult {
  readonly live: LiveRunState
  readonly connected: boolean
  readonly reconnecting: boolean
}

/**
 * Subscribe to a thread's active run and fold its stream into a live assistant row.
 *
 * Durable state stays the source of truth: when the worker finalizes the message we refetch
 * messages, and when the run finishes we refetch the run/thread/list. The live row is only a
 * transient view of `/ws/agents` until durable data catches up.
 */
export function useThreadStream(options: UseThreadStreamOptions): UseThreadStreamResult {
  const { threadId, runId } = options
  const queryClient = useQueryClient()
  const [live, dispatch] = useReducer(liveRunReducer, runId, createLiveRunState)

  // Reset the accumulator whenever we point at a different run so a new turn starts clean.
  useEffect(() => {
    dispatch({ type: "reset", runId })
  }, [runId])

  const { connected, reconnecting } = useAgentRunStream({
    runId,
    threadId,
    enabled: Boolean(runId && threadId),
    onEvent: (event) => dispatch({ type: "event", event }),
    onError: (message) => dispatch({ type: "stream-error", message }),
  })

  // Reload durable messages once the assistant message is persisted.
  const finalizedHandledRef = useRef<string | null>(null)
  useEffect(() => {
    const messageId = live.finalizedMessageId
    if (!messageId || !threadId || finalizedHandledRef.current === messageId) return
    finalizedHandledRef.current = messageId
    void queryClient.invalidateQueries({
      queryKey: listAgentThreadMessagesQueryKey({ path: { threadId } }),
    })
  }, [live.finalizedMessageId, threadId, queryClient])

  // Refresh run/thread state once the run reaches a terminal status.
  const finishHandledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!live.finishStatus || !runId || finishHandledRef.current === runId) return
    finishHandledRef.current = runId
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: getAgentRunQueryKey({ path: { runId } }) }),
      queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() }),
      ...(threadId
        ? [
            queryClient.invalidateQueries({
              queryKey: getAgentThreadQueryKey({ path: { threadId } }),
            }),
            queryClient.invalidateQueries({
              queryKey: listAgentThreadMessagesQueryKey({ path: { threadId } }),
            }),
          ]
        : []),
    ])
  }, [live.finishStatus, runId, threadId, queryClient])

  return { live, connected, reconnecting }
}
