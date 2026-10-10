import {
  cancelAgentRun,
  createAgentRunSocket,
  createAgentThread,
  createLiveRunState,
  getAgent,
  getAgentThread,
  isSixbApiError,
  type LiveRunState,
  listAgentThreadMessages,
  liveRunReducer,
  postAgentThreadMessage,
} from "@sixb/client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useReducer, useState } from "react"
import { AppState } from "react-native"
import { errorMessage } from "../format"
import { useConnectedWorkspace } from "../workspace-context"
import type { PickedFile } from "./attachments"
import { firstMessageTitle } from "./titles"
import type {
  AgentFileRef,
  AgentMessage,
  AgentRun,
  AgentRunStatus,
  AgentThread,
  NormalizedPart,
} from "./types"

/** A file uploaded for the next message, with the local copy the sent bubble shows meanwhile. */
export interface Attachment {
  readonly fileRef: AgentFileRef
  readonly file: PickedFile
}

export interface Conversation {
  readonly thread: AgentThread | null
  readonly messages: readonly AgentMessage[]
  readonly loading: boolean
  /** Why the chat could not be loaded, such as a chat that no longer exists. */
  readonly loadError: string | null
  /** The message just sent, shown until the saved transcript has it. */
  readonly pendingText: string | null
  readonly pendingFiles: readonly PickedFile[]
  /** The reply streaming in now, until its saved message arrives. */
  readonly liveParts: readonly NormalizedPart[]
  /** A run is queued or streaming. */
  readonly responding: boolean
  readonly awaitingFirstToken: boolean
  /** Why the last turn or request failed, for the person to read. */
  readonly error: string | null
  /** False when the workspace has no language model, so there is no agent to talk to. */
  readonly agentAvailable: boolean
  send(text: string, attachments?: readonly Attachment[]): Promise<boolean>
  stop(): void
  /** Load the chat again after a `loadError`. */
  reload(): void
}

/**
 * One agent thread: its saved transcript, plus the run in flight streamed from `/ws/agents`.
 * `initialThreadId` is null for a chat not started yet; the first message creates the thread.
 */
