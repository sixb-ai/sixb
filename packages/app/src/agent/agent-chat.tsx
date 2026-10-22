import { Button, EmptyState, Toaster } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import { type ReactNode, useId } from "react"
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
import { MessageAuthorsContext, useConversationAuthors } from "./message-authors"
import { personName, threadOwner } from "./sharing"
import type { AgentContextInput } from "./types"

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
  const currentThread = conversation.currentThread
  const owner = currentThread ? personName(threadOwner(currentThread)) : ""

  // Sharing needs someone signed in: without auth, the project owns every conversation.
  const sharingThread = conversation.user ? currentThread : null
  const participant = sharingThread !== null && conversation.access === "participant"

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
        transcript={conversation.transcriptProps}
        composer={conversation.composerProps}
        messagesLoading={conversation.messagesLoading}
        messagesError={conversation.messagesError}
        currentThread={conversation.currentThread}
        runningThreadCount={conversation.runningThreadCount}
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
        onNewChat={onNavigateHome}
        onSelectThread={onNavigateThread}
        sandboxRecovery={
          conversation.sandboxRecoveryProps ? (
            <SandboxRecovery {...conversation.sandboxRecoveryProps} />
          ) : undefined
        }
        composerPlaceholder={composerPlaceholder ?? messages.chat.placeholder}
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

  return (
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
  )
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
