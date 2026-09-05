import {
  EmptyState,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { MessagesSquare } from "lucide-react"
import { type CSSProperties, type ReactNode, useState } from "react"
import { ConversationPanel } from "./components/ConversationPanel"
import { ThreadSidebar } from "./components/ThreadSidebar"
import { DocumentPreviewRoot } from "./document-preview/DocumentPreviewRoot"
import { useAgentConversation } from "./hooks/useAgentConversation"
import type { AgentContextInput } from "./types"

export interface AgentChatProps {
  readonly threadId?: string | null
  readonly onNavigateHome: () => void
  readonly onNavigateThread: (threadId: string) => void
  readonly onExit?: () => void
  readonly exitLabel?: string
  readonly className?: string
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
  /** Host chrome rendered above the workspace thread navigation. */
  readonly sidebarHeader?: ReactNode
  /** Host chrome rendered below the workspace thread navigation. */
  readonly sidebarFooter?: ReactNode
  /** Desktop workspace sidebar width. Mobile keeps its responsive sheet width. */
  readonly sidebarWidth?: CSSProperties["width"]
}

/** Route-independent conversation view; routing and embedded panels only adapt its callbacks. */
export function AgentChat({
  threadId: threadIdInput = null,
  onNavigateHome,
  onNavigateThread,
  onExit,
  exitLabel = "Back to app",
  className,
  ambientContext = [],
  compact = false,
  sidebarHeader,
  sidebarFooter,
  sidebarWidth,
}: AgentChatProps) {
  const threadId = threadIdInput ?? null
  const conversation = useAgentConversation({
    threadId,
    embedded: compact,
    onThreadCreated: onNavigateThread,
  })
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const selectThread = (nextThreadId: string) => {
    setMobileSidebarOpen(false)
    onNavigateThread(nextThreadId)
  }
  const startNewThread = () => {
    setMobileSidebarOpen(false)
    onNavigateHome()
  }
  const exitWorkspace = onExit
    ? () => {
        setMobileSidebarOpen(false)
        onExit()
      }
    : undefined
  const pendingUser = conversation.pendingUser
  const presentation = conversation.presentation
  const renderThreadSidebar = (sidebarClassName: string, width?: CSSProperties["width"]) => (
    <ThreadSidebar
      threads={conversation.threads}
      currentThreadId={threadId}
      loading={conversation.agentLoading}
      threadsError={
        conversation.agentError
          ? "Agent unavailable."
          : conversation.threadsError
            ? "Could not load threads."
            : null
      }
      totalThreads={conversation.threadTotal}
      hasMoreThreads={conversation.threadsHasMore}
      loadingMoreThreads={conversation.threadsLoadingMore}
      loadMoreThreadsError={conversation.threadsLoadMoreError}
      onStartNewThread={startNewThread}
      onSelectThread={selectThread}
      onLoadMoreThreads={() => void conversation.loadMoreThreads()}
      onExit={exitWorkspace}
      exitLabel={exitLabel}
      header={sidebarHeader}
      footer={sidebarFooter}
      className={sidebarClassName}
      width={width}
    />
  )

  let content: ReactNode
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
      />
    )
  } else {
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
        agentThreads={conversation.agentThreads}
        onSend={conversation.send}
        onOpenWorkspaceNavigation={() => setMobileSidebarOpen(true)}
        onNewChat={startNewThread}
        onSelectThread={selectThread}
        composerDisabled={conversation.isRunning}
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
        composerPlaceholder="Ask anything"
        composerDraft={conversation.draftReseed.text}
        composerDraftAttachments={conversation.draftReseed.attachments}
        composerDraftContext={conversation.draftReseed.context}
        composerDraftNonce={conversation.draftReseed.nonce}
        ambientContext={ambientContext}
        compact={compact}
        workspace={!compact}
      />
    )
  }

  return (
    <DocumentPreviewRoot compact={compact} scopeKey={threadId ?? "draft"} persistenceKey={threadId}>
      <div
        data-agent-panel={compact ? "" : undefined}
        className={cn("relative flex h-full min-h-0 min-w-0", compact && "flex-col", className)}
      >
        {!compact ? (
          <>
            {renderThreadSidebar("hidden h-full w-64 shrink-0 md:flex xl:w-72", sidebarWidth)}
            <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
              <SheetContent
                side="left"
                showCloseButton={false}
                className="w-72 max-w-[calc(100vw-3rem)] gap-0 p-0 md:hidden"
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>Agent navigation</SheetTitle>
                  <SheetDescription>Switch threads or start a new one.</SheetDescription>
                </SheetHeader>
                {renderThreadSidebar("flex h-full w-full border-r-0")}
              </SheetContent>
            </Sheet>
          </>
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
