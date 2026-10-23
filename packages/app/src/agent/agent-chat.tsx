import { Button, EmptyState, Toaster } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import { type ReactNode, useId } from "react"
import { ArtifactPeopleContext } from "../artifacts/people"
import type { ArtifactTarget } from "../artifacts/target"
import { ArtifactPanelRoot } from "./artifact-panel"
import { ConversationPanel } from "./components/conversation-panel"
import { SandboxRecovery } from "./components/sandbox-recovery"
import { SharedThreadNotice } from "./components/shared-thread-notice"
import { ThreadArtifactsMenu } from "./components/thread-artifacts-menu"
import { ThreadPeople } from "./components/thread-people"
import { useAgentConversation } from "./hooks/use-agent-conversation"
import { useThreadSharing } from "./hooks/use-thread-sharing"
import { useAgentMessages } from "./i18n"
import {
  type MessageAuthor,
  MessageAuthorsContext,
  principalKey,
  useConversationAuthors,
} from "./message-authors"
import { offersContinue } from "./run-presentation"
import { personName, threadOwner, threadParticipants } from "./sharing"
import type { AgentContextInput, AgentThread } from "./types"

export interface AgentChatProps {
  readonly threadId?: string | null
  readonly onNavigateHome: () => void
  readonly onNavigateThread: (threadId: string) => void
  readonly className?: string
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
  /** Centered content for an empty conversation. Omit for the agent identity; null hides it. */
  readonly welcomeContent?: ReactNode
  /** Portal host for a modeless compact artifact canvas. */
  readonly artifactHost?: HTMLElement | null
  /** Keep artifacts beside compact chat on desktop instead of opening a modal. */
  readonly splitArtifacts?: boolean
  /** The open artifact when the host keeps it in its route; files stay local. */
  readonly artifactTarget?: ArtifactTarget | null
  readonly onArtifactTargetChange?: (target: ArtifactTarget | null) => void
  readonly conversationHeaderActions?: ReactNode
  readonly composerPlaceholder?: string
}

