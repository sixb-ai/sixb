import { EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import type { ReactNode } from "react"
import { AgentsHome } from "./components/AgentsHome"
import { ConversationPanel } from "./components/ConversationPanel"
import { DocumentPreviewRoot } from "./document-preview/DocumentPreviewRoot"
import { useAgentConversation } from "./hooks/useAgentConversation"
import type { AgentContextInput } from "./types"

export interface AgentChatProps {
  readonly threadId?: string | null
  readonly draftAgentId?: string | null
  readonly onNavigateHome: () => void
  readonly onNavigateDraft: (agentId: string) => void
  readonly onNavigateThread: (threadId: string) => void
  readonly className?: string
  /** Restrict the conversation surface to one agent (used by embedded AgentPanel). */
  readonly pinnedAgentId?: string
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
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
  draftAgentId: draftAgentIdInput = null,
  onNavigateHome,
  onNavigateDraft,
  onNavigateThread,
  className,
  pinnedAgentId,
  ambientContext = [],
  compact = false,
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
    draftAgentId: draftAgentIdInput ?? null,
    pinnedAgentId,
    onThreadCreated: onNavigateThread,
  })
  const startNewChatWith = (agentId: string) => {
    onNavigateDraft(agentId)
  }
  const selectThread = (nextThreadId: string) => {
    onNavigateThread(nextThreadId)
  }
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
  if (conversation.agentsLoading) {
    content = <div className="h-full" aria-busy="true" />
  } else if (conversation.agentsError) {
    content = (
      <ErrorState title="Agents unavailable" description="Could not load registered agents." />
    )
  } else if (conversation.agents.length === 0) {
    content = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<MessagesSquare className="size-12 stroke-1" />}
          title={pinnedAgentId ? "Agent unavailable" : "No agents registered"}
          description={
            pinnedAgentId
              ? `The agent '${pinnedAgentId}' is not registered or is not available to this user.`
              : "Agents are discovered from your project's agents/ directory. Define one to start a chat."
          }
        />
      </div>
    )
  } else if (conversation.home) {
    content = (
      <AgentsHome
        agents={conversation.agents}
        threads={conversation.threads}
        agentsById={conversation.agentsById}
        threadsError={conversation.threadsError ? "Could not load chats." : null}
        onPickAgent={startNewChatWith}
        onSelectThread={selectThread}
      />
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
          presentation.kind === "failed" ||
          (presentation.kind === "timeout" && !presentation.hasProgress)
            ? () => conversation.retry(presentation.run)
            : undefined
        }
        onContinue={
          presentation.kind === "timeout" && presentation.hasProgress
            ? conversation.continueAfterTimeout
            : undefined
        }
        retrying={conversation.retrying}
        continuing={conversation.composerPending}
        reconnecting={conversation.reconnecting}
        sendError={conversation.sendError}
        agents={conversation.agents}
        currentThread={conversation.currentThread}
        agentThreads={conversation.agentThreads}
        runningThreadCount={runningThreadCount}
        canGoHome={conversation.canGoHome}
        onSend={conversation.send}
        onBackHome={onNavigateHome}
        onNewChat={() => {
          if (conversation.currentAgent) startNewChatWith(conversation.currentAgent.id)
        }}
        onPickAgent={startNewChatWith}
        onSelectThread={selectThread}
        composerDisabled={conversation.isRunning}
        composerPending={conversation.composerPending}
        composerRunning={conversation.isRunning}
        composerStopping={conversation.stopping}
        onStop={conversation.stop}
        composerPlaceholder={composerPlaceholder ?? "Ask anything"}
        composerDraft={conversation.draftReseed.text}
        composerDraftAttachments={conversation.draftReseed.attachments}
        composerDraftContext={conversation.draftReseed.context}
        composerDraftNonce={conversation.draftReseed.nonce}
        ambientContext={ambientContext}
        compact={compact}
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
      scopeKey={threadId ?? (draftAgentIdInput ? `draft:${draftAgentIdInput}` : "home")}
      persistenceKey={threadId}
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

function ErrorState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
