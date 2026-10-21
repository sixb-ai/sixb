import { Button, Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"
import type { ConversationComposerProps } from "../hooks/use-agent-conversation"
import { useAgentMessages } from "../i18n"
import type { Agent, AgentContextInput, AgentThread } from "../types"
import { AgentThreadSwitcher } from "./agent-thread-switcher"
import { Composer } from "./composer"
import { Transcript, type TranscriptProps } from "./transcript"

export interface ConversationPanelProps {
  readonly sandboxRecovery?: ReactNode
  readonly agent: Agent | undefined
  readonly transcript: TranscriptProps
  readonly composer: ConversationComposerProps
  readonly messagesLoading: boolean
  readonly messagesError: string | null
  /** The selected durable thread, or null while composing a new one. */
  readonly currentThread: AgentThread | null
  /** Other chats with this agent, for the header history menu. */
  readonly agentThreads: readonly AgentThread[]
  /** Runs active across the threads visible to this agent surface. */
  readonly runningThreadCount: number
  readonly threadsError?: string | null
  readonly hasMoreThreads?: boolean
  readonly loadingMoreThreads?: boolean
  readonly loadMoreThreadsError?: boolean
  readonly onLoadMoreThreads?: () => void
  readonly onNewChat: () => void
  readonly onSelectThread: (threadId: string) => void
  readonly composerPlaceholder?: string
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
  /** Centered content for an empty conversation. Omit for the agent identity; null hides it. */
  readonly welcomeContent?: ReactNode
  readonly headerActions?: ReactNode
}

export function ConversationPanel({
  agent,
  transcript,
  composer,
  messagesLoading,
  messagesError,
  currentThread,
  agentThreads,
  runningThreadCount,
  threadsError,
  hasMoreThreads,
  loadingMoreThreads,
  loadMoreThreadsError,
  onLoadMoreThreads,
  onNewChat,
  onSelectThread,
  composerPlaceholder,
  ambientContext = [],
  compact = false,
  welcomeContent,
  headerActions,
  sandboxRecovery,
}: ConversationPanelProps) {
  const labels = useAgentMessages()
  const name = agent?.name ?? "Agent"
  // Optimistic activity (a just-sent message or a live run) takes over the pane immediately, so the
  // brief durable-message load never flashes a centered "Loading…".
  const hasActivity =
    Boolean(transcript.pendingUserText) ||
    (transcript.pendingUserAttachments?.length ?? 0) > 0 ||
    (transcript.pendingUserContext?.length ?? 0) > 0 ||
    transcript.live.parts.length > 0 ||
    Boolean(transcript.awaitingResponse)
  const showWelcome =
    !messagesLoading && !messagesError && !hasActivity && transcript.messages.length === 0
  const renderComposer = (wideClassName?: string) => (
    <Composer
      {...composer}
      placeholder={composerPlaceholder}
      className={compact ? "px-4 pt-2 pb-4" : wideClassName}
      ambientContext={ambientContext}
      compact={compact}
    />
  )

  const threadSwitcher = (
    <AgentThreadSwitcher
      agentName={name}
      currentThread={currentThread}
      threads={agentThreads}
      runningThreadCount={runningThreadCount}
      threadsError={threadsError}
      hasMoreThreads={hasMoreThreads}
      loadingMoreThreads={loadingMoreThreads}
      loadMoreThreadsError={loadMoreThreadsError}
      onLoadMoreThreads={onLoadMoreThreads}
      onSelectThread={onSelectThread}
      onNewThread={onNewChat}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header
        data-agent-conversation-header=""
        className={cn("flex shrink-0 items-center gap-1 px-2.5 py-2.5", compact && "h-11 py-1.5")}
      >
        <div className="ml-auto flex items-center gap-1">
          {headerActions}
          {threadSwitcher}
          <Button
            variant="ghost"
            size="icon-lg"
            onClick={onNewChat}
            aria-label={labels.threads.new}
            className="[&_svg]:size-5"
          >
            <Plus />
          </Button>
        </div>
      </header>

      {showWelcome ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            !compact && "md:justify-center md:px-8 md:pb-[25vh] lg:pb-[27vh]"
          )}
        >
          <Welcome agent={agent} compact={compact} content={welcomeContent} />
          <div className="shrink-0">
            {sandboxRecovery}
            {renderComposer("md:bg-transparent md:px-0 md:pt-0 md:pb-0")}
          </div>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {messagesLoading && !hasActivity ? (
              <div className="flex flex-1 items-center justify-center">
                <LoadingInline label={labels.chat.loadingConversation} />
              </div>
            ) : messagesError && !hasActivity ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="max-w-md text-sm text-destructive">{messagesError}</p>
              </div>
            ) : (
              <Transcript {...transcript} />
            )}
          </div>

          <div className="shrink-0">
            {sandboxRecovery}
            {renderComposer()}
          </div>
        </>
      )}
    </div>
  )
}

function Welcome({
  agent,
  compact,
  content,
}: {
  agent: Agent | undefined
  compact: boolean
  content?: ReactNode
}) {
  const name = agent?.name ?? "Agent"

  if (content !== undefined) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center px-4 text-center",
          compact ? "-translate-y-3" : "md:flex-none md:px-0 md:pb-8"
        )}
      >
        {content}
      </div>
    )
  }

  if (!compact) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center md:flex-none md:px-0 md:pb-8">
        <div className="inline-flex max-w-full items-center justify-center gap-1.5 md:gap-3">
          <p className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {name}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 -translate-y-3 items-center justify-center px-4 text-center">
      <div className="inline-flex max-w-full items-center justify-center gap-3">
        <p
          className={cn(
            "min-w-0 truncate font-semibold tracking-tight text-foreground",
            "text-xl md:text-2xl"
          )}
        >
          {name}
        </p>
      </div>
    </div>
  )
}

function LoadingInline({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Spinner className="size-4" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
