import { EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import { useEffect } from "react"
import { AgentsHome } from "./components/AgentsHome"
import { ConversationPanel } from "./components/ConversationPanel"
import { DocumentPreviewRoot } from "./document-preview/DocumentPreviewRoot"
import { useAgentConversation } from "./hooks/useAgentConversation"
import { installAgentResizeObserverGuard } from "./resizeObserver"
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
}: AgentChatProps) {
  const threadId = threadIdInput ?? null
  const conversation = useAgentConversation({
    threadId,
    draftAgentId: draftAgentIdInput ?? null,
    pinnedAgentId,
    onThreadCreated: onNavigateThread,
  })

  useEffect(() => {
    installAgentResizeObserverGuard()
  }, [])

  if (conversation.agentsLoading) {
    return <div className={cn("h-full", className)} aria-busy="true" />
  }
  if (conversation.agentsError) {
    return (
      <ErrorState
        className={className}
        title="Agents unavailable"
        description="Could not load registered agents."
      />
    )
  }
  if (conversation.agents.length === 0) {
    return (
      <div className={cn("flex h-full items-center justify-center p-6", className)}>
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
  }

  const startNewChatWith = (agentId: string) => onNavigateDraft(agentId)
  const pendingUser = conversation.pendingUser
  const presentation = conversation.presentation

  return (
    <DocumentPreviewRoot compact={compact}>
      <div
        data-agent-panel={compact ? "" : undefined}
        className={cn("relative flex h-full min-h-0 flex-col", className)}
      >
        {conversation.home ? (
          <AgentsHome
            agents={conversation.agents}
            threads={conversation.threads}
            agentsById={conversation.agentsById}
            threadsError={conversation.threadsError ? "Could not load chats." : null}
            onPickAgent={startNewChatWith}
            onSelectThread={onNavigateThread}
          />
        ) : (
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
            onRetry={
              presentation.kind === "failed"
                ? () => conversation.retry(presentation.run)
                : undefined
            }
            retrying={conversation.retrying}
            reconnecting={conversation.reconnecting}
            sendError={conversation.sendError}
            agents={conversation.agents}
            agentThreads={conversation.agentThreads}
            canGoHome={conversation.canGoHome}
            onSend={conversation.send}
            onBackHome={onNavigateHome}
            onNewChat={() => {
              if (conversation.currentAgent) startNewChatWith(conversation.currentAgent.id)
            }}
            onPickAgent={startNewChatWith}
            onSelectThread={onNavigateThread}
            composerDisabled={conversation.isRunning}
            composerPending={conversation.composerPending}
            composerRunning={conversation.isRunning}
            composerStopping={conversation.stopping}
            onStop={conversation.stop}
            composerPlaceholder="Ask anything"
            composerDraft={conversation.draftReseed.text}
            composerDraftAttachments={conversation.draftReseed.attachments}
            composerDraftContext={conversation.draftReseed.context}
            composerDraftNonce={conversation.draftReseed.nonce}
            ambientContext={ambientContext}
            compact={compact}
          />
        )}
      </div>
    </DocumentPreviewRoot>
  )
}

function ErrorState({
  title,
  description,
  className,
}: {
  title: string
  description: string
  className?: string
}) {
  return (
    <div className={cn("flex h-full items-center justify-center p-6 text-center", className)}>
      <div className="max-w-md space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
