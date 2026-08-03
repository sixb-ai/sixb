import type { AgentRunSnapshot } from "@sixb/client"
import {
  getAgentRunQueryKey,
  getAgentThreadQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
  listAgentThreadsQueryKey,
  useAgentRunStream,
} from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useReducer, useRef, useState } from "react"
import { createLiveRunState, type LiveRunState, liveRunReducer } from "../liveRun"

export interface UseThreadStreamOptions {
  readonly threadId: string | null
  readonly runId: string | null
}

export interface UseThreadStreamResult {
  readonly live: LiveRunState
  /** Latest durable snapshot received for this subscription. */
  readonly run: AgentRunSnapshot | null
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
  const [run, setRun] = useState<AgentRunSnapshot | null>(null)

  // Reset the accumulator whenever we point at a different run so a new turn starts clean.
  useEffect(() => {
    dispatch({ type: "reset", runId })
    setRun(null)
  }, [runId])

  // Once the run reaches a terminal status we already have all of its events; stop the subscription
  // so a server-closed socket does not reconnect on a loop to a run that is already over.
  const snapshotFinished =
    run?.id === runId &&
    (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")
  const runFinished = snapshotFinished || (live.finishStatus !== null && live.runId === runId)
  const { connected, reconnecting } = useAgentRunStream({
    runId,
    enabled: Boolean(runId && threadId) && !runFinished,
    onEvent: (event) => dispatch({ type: "event", event }),
    onRunSnapshot: setRun,
    // `streamError` is display text, and its other source is an AI SDK error chunk that has no
    // code, so the failure is flattened to its message here rather than widened across both.
    onError: (failure) => dispatch({ type: "stream-error", message: failure.message }),
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
            queryClient.invalidateQueries({
              queryKey: listAgentThreadRunsQueryKey({ path: { threadId } }),
            }),
          ]
        : []),
    ])
  }, [live.finishStatus, runId, threadId, queryClient])

  // A durable terminal snapshot is authoritative even if the retained terminal event was pruned or
  // arrived before this hook mounted. Refresh every durable view from it just as we do for events.
  const snapshotHandledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!snapshotFinished || !runId || snapshotHandledRef.current === runId) return
    snapshotHandledRef.current = runId
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
            queryClient.invalidateQueries({
              queryKey: listAgentThreadRunsQueryKey({ path: { threadId } }),
            }),
          ]
        : []),
    ])
  }, [snapshotFinished, runId, threadId, queryClient])

  return { live, run: run?.id === runId ? run : null, connected, reconnecting }
}
