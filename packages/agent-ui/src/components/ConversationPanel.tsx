import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronLeft, Info, Plus } from "lucide-react"
import type { ReactNode } from "react"
import type { LiveRunState } from "../liveRun"
import type {
  Agent,
  AgentContextEntryInput,
  AgentContextInput,
  AgentFileRef,
  AgentMessage,
  AgentThread,
} from "../types"
import { AgentAvatar } from "./AgentAvatar"
import { AgentThreadSwitcher } from "./AgentThreadSwitcher"
import { Composer } from "./Composer"
import { RunErrorMarker } from "./MessageView"
import { Transcript } from "./Transcript"

export interface ConversationPanelProps {
  readonly agent: Agent | undefined
  readonly threadId: string | null
  readonly messages: readonly AgentMessage[]
  readonly live: LiveRunState
  readonly messagesLoading: boolean
  readonly messagesError: string | null
  readonly pendingUserText?: string | null
  readonly pendingUserAttachments?: readonly AgentFileRef[]
  readonly pendingUserContext?: readonly AgentContextEntryInput[]
  /** This client initiated the current turn, so keep the user prompt anchored while it streams. */
  readonly anchorCurrentTurn?: boolean
  /** A run has been requested and we're waiting on it — show the thinking shimmer immediately. */
  readonly awaitingResponse: boolean
  readonly waitingLonger?: boolean
  readonly failedBeforeResponse?: boolean
  readonly cancelledBeforeResponse?: boolean
  readonly timeout?: { readonly hasProgress: boolean; readonly timeoutMs?: number }
  readonly onRetry?: () => void
  readonly onContinue?: () => void
  readonly retrying?: boolean
  readonly continuing?: boolean
  /** The active run's stream dropped and is re-subscribing. */
  readonly reconnecting: boolean
  /** A failed send to surface above the composer, or null. English, user-facing. */
  readonly sendError?: string | null
  /** All registered agents, for the header quick-switcher. */
  readonly agents: readonly Agent[]
  /** The selected durable thread, or null while composing a new one. */
  readonly currentThread: AgentThread | null
  /** Other chats with this agent, for the header history menu. */
  readonly agentThreads: readonly AgentThread[]
  /** Runs active across the threads visible to this agent surface. */
  readonly runningThreadCount: number
  /** Whether a home/landing exists to return to (i.e. more than one agent). */
  readonly canGoHome: boolean
  readonly onSend: (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
  readonly onBackHome: () => void
  readonly onNewChat: () => void
  readonly onPickAgent: (agentId: string) => void
  readonly onSelectThread: (threadId: string) => void
  readonly composerDisabled: boolean
  readonly composerPending: boolean
  /** A run is in flight: the composer shows a stop button wired to {@link onStop}. */
  readonly composerRunning: boolean
  /** A stop has been requested and we're waiting for the run to end. */
  readonly composerStopping: boolean
  readonly onStop: () => void
  readonly composerPlaceholder?: string
  /** Text to restore into the composer (e.g. after a failed send), applied when the nonce changes. */
  readonly composerDraft?: string
  readonly composerDraftAttachments?: readonly AgentFileRef[]
  readonly composerDraftContext?: readonly AgentContextEntryInput[]
  readonly composerDraftNonce?: number
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
  /** Optional branded content above the composer while a draft has no messages. */
  readonly emptyStateHeader?: ReactNode
  /** Optional actions or shortcuts below the composer while a draft has no messages. */
  readonly emptyStateFooter?: ReactNode
  /** Center the empty draft as a landing experience instead of using the compact dock layout. */
  readonly centerEmptyState?: boolean
  /** Hide conversation controls until the first message is sent. */
  readonly hideHeaderOnEmpty?: boolean
  readonly emptyStateThreadHistoryLabel?: string
  readonly headerActions?: ReactNode
}

export function ConversationPanel({
  agent,
  threadId,
  messages,
  live,
  messagesLoading,
  messagesError,
  pendingUserText,
  pendingUserAttachments = [],
  pendingUserContext = [],
  anchorCurrentTurn,
  awaitingResponse,
  waitingLonger,
  failedBeforeResponse,
  cancelledBeforeResponse,
  timeout,
  onRetry,
  onContinue,
  retrying,
  continuing,
  reconnecting,
  sendError,
  agents,
  currentThread,
  agentThreads,
  runningThreadCount,
  canGoHome,
  onSend,
  onBackHome,
  onNewChat,
  onPickAgent,
  onSelectThread,
  composerDisabled,
  composerPending,
  composerRunning,
  composerStopping,
  onStop,
  composerPlaceholder,
  composerDraft,
  composerDraftAttachments,
  composerDraftContext,
  composerDraftNonce,
  ambientContext = [],
  compact = false,
  emptyStateHeader,
  emptyStateFooter,
  centerEmptyState = false,
  hideHeaderOnEmpty = false,
  emptyStateThreadHistoryLabel,
  headerActions,
}: ConversationPanelProps) {
  const name = agent?.name ?? "Agent"
  // Optimistic activity (a just-sent message or a live run) takes over the pane immediately, so the
  // brief durable-message load never flashes a centered "Loading…".
  const hasActivity =
    Boolean(pendingUserText) ||
    pendingUserAttachments.length > 0 ||
    pendingUserContext.length > 0 ||
    live.parts.length > 0 ||
    awaitingResponse
  const showWelcome = !messagesLoading && !messagesError && !hasActivity && messages.length === 0
  const renderSendError = (className?: string) =>
    sendError ? (
      <div className={cn("mx-auto w-full max-w-3xl px-4 pb-1", className)}>
        <RunErrorMarker message={sendError} />
      </div>
    ) : null
  const renderComposer = (wideClassName?: string) => (
    <Composer
      onSend={onSend}
      disabled={composerDisabled}
      pending={composerPending}
      running={composerRunning}
      stopping={composerStopping}
      onStop={onStop}
      placeholder={composerPlaceholder}
      className={
        compact
          ? centerEmptyState && showWelcome
            ? "bg-transparent p-0"
            : "px-4 pt-2 pb-4"
          : wideClassName
      }
      draft={composerDraft}
      draftAttachments={composerDraftAttachments}
      draftContext={composerDraftContext}
      draftNonce={composerDraftNonce}
      ambientContext={ambientContext}
      compact={compact}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {showWelcome && hideHeaderOnEmpty && emptyStateThreadHistoryLabel ? (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
          {headerActions}
          <AgentThreadSwitcher
            agentName={name}
            currentThread={currentThread}
            threads={agentThreads}
            runningThreadCount={runningThreadCount}
            onSelectThread={onSelectThread}
            onNewThread={onNewChat}
            triggerLabel={emptyStateThreadHistoryLabel}
          />
        </div>
      ) : null}
      {showWelcome && hideHeaderOnEmpty ? null : (
        <header
          data-agent-conversation-header=""
          className={cn("flex shrink-0 items-center gap-1 px-2.5 py-2.5", compact && "h-11 py-1.5")}
        >
          {canGoHome ? (
            <Button variant="ghost" size="icon-sm" onClick={onBackHome} aria-label="Back to chats">
              <ChevronLeft />
            </Button>
          ) : null}

          {!compact ? (
            <AgentIdentity agent={agent} agents={agents} onPickAgent={onPickAgent} interactive />
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            {headerActions}
            <AgentThreadSwitcher
              agentName={name}
              currentThread={currentThread}
              threads={agentThreads}
              runningThreadCount={runningThreadCount}
              onSelectThread={onSelectThread}
              onNewThread={onNewChat}
            />
            <Button
              variant="ghost"
              size="icon-lg"
              onClick={onNewChat}
              aria-label="New thread"
              className="[&_svg]:size-5"
            >
              <Plus />
            </Button>
          </div>
        </header>
      )}

      {showWelcome ? (
        centerEmptyState ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-[8vh]">
            <div className="w-full max-w-3xl">
              {emptyStateHeader ? <div className="mb-7">{emptyStateHeader}</div> : null}
              <div>
                {renderSendError("px-0")}
                {renderComposer()}
              </div>
              {emptyStateFooter ? <div className="mt-4">{emptyStateFooter}</div> : null}
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !compact && "md:justify-center md:px-8 md:pb-[25vh] lg:pb-[27vh]"
            )}
          >
            <Welcome agent={agent} compact={compact} />
            <div className="shrink-0">
              {renderSendError("md:px-0")}
              {renderComposer("md:bg-transparent md:px-0 md:pt-0 md:pb-0")}
            </div>
          </div>
        )
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {messagesLoading && !hasActivity ? (
              <div className="flex flex-1 items-center justify-center">
                <LoadingInline label="Loading conversation…" />
              </div>
            ) : messagesError && !hasActivity ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="max-w-md text-sm text-destructive">{messagesError}</p>
              </div>
            ) : (
              <Transcript
                threadId={threadId}
                messages={messages}
                live={live}
                pendingUserText={pendingUserText}
                pendingUserAttachments={pendingUserAttachments}
                pendingUserContext={pendingUserContext}
                anchorCurrentTurn={anchorCurrentTurn}
                awaitingResponse={awaitingResponse}
                waitingLonger={waitingLonger}
                failedBeforeResponse={failedBeforeResponse}
                cancelledBeforeResponse={cancelledBeforeResponse}
                timeout={timeout}
                onRetry={onRetry}
                onContinue={onContinue}
                retrying={retrying}
                continuing={continuing}
                reconnecting={reconnecting}
              />
            )}
          </div>

          <div className="shrink-0">
            {renderSendError()}
            {renderComposer()}
          </div>
        </>
      )}
    </div>
  )
}

