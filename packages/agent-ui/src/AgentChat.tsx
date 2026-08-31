import {
  Button,
  EmptyState,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, MessagesSquare, PanelLeft } from "lucide-react"
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from "react"
import { AgentAvatar } from "./components/AgentAvatar"
import { AgentsHome } from "./components/AgentsHome"
import { ConversationPanel } from "./components/ConversationPanel"
import { ThreadSidebar } from "./components/ThreadSidebar"
import { DocumentPreviewRoot } from "./document-preview/DocumentPreviewRoot"
import { useAgentConversation } from "./hooks/useAgentConversation"
import type { Agent, AgentContextInput } from "./types"

const LAST_SELECTED_AGENT_KEY = "sixb.agent-ui.last-selected-agent"

export interface AgentChatProps {
  readonly threadId?: string | null
  readonly draftAgentId?: string | null
  readonly onNavigateHome: () => void
  readonly onNavigateDraft: (agentId: string) => void
  readonly onNavigateThread: (threadId: string) => void
  readonly onExit?: () => void
  readonly exitLabel?: string
  readonly className?: string
  /** Restrict the conversation surface to one agent (used by embedded AgentPanel). */
  readonly pinnedAgentId?: string
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
  draftAgentId: draftAgentIdInput = null,
  onNavigateHome,
  onNavigateDraft,
  onNavigateThread,
  onExit,
  exitLabel = "Back to app",
  className,
  pinnedAgentId,
  ambientContext = [],
  compact = false,
  sidebarHeader,
  sidebarFooter,
  sidebarWidth,
}: AgentChatProps) {
  const threadId = threadIdInput ?? null
  const conversation = useAgentConversation({
    threadId,
    draftAgentId: draftAgentIdInput ?? null,
    pinnedAgentId,
    onThreadCreated: onNavigateThread,
  })
  const [lastSelectedAgentId, setLastSelectedAgentId] = useState(readLastSelectedAgent)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const rememberAgent = useCallback((agentId: string) => {
    setLastSelectedAgentId(agentId)
    writeLastSelectedAgent(agentId)
  }, [])
  const currentAgentId = conversation.currentAgent?.id
  const selectedAgentId =
    currentAgentId ??
    (lastSelectedAgentId && conversation.agentsById.has(lastSelectedAgentId)
      ? lastSelectedAgentId
      : null)

  useEffect(() => {
    if (!pinnedAgentId && currentAgentId) rememberAgent(currentAgentId)
  }, [currentAgentId, pinnedAgentId, rememberAgent])

  useEffect(() => {
    if (!compact && !pinnedAgentId && conversation.home && selectedAgentId) {
      onNavigateDraft(selectedAgentId)
    }
  }, [compact, conversation.home, onNavigateDraft, pinnedAgentId, selectedAgentId])

  const startNewChatWith = (agentId: string) => {
    setMobileSidebarOpen(false)
    rememberAgent(agentId)
    onNavigateDraft(agentId)
  }
  const selectThread = (nextThreadId: string) => {
    setMobileSidebarOpen(false)
    onNavigateThread(nextThreadId)
  }
  const startNewThread = () => {
    if (selectedAgentId) {
      startNewChatWith(selectedAgentId)
      return
    }
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
      agents={conversation.agents}
      threads={conversation.threads}
      agentsById={conversation.agentsById}
      currentThreadId={threadId}
      selectedAgentId={selectedAgentId}
      loading={conversation.agentsLoading}
      threadsError={
        conversation.agentsError
          ? "Agents unavailable."
          : conversation.threadsError
            ? "Could not load threads."
            : null
      }
      totalThreads={conversation.threadTotal}
      hasMoreThreads={conversation.threadsHasMore}
      loadingMoreThreads={conversation.threadsLoadingMore}
      loadMoreThreadsError={conversation.threadsLoadMoreError}
      onPickAgent={startNewChatWith}
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
  } else if (!compact && !pinnedAgentId && conversation.home && selectedAgentId) {
    content = <div className="h-full" aria-busy="true" />
  } else if (conversation.home) {
    content = compact ? (
      <AgentsHome
        agents={conversation.agents}
        threads={conversation.threads}
        agentsById={conversation.agentsById}
        threadsError={conversation.threadsError ? "Could not load chats." : null}
        onPickAgent={startNewChatWith}
        onSelectThread={selectThread}
      />
    ) : (
      <WorkspaceHome
        agents={conversation.agents}
        onPickAgent={startNewChatWith}
        onOpenNavigation={() => setMobileSidebarOpen(true)}
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
        agents={conversation.agents}
        agentThreads={conversation.agentThreads}
        canGoHome={compact ? conversation.canGoHome : true}
        onSend={conversation.send}
        onBackHome={onNavigateHome}
        onOpenWorkspaceNavigation={() => setMobileSidebarOpen(true)}
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
    <DocumentPreviewRoot
      compact={compact}
      scopeKey={threadId ?? (draftAgentIdInput ? `draft:${draftAgentIdInput}` : "home")}
      persistenceKey={threadId}
    >
      <div
        data-agent-panel={compact ? "" : undefined}
        className={cn("relative flex h-full min-h-0", compact && "flex-col", className)}
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
                  <SheetDescription>
                    Switch agents and threads or start a new thread.
                  </SheetDescription>
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

function readLastSelectedAgent(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(LAST_SELECTED_AGENT_KEY)
  } catch {
    return null
  }
}

function writeLastSelectedAgent(agentId: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_SELECTED_AGENT_KEY, agentId)
  } catch {
    // A private or restricted browser context can disable storage; in-memory selection still works.
  }
}

function WorkspaceHome({
  agents,
  onPickAgent,
  onOpenNavigation,
}: {
  agents: readonly Agent[]
  onPickAgent: (agentId: string) => void
  onOpenNavigation: () => void
}) {
  return (
    <div className="relative flex h-full items-center justify-center px-6 pb-[10vh]">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onOpenNavigation}
        aria-label="Open agent navigation"
        className="absolute top-2 left-2 md:hidden"
      >
        <PanelLeft />
      </Button>
      <div className="w-full max-w-md">
        <div className="text-center">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Start a new thread
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Choose the agent best suited to the work.
          </p>
        </div>
        <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-card shadow-xs">
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onPickAgent(agent.id)}
              className={cn(
                "group flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                index > 0 && "border-t border-border/70"
              )}
            >
              <AgentAvatar name={agent.name} className="size-9 text-xs" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{agent.name}</span>
                {agent.description ? (
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {agent.description}
                  </span>
                ) : null}
              </span>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
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