export function useConversation(initialThreadId: string | null): Conversation {
  const { client } = useConnectedWorkspace()
  const queryClient = useQueryClient()
  const [threadId, setThreadId] = useState(initialThreadId)
  const [pendingRun, setPendingRun] = useState<AgentRun | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<readonly PickedFile[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, dispatch] = useReducer(liveRunReducer, null, () => createLiveRunState())

  const agent = useQuery({
    queryKey: ["agent"],
    queryFn: async () => (await getAgent({ client, throwOnError: true })).data,
    retry: false,
  })

  const thread = useQuery({
    queryKey: ["thread", threadId],
    enabled: threadId !== null,
    queryFn: async () =>
      (await getAgentThread({ client, path: { threadId: threadId ?? "" }, throwOnError: true }))
        .data,
  })

  const messages = useQuery({
    queryKey: ["messages", threadId],
    enabled: threadId !== null,
    queryFn: async () =>
      (
        await listAgentThreadMessages({
          client,
          path: { threadId: threadId ?? "" },
          query: { order: "asc" },
          throwOnError: true,
        })
      ).data.messages,
  })

  const refresh = useCallback(
    async (id: string) => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["thread", id] }),
        queryClient.refetchQueries({ queryKey: ["messages", id] }),
      ])
      void queryClient.invalidateQueries({ queryKey: ["threads"] })
    },
    [queryClient]
  )

  // Follow the run this screen started, else whichever run the thread says is active.
  const followRunId = pendingRun?.id ?? thread.data?.activeRunId ?? null
  // The stream reports the end before the refetched thread stops naming the run as active.
  const runSettled = live.runId === followRunId && live.finishStatus !== null
  const responding = sending || (followRunId !== null && !runSettled)

  useEffect(() => {
    if (!followRunId || !threadId) return
    dispatch({ type: "reset", runId: followRunId })
    // A resubscribe after the stream trimmed our cursor replays the run from its start.
    const seen = new Set<string>()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      void refresh(threadId).finally(() => setPendingRun(null))
    }

    const socket = createAgentRunSocket({
      runId: followRunId,
      client,
      onEvent: (event, cursor) => {
        if (seen.has(cursor)) return
        seen.add(cursor)
        dispatch({ type: "event", event })
        if (event.type === "agent.message.finalized") {
          void queryClient.refetchQueries({ queryKey: ["messages", threadId] })
        }
        if (event.type === "agent.run.finished") finish()
      },
      onRunSnapshot: (run) => {
        if (isFinished(run.status)) finish()
      },
      onError: (message) => dispatch({ type: "stream-error", message }),
    })
    return () => socket.close()
  }, [client, followRunId, queryClient, refresh, threadId])

  // iOS drops sockets in the background; catch up on whatever finished meanwhile.
  useEffect(() => {
    if (!threadId) return
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh(threadId)
    })
    return () => subscription.remove()
  }, [refresh, threadId])

  const send = useCallback(
    async (text: string, attachments: readonly Attachment[] = []) => {
      const trimmed = text.trim()
      if (!trimmed || responding) return false
      setError(null)
      setSending(true)
      setPendingText(trimmed)
      setPendingFiles(attachments.map((attachment) => attachment.file))
      let id = threadId
      let created = false
      try {
        if (!id) {
          const thread = await createAgentThread({
            client,
            body: { title: firstMessageTitle(trimmed) },
            throwOnError: true,
          })
          id = thread.data.thread.id
          created = true
        }
        const posted = await postAgentThreadMessage({
          client,
          path: { threadId: id },
          body: {
            text: trimmed,
            ...(attachments.length === 0
              ? {}
              : { attachments: attachments.map((attachment) => attachment.fileRef) }),
          },
          throwOnError: true,
        })
        setPendingRun(posted.data.run)
        void queryClient.invalidateQueries({ queryKey: ["threads"] })
        return true
      } catch (cause) {
        setPendingText(null)
        setError(errorMessage(cause))
        return false
      } finally {
        // Adopt a new thread only now, in the same render as its run: loading its transcript any
        // earlier could show the sent message twice, once saved and once still pending.
        if (created && id) setThreadId(id)
        setSending(false)
      }
    },
    [client, queryClient, responding, threadId]
  )

  const stop = useCallback(() => {
    if (!threadId || !followRunId || runSettled) return
    cancelAgentRun({
      client,
      path: { threadId },
      body: { runId: followRunId },
      throwOnError: true,
    }).catch((cause: unknown) => setError(errorMessage(cause)))
  }, [client, followRunId, runSettled, threadId])

  const saved = messages.data ?? []
  const savedIds = new Set(saved.map((message) => message.id))
  // Until the post returns there is no message id to wait for; after the run settles, the refetched
  // transcript already holds the message.
  const triggerSaved = pendingRun ? savedIds.has(pendingRun.triggerMessageId) : !sending
  const liveSaved = live.finalizedMessageId !== null && savedIds.has(live.finalizedMessageId)

  return {
    thread: thread.data ?? null,
    messages: saved,
    // Only while there is nothing to show: a thread this screen just started has its turn on screen.
    loading: threadId !== null && messages.isPending && pendingRun === null && !sending,
    loadError: loadErrorMessage(thread.error ?? messages.error),
    pendingText: pendingText && !triggerSaved ? pendingText : null,
    pendingFiles: pendingText && !triggerSaved ? pendingFiles : [],
    liveParts: live.runId && !liveSaved ? live.parts : [],
    responding,
    awaitingFirstToken: responding && !liveSaved && noVisibleParts(live),
    error: error ?? runError(live.finishStatus, live.finishError?.message, live.streamError),
    agentAvailable: !(isSixbApiError(agent.error) && agent.error.status === 404),
    send,
    stop,
    reload: () => {
      if (threadId) void refresh(threadId)
    },
  }
}

function loadErrorMessage(cause: unknown): string | null {
  if (!cause) return null
  if (isSixbApiError(cause) && cause.status === 404) return "This chat is no longer available."
  return `Couldn't load this chat. ${errorMessage(cause)}`
}

// Reasoning stays hidden, so a reply that has only reasoning so far still reads as thinking.
function noVisibleParts(live: LiveRunState): boolean {
  return live.parts.every((part) => part.kind === "reasoning")
}

function runError(
  status: AgentRunStatus | null,
  failure: string | undefined,
  streamError: string | null
): string | null {
  if (status === "failed") return failure ?? streamError ?? "The agent couldn't finish this reply."
  return null
}

function isFinished(status: AgentRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled"
}