function AgentIdentity({
  agent,
  agents,
  onPickAgent,
  interactive,
}: {
  agent: Agent | undefined
  agents: readonly Agent[]
  onPickAgent: (agentId: string) => void
  interactive: boolean
}) {
  const name = agent?.name ?? "Agent"

  if (!interactive) {
    return (
      <div className="flex min-w-0 items-center gap-2.5 px-1.5 py-1">
        <AgentAvatar name={name} />
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      </div>
    )
  }

  if (agents.length <= 1) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted"
        >
          <AgentAvatar name={name} />
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch agent</DropdownMenuLabel>
        {agents.map((candidate) => (
          <DropdownMenuItem
            key={candidate.id}
            onSelect={() => onPickAgent(candidate.id)}
            className="gap-2.5"
          >
            <AgentAvatar name={candidate.name} className="size-6 text-[10px]" />
            <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
            {candidate.id === agent?.id ? <Check className="size-4 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Welcome({ agent, compact }: { agent: Agent | undefined; compact: boolean }) {
  const name = agent?.name ?? "Agent"
  const description = agent?.description?.trim()

  if (!compact) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center md:flex-none md:px-0 md:pb-8">
        <div className="inline-flex max-w-full items-center justify-center gap-1.5 md:gap-3">
          <AgentAvatar name={name} className="hidden size-10 text-sm md:flex" />
          <p className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {name}
          </p>
          {description ? <AgentInfo name={name} description={description} /> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 -translate-y-3 items-center justify-center px-4 text-center">
      <div className="inline-flex max-w-full items-center justify-center gap-3">
        <AgentAvatar name={name} className="size-9 text-sm md:size-10" />
        <p
          className={cn(
            "min-w-0 truncate font-semibold tracking-tight text-foreground",
            "text-xl md:text-2xl"
          )}
        >
          {name}
        </p>
        {description ? <AgentInfo name={name} description={description} /> : null}
      </div>
    </div>
  )
}

function AgentInfo({ name, description }: { name: string; description: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${name}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="max-w-72 leading-5">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