/** Route-independent conversation view; routing and embedded panels only adapt its callbacks. */
export function AgentChat({
  threadId: threadIdInput = null,
  onNavigateHome,
  onNavigateThread,
  className,
  ambientContext = [],
  compact = false,
  welcomeContent,
  artifactHost,
  splitArtifacts = false,
  artifactTarget,
  onArtifactTargetChange,
  conversationHeaderActions: hostHeaderActions,
  composerPlaceholder,
}: AgentChatProps) {
  const messages = useAgentMessages()
  const threadId = threadIdInput ?? null
  const conversation = useAgentConversation({
    threadId,
    onThreadCreated: onNavigateThread,
  })
  // Each chat has its own toaster, so a toast shows once however many chats are mounted.
  const toasterId = useId()
  const sharing = useThreadSharing({
    thread: conversation.currentThread,
    onForked: onNavigateThread,
    onLeft: onNavigateHome,
    toasterId,
  })
  const authors = useConversationAuthors({
    thread: conversation.currentThread,
    authors: conversation.authors,
    user: conversation.user,
    you: messages.sharing.you,
  })
  const pendingUser = conversation.pendingUser
  const presentation = conversation.presentation
  const currentThread = conversation.currentThread
  const owner = currentThread ? personName(threadOwner(currentThread)) : ""

  // Someone else's answer holds a shared thread: the reader keeps typing, and sends once it ends.
  const answeringFor = conversation.answeringFor
  const answeringName = answeringFor
    ? personNameOf(answeringFor, currentThread, conversation.authors)
    : null

  // Sharing needs someone signed in: without auth, the project owns every conversation.
  const sharingThread = conversation.user ? currentThread : null
  const participant = sharingThread !== null && conversation.access === "participant"

  // A turn that never answered can run again, by whoever asked for it, once the sandbox works.
  const canRetry =
    !conversation.sandboxRecovery &&
    (presentation.kind === "failed" ||
      ((presentation.kind === "timeout" || presentation.kind === "interrupted") &&
        !presentation.hasProgress)) &&
    conversation.canRetry(presentation.run)

  const listedThreads = [...conversation.threads, ...conversation.sharedThreads]
  const runningThreadCount =
    listedThreads.filter((entry) => entry.activeRunId !== null).length +
    (threadId &&
    conversation.isRunning &&
    !listedThreads.some((entry) => entry.id === threadId && entry.activeRunId !== null)
      ? 1
      : 0)

  const conversationHeaderActions =
    threadId || hostHeaderActions ? (
      <>
        {threadId ? <ThreadArtifactsMenu threadId={threadId} /> : null}
        {sharingThread ? (
          <ThreadPeople
            thread={sharingThread}
            access={conversation.access}
            user={conversation.user}
            sharing={sharing}
          />
        ) : null}
        {hostHeaderActions}
      </>
    ) : null

  let content: ReactNode
  let controlsInConversationHeader = false
  if (conversation.agentLoading) {
    content = <div className="h-full" aria-busy="true" />
  } else if (conversation.agentError) {
    content = (
      <ErrorState
        title={messages.chat.agentUnavailable}
        description={messages.chat.agentLoadFailed}
      />
    )
  } else if (!conversation.currentAgent) {
    content = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<MessagesSquare className="size-12 stroke-1" />}
          title={messages.chat.agentUnavailable}
          description={messages.chat.agentNotConfigured}
        />
      </div>
    )
  } else if (conversation.threadUnavailable) {
    content = (
      <ErrorState
        title={messages.chat.conversationUnavailable}
        description={
          conversation.removedFromThread ? messages.chat.removed : messages.chat.conversationGone
        }
      >
        <Button variant="outline" onClick={onNavigateHome}>
          {messages.threads.new}
        </Button>
      </ErrorState>
    )
  } else {
    controlsInConversationHeader = true
    content = (
      <ConversationPanel
        agent={conversation.currentAgent}
        threadId={threadId}
        messages={conversation.messages}
        live={conversation.live}
        messagesLoading={conversation.messagesLoading}
        messagesError={conversation.messagesError}
        pendingUserText={pendingUser?.text ?? null}
        pendingUserAttachments={pendingUser?.attachments ?? []}
        pendingUserContext={pendingUser?.context ?? []}
        anchorCurrentTurn={conversation.anchorCurrentTurn}
        awaitingResponse={conversation.isRunning}
        waitingLonger={conversation.waitingLonger}
        failedBeforeResponse={presentation.kind === "failed"}
        cancelledBeforeResponse={presentation.kind === "cancelled"}
        timeout={
          presentation.kind === "timeout"
            ? {
                hasProgress: presentation.hasProgress,
                ...(presentation.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: presentation.timeoutMs }),
              }
            : undefined
        }
        interrupted={
          presentation.kind === "interrupted"
            ? { hasProgress: presentation.hasProgress }
            : undefined
        }
        onRetry={canRetry ? () => conversation.retry(presentation.run) : undefined}
        onContinue={
          offersContinue({
            presentation,
            isRunning: conversation.isRunning,
            sandboxRecovery: Boolean(conversation.sandboxRecovery),
            messages: conversation.messages,
          })
            ? conversation.continueAfterTimeout
            : undefined
        }
        retrying={conversation.retrying}
        continuing={conversation.composerPending}
        reconnecting={conversation.reconnecting}
        sendError={conversation.sendError}
        currentThread={conversation.currentThread}
        runningThreadCount={runningThreadCount}
        threadsError={conversation.threadsError ? messages.chat.threadsLoadFailed : null}
        hasMoreThreads={conversation.threadsHasMore}
        loadingMoreThreads={conversation.threadsLoadingMore}
        loadMoreThreadsError={conversation.threadsLoadMoreError}
        onLoadMoreThreads={() => void conversation.loadMoreThreads()}
        agentThreads={conversation.agentThreads}
        sharedThreads={
          conversation.user
            ? {
                threads: conversation.sharedThreads,
                total: conversation.sharedThreadsTotal,
                error: conversation.sharedThreadsError
                  ? messages.chat.sharedThreadsLoadFailed
                  : null,
                hasMore: conversation.sharedThreadsHasMore,
                loadingMore: conversation.sharedThreadsLoadingMore,
                loadMoreError: conversation.sharedThreadsLoadMoreError,
                onLoadMore: () => void conversation.loadMoreSharedThreads(),
              }
            : undefined
        }
        onSend={conversation.send}
        onNewChat={onNavigateHome}
        onSelectThread={onNavigateThread}
        sandboxRecovery={
          conversation.sandboxRecovery ? (
            <SandboxRecovery
              pending={conversation.recreatingSandbox}
              error={conversation.sandboxRecoveryError}
              onRecreate={conversation.recreateSandbox}
              canRecreate={conversation.canRecreateSandbox}
              owner={owner}
            />
          ) : undefined
        }
        composerDisabled={
          (conversation.isRunning && answeringName === null) ||
          Boolean(conversation.sandboxRecovery)
        }
        composerHint={answeringName ? messages.sharing.answering(answeringName) : undefined}
        composerPending={conversation.composerPending}
        composerRunning={conversation.isRunning}
        composerStopping={conversation.stopping}
        onStop={conversation.canStop ? conversation.stop : undefined}
        models={conversation.models}
        selectedModel={conversation.selectedModel}
        selectedReasoning={conversation.selectedReasoning}
        modelsLoading={conversation.modelsLoading}
        modelsError={conversation.modelsError}
        onSelectModel={conversation.selectModel}
        onSelectReasoning={conversation.selectReasoning}
        onResetReasoning={conversation.resetReasoning}
        usingDefaultModel={conversation.usingDefaultModel}
        onResetModelSelection={conversation.resetModelSelection}
        composerPlaceholder={composerPlaceholder ?? messages.chat.placeholder}
        composerDraft={conversation.draftReseed.text}
        composerDraftAttachments={conversation.draftReseed.attachments}
        composerDraftContext={conversation.draftReseed.context}
        composerDraftNonce={conversation.draftReseed.nonce}
        ambientContext={ambientContext}
        compact={compact}
        welcomeContent={welcomeContent}
        headerActions={conversationHeaderActions}
        composerNotice={
          participant ? <SharedThreadNotice owner={owner} sharing={sharing} /> : undefined
        }
      />
    )
  }

  // An artifact opened from here names who published each version, from this conversation's people.
  const artifactPeople = (author: { readonly type: string; readonly id: string }) =>
    knownName(author, currentThread, conversation.authors)

  return (
    <ArtifactPeopleContext.Provider value={artifactPeople}>
      <ArtifactPanelRoot
        compact={compact}
        split={splitArtifacts}
        overlayHost={artifactHost}
        scopeKey={threadId ?? "draft"}
        routeTarget={artifactTarget}
        onRouteTargetChange={onArtifactTargetChange}
      >
        <div
          data-agent-panel={compact ? "" : undefined}
          className={cn("relative flex h-full min-h-0 flex-col", className)}
        >
          {!controlsInConversationHeader && conversationHeaderActions ? (
            <div className="absolute top-1.5 right-2 z-20 flex items-center gap-1">
              {conversationHeaderActions}
            </div>
          ) : null}
          <MessageAuthorsContext.Provider value={authors}>
            <main className="min-h-0 min-w-0 flex-1">{content}</main>
          </MessageAuthorsContext.Provider>
          <Toaster id={toasterId} position="top-center" />
        </div>
      </ArtifactPanelRoot>
    </ArtifactPeopleContext.Provider>
  )
}

/** Someone's name, from the thread's people or else the page's authors, or else their id. */
function personNameOf(
  principal: { readonly type: string; readonly id: string },
  thread: AgentThread | null,
  authors: readonly MessageAuthor[] | undefined
): string {
  return knownName(principal, thread, authors) ?? principal.id
}

/** Someone's name when the thread's people or the page's authors give one. */
function knownName(
  principal: { readonly type: string; readonly id: string },
  thread: AgentThread | null,
  authors: readonly MessageAuthor[] | undefined
): string | undefined {
  const key = principalKey(principal)
  const people = thread ? [threadOwner(thread), ...threadParticipants(thread)] : []
  const person = people.find((entry) => principalKey(entry.principal) === key)
  if (person?.displayName) return person.displayName

  return authors?.find((entry) => principalKey(entry) === key)?.displayName
}

function ErrorState({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
        {children ? <div className="pt-3">{children}</div> : null}
      </div>
    </div>
  )
}
