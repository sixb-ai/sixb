import {
  listObservedAgentThreadMessagesOptions,
  listObservedAgentThreadRunsOptions,
} from "@sixb/client/hooks"
import { Spinner } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Eye } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { type ArtifactAuthor, ArtifactPeopleContext } from "../artifacts/people"
import type { ArtifactTarget } from "../artifacts/target"
import { reportedApprovalOutcomes } from "./approvals"
import { ArtifactPanelRoot } from "./artifact-panel"
import { Transcript } from "./components/transcript"
import { conversationMessages, conversationTurn, READ_ONLY_TURN } from "./conversation"
import { useAgentMessages } from "./i18n"
import { createLiveRunState } from "./live-run"
import { authorNames, MessageAuthorsContext, messageAuthors, principalKey } from "./message-authors"
import { ObservedThreadContext } from "./observed-thread"
import { presentActiveTurn, selectActiveRunId } from "./run-presentation"
import type { AgentThread } from "./types"

/** How often an answering conversation is read again: an observer has no live stream. */
const ANSWERING_POLL_MS = 5_000

/** How often an idle conversation's thread is read again, to notice a run that starts. */
const IDLE_POLL_MS = 15_000

type ReadStatus = "pending" | "error" | "success"

/**
 * When to read an observed thread again: often while the agent answers, slowly while idle, as a
 * run can start at any time. Never once a read fails, such as after the grant is revoked.
 */
export function observedThreadPollMs(
  status: ReadStatus,
  activeRunId: string | null | undefined
): number | false {
  if (status === "error") return false
  return activeRunId ? ANSWERING_POLL_MS : IDLE_POLL_MS
}

/** When to read its messages and runs again: only while the agent answers, until a read fails. */
export function observedTranscriptPollMs(status: ReadStatus, answering: boolean): number | false {
  return answering && status !== "error" ? ANSWERING_POLL_MS : false
}

const noLiveRun = createLiveRunState(null)

export interface ObservedConversationProps {
  /** Someone else's thread, as `GET /api/observed-agent-threads/:threadId` returns it. */
  readonly thread: AgentThread
  readonly artifactTarget?: ArtifactTarget | null
  readonly onArtifactTargetChange?: (target: ArtifactTarget | null) => void
}

/**
 * Someone else's conversation, read with `can.observe(agent.threads)`: the agent's transcript and
 * artifact panel, without a composer or anything else that acts on the thread. Messages name their
 * author. A turn in progress shows once it is saved, as the observer's reads are not streamed.
 */
export function ObservedConversation({
  thread,
  artifactTarget,
  onArtifactTargetChange,
}: ObservedConversationProps) {
  const labels = useAgentMessages().observed
  const answering = thread.activeRunId !== undefined && thread.activeRunId !== null
  const refetchInterval = (query: { readonly state: { readonly status: ReadStatus } }) =>
    observedTranscriptPollMs(query.state.status, answering)

  const messagesQuery = useQuery({ ...observedMessagesOptions(thread.id), refetchInterval })
  const runsQuery = useQuery({
    ...listObservedAgentThreadRunsOptions({
      path: { threadId: thread.id },
      query: { limit: "50", order: "desc" },
    }),
    refetchInterval,
  })

  // A turn that starts has its question saved already; one that ends saved its answer after the
  // last poll. Either way, read once more.
  const wasAnswering = useRef(answering)
  useEffect(() => {
    if (wasAnswering.current !== answering) {
      void messagesQuery.refetch()
      void runsQuery.refetch()
    }
    wasAnswering.current = answering
  }, [answering, messagesQuery.refetch, runsQuery.refetch])

  const messages = useMemo(() => messagesQuery.data?.messages ?? [], [messagesQuery.data])
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data])
  const authors = useMemo(
    () => messageAuthors(authorNames(messagesQuery.data?.authors)),
    [messagesQuery.data]
  )

  // An artifact's versions name whoever of the conversation published them, when they have a name.
  const artifactPeople = useMemo(() => {
    const names = new Map(
      (messagesQuery.data?.authors ?? []).flatMap((author) =>
        author.displayName ? [[principalKey(author), author.displayName] as const] : []
      )
    )
    return (author: ArtifactAuthor) => names.get(principalKey(author))
  }, [messagesQuery.data])

  const activeRunId = selectActiveRunId({
    pendingRun: null,
    threadActiveRunId: thread.activeRunId ?? null,
    latestRun: runs[0] ?? null,
  })
  const presentation = presentActiveTurn({
    activeRunId,
    pendingRun: null,
    streamRun: null,
    live: noLiveRun,
    runs,
    messages,
    messagesLoading: messagesQuery.isLoading,
  })

  // The same conversation the reader's own chat draws, without a live reply or any action on it.
  const conversation = conversationMessages({
    messages,
    authors: messagesQuery.data?.authors,
    observed: true,
    presentation,
  })
  const turn = conversationTurn({ ...READ_ONLY_TURN, presentation, activeRunId })

  const approvalOutcomes = useMemo(() => reportedApprovalOutcomes(messages), [messages])

  let content = (
    <Transcript
      threadId={thread.id}
      messages={conversation}
      turn={turn}
      approvalOutcomes={approvalOutcomes}
    />
  )
  if (messagesQuery.isLoading) {
    content = (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    )
  } else if (messagesQuery.isError) {
    content = <Notice text={labels.loadFailed} tone="error" />
  } else if (messages.length === 0 && presentation.kind !== "responding") {
    content = <Notice text={labels.empty} />
  }

  return (
    <ObservedThreadContext.Provider value={true}>
      <MessageAuthorsContext.Provider value={authors}>
        <ArtifactPeopleContext.Provider value={artifactPeople}>
          <ArtifactPanelRoot
            scopeKey={thread.id}
            // An artifact's page is its owner's: an observer reads it here only.
            pageLinks={false}
            routeTarget={artifactTarget}
            onRouteTargetChange={onArtifactTargetChange}
          >
            <div className="flex h-full min-h-0 flex-col bg-background">
              <div className="relative flex min-h-0 flex-1 flex-col">{content}</div>

              <footer className="shrink-0 border-t border-border px-4 py-3">
                <p className="mx-auto flex w-full max-w-3xl items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <Eye aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {labels.readOnly}
                    {answering ? ` ${labels.responding}` : null}
                  </span>
                </p>
              </footer>
            </div>
          </ArtifactPanelRoot>
        </ArtifactPeopleContext.Provider>
      </MessageAuthorsContext.Provider>
    </ObservedThreadContext.Provider>
  )
}

/** Every message, oldest first, with who wrote them. */
function observedMessagesOptions(threadId: string) {
  return listObservedAgentThreadMessagesOptions({ path: { threadId }, query: { order: "asc" } })
}

/** The conversation's authors by `type:id`, with their name or else their id. */
export function useObservedAuthors(threadId: string): ReadonlyMap<string, string> {
  const { data } = useQuery(observedMessagesOptions(threadId))
  return useMemo(() => authorNames(data?.authors), [data])
}

function Notice({ text, tone }: { readonly text: string; readonly tone?: "error" }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center">
      <p
        className={
          tone === "error"
            ? "max-w-md text-sm text-destructive"
            : "max-w-md text-sm text-muted-foreground"
        }
      >
        {text}
      </p>
    </div>
  )
}
