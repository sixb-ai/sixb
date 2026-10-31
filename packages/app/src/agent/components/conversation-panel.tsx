import { Button, Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"
import type { ConversationComposerProps } from "../hooks/use-agent-conversation"
import { useAgentMessages } from "../i18n"
import type { Agent, AgentContextInput, AgentThread } from "../types"
import { Composer } from "./composer"
import { ThreadsButton } from "./threads-button"
import { Transcript, type TranscriptProps } from "./transcript"

export interface ConversationPanelProps {
  readonly sandboxRecovery?: ReactNode
  /** A line above the composer, such as whose shared conversation this is. */
  readonly composerNotice?: ReactNode
  /** The reader follows the conversation without writing in it: no composer, the notice alone. */
  readonly readOnly?: boolean
  readonly agent: Agent | undefined
  readonly transcript: TranscriptProps
  readonly composer: ConversationComposerProps
  readonly messagesLoading: boolean
  readonly messagesError: string | null
  /** The selected durable thread, or null while composing a new one. */
  readonly currentThread: AgentThread | null
  /** Runs active across the threads visible to this agent surface. */
  readonly runningThreadCount: number
  /** The threads where a call waits for the reader's approval. */
  readonly waitingThreadIds?: ReadonlySet<string>
  readonly onNewChat: () => void
  /** Open the page of every conversation; without it, the header offers no way there. */
  readonly onOpenThreads?: () => void
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
  runningThreadCount,
  waitingThreadIds,
  onNewChat,
  onOpenThreads,
  composerPlaceholder,
  ambientContext = [],
  compact = false,
  welcomeContent,
  headerActions,
  sandboxRecovery,
  composerNotice,
  readOnly = false,
}: ConversationPanelProps) {
  const labels = useAgentMessages()
  // Optimistic activity (a just-sent message or a live run) takes over the pane immediately, so the
  // brief durable-message load never flashes a centered "Loading…".
  const hasActivity =
    transcript.turn.kind === "responding" ||
    transcript.messages.some((message) => message.id === null)
  const showWelcome =
    !messagesLoading && !messagesError && !hasActivity && transcript.messages.length === 0
  const renderComposer = (wideClassName?: string) =>
    readOnly ? (
      // Where the composer would end, so the notice keeps its place at the foot of the pane.
      <div aria-hidden className={compact ? "pb-4" : "pb-3"} />
    ) : (
      <Composer
        {...composer}
        placeholder={composerPlaceholder}
        className={compact ? "px-4 pt-2 pb-4" : wideClassName}
        ambientContext={ambientContext}
        compact={compact}
      />
    )

  const threadsButton = onOpenThreads ? (
    <ThreadsButton
      currentThreadId={currentThread?.id ?? null}
      runningThreadCount={runningThreadCount}
      waitingThreadIds={waitingThreadIds}
      onOpen={onOpenThreads}
    />
  ) : null

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-thread-id={currentThread?.id}>
      <header
        data-agent-conversation-header=""
        className={cn("flex shrink-0 items-center gap-1 px-2.5 py-2.5", compact && "h-11 py-1.5")}
      >
        <div className="ml-auto flex items-center gap-1">
          {headerActions}
          {threadsButton}
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
            {composerNotice}
            {renderComposer("md:bg-transparent md:px-0 md:pt-0 md:pb-0")}
          </div>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Scrolled content fades under the header instead of being cut at its edge. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
            />
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
            {composerNotice}
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
