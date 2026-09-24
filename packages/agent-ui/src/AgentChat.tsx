import { Button, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import type { ReactNode } from "react"
import { ConversationPanel } from "./components/ConversationPanel"
import { SandboxRecovery } from "./components/SandboxRecovery"
import { DocumentPreviewRoot } from "./document-preview/DocumentPreviewRoot"
import type { AgentDocumentPreviewRenderer } from "./document-preview/types"
import { useAgentConversation } from "./hooks/useAgentConversation"
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
  /** Additional file viewers supplied by the host application. */
  readonly documentPreviewRenderers?: readonly AgentDocumentPreviewRenderer[]
  /** Portal host for a modeless compact document canvas. */
  readonly documentPreviewHost?: HTMLElement | null
  /** Keep documents beside compact chat on desktop instead of opening a modal. */
  readonly splitDocumentPreview?: boolean
  readonly emptyStateHeader?: ReactNode
  readonly emptyStateFooter?: ReactNode
  readonly centerEmptyState?: boolean
  readonly hideHeaderOnEmpty?: boolean
  readonly emptyStateThreadHistoryLabel?: string
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
  documentPreviewRenderers,
  documentPreviewHost,
  splitDocumentPreview = false,
  emptyStateHeader,
  emptyStateFooter,
  centerEmptyState,
  hideHeaderOnEmpty,
  emptyStateThreadHistoryLabel,
  conversationHeaderActions,
  composerPlaceholder,
}: AgentChatProps) {
  const threadId = threadIdInput ?? null
  const conversation = useAgentConversation({
    threadId,
    onThreadCreated: onNavigateThread,
  })
  const pendingUser = conversation.pendingUser
  const presentation = conversation.presentation
  const runningThreadCount =
    conversation.threads.filter((entry) => entry.activeRunId !== null).length +
    (threadId &&
    conversation.isRunning &&
    !conversation.threads.some((entry) => entry.id === threadId && entry.activeRunId !== null)
      ? 1
      : 0)

  let content: ReactNode
  let controlsInConversationHeader = false
  if (conversation.agentLoading) {
    content = <div className="h-full" aria-busy="true" />
  } else if (conversation.agentError) {
    content = <ErrorState title="Agent unavailable" description="Could not load the agent." />
  } else if (!conversation.currentAgent) {
    content = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<MessagesSquare className="size-12 stroke-1" />}
          title="Agent unavailable"
          description="Configure at least one language model and grant access to the project agent."
        />
      </div>
    )
  } else if (conversation.threadUnavailable) {
    content = (
      <ErrorState
        title="Conversation unavailable"
        description="This conversation is no longer available."
      >
        <Button variant="outline" onClick={onNavigateHome}>
          New thread
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
        onRetry={
          !conversation.sandboxRecovery &&
          (presentation.kind === "failed" ||
            (presentation.kind === "timeout" && !presentation.hasProgress))
            ? () => conversation.retry(presentation.run)
            : undefined
        }
        onContinue={
          !conversation.sandboxRecovery &&
          presentation.kind === "timeout" &&
          presentation.hasProgress
            ? conversation.continueAfterTimeout
            : undefined
        }
        retrying={conversation.retrying}
        continuing={conversation.composerPending}
        reconnecting={conversation.reconnecting}
        sendError={conversation.sendError}
        currentThread={conversation.currentThread}
        runningThreadCount={runningThreadCount}
        threadsError={conversation.threadsError ? "Could not load threads." : null}
        hasMoreThreads={conversation.threadsHasMore}
        loadingMoreThreads={conversation.threadsLoadingMore}
        loadMoreThreadsError={conversation.threadsLoadMoreError}
        onLoadMoreThreads={() => void conversation.loadMoreThreads()}
        agentThreads={conversation.agentThreads}
        onSend={conversation.send}
        onNewChat={onNavigateHome}
        onSelectThread={onNavigateThread}
        sandboxRecovery={
          conversation.sandboxRecovery ? (
            <SandboxRecovery
              pending={conversation.recreatingSandbox}
              error={conversation.sandboxRecoveryError}
              onRecreate={conversation.recreateSandbox}
            />
          ) : undefined
        }
        composerDisabled={conversation.isRunning || Boolean(conversation.sandboxRecovery)}
        composerPending={conversation.composerPending}
        composerRunning={conversation.isRunning}
        composerStopping={conversation.stopping}
        onStop={conversation.stop}
        models={conversation.models}
        selectedModel={conversation.selectedModel}
        selectedReasoning={conversation.selectedReasoning}
        modelsLoading={conversation.modelsLoading}
        modelsError={conversation.modelsError}
        onSelectModel={conversation.selectModel}
        onSelectReasoning={conversation.selectReasoning}
        composerPlaceholder={composerPlaceholder ?? "Ask anything"}
        composerDraft={conversation.draftReseed.text}
        composerDraftAttachments={conversation.draftReseed.attachments}
        composerDraftContext={conversation.draftReseed.context}
        composerDraftNonce={conversation.draftReseed.nonce}
        ambientContext={ambientContext}
        compact={compact}
        welcomeContent={welcomeContent}
        emptyStateHeader={emptyStateHeader}
        emptyStateFooter={emptyStateFooter}
        centerEmptyState={centerEmptyState}
        hideHeaderOnEmpty={hideHeaderOnEmpty}
        emptyStateThreadHistoryLabel={emptyStateThreadHistoryLabel}
        headerActions={conversationHeaderActions}
      />
    )
  }

  return (
    <DocumentPreviewRoot
      compact={compact}
      split={splitDocumentPreview}
      overlayHost={documentPreviewHost}
      scopeKey={threadId ?? "draft"}
      persistenceKey={threadId}
      documentPreviewRenderers={documentPreviewRenderers}
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
        <main className="min-h-0 min-w-0 flex-1">{content}</main>
      </div>
    </DocumentPreviewRoot>
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
