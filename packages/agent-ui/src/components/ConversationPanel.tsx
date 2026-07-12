import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { Check, ChevronLeft, History, Info, Search, SquarePen } from "lucide-react"
import { useMemo, useState } from "react"
import { groupThreadsByDate } from "../format"
import type { LiveRunState } from "../liveRun"
import type { Agent, AgentFileRef, AgentMessage, AgentThread } from "../types"
import { AgentAvatar } from "./AgentAvatar"
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
  /** This client initiated the current turn, so keep the user prompt anchored while it streams. */
  readonly anchorCurrentTurn?: boolean
  /** A run has been requested and we're waiting on it — show the thinking shimmer immediately. */
  readonly awaitingResponse: boolean
  readonly waitingLonger?: boolean
  readonly failedBeforeResponse?: boolean
  readonly cancelledBeforeResponse?: boolean
  readonly onRetry?: () => void
  readonly retrying?: boolean
  /** The active run's stream dropped and is re-subscribing. */
  readonly reconnecting: boolean
  /** A failed send to surface above the composer, or null. English, user-facing. */
  readonly sendError?: string | null
  /** All registered agents, for the header quick-switcher. */
  readonly agents: readonly Agent[]
  /** Other chats with this agent, for the header history menu. */
  readonly agentThreads: readonly AgentThread[]
  /** Whether a home/landing exists to return to (i.e. more than one agent). */
  readonly canGoHome: boolean
  readonly onSend: (text: string, attachments: readonly AgentFileRef[]) => void
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
  readonly composerDraftNonce?: number
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
  anchorCurrentTurn,
  awaitingResponse,
  waitingLonger,
  failedBeforeResponse,
  cancelledBeforeResponse,
  onRetry,
  retrying,
  reconnecting,
  sendError,
  agents,
  agentThreads,
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
  composerDraftNonce,
}: ConversationPanelProps) {
  const name = agent?.name ?? "Agent"
  // Optimistic activity (a just-sent message or a live run) takes over the pane immediately, so the
  // brief durable-message load never flashes a centered "Loading…".
  const hasActivity =
    Boolean(pendingUserText) ||
    pendingUserAttachments.length > 0 ||
    live.parts.length > 0 ||
    awaitingResponse
  const showWelcome =
    !messagesLoading &&
    !messagesError &&
    !hasActivity &&
    messages.length === 0 &&
    live.parts.length === 0 &&
    !pendingUserText &&
    pendingUserAttachments.length === 0

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 px-2.5 py-2.5">
        {canGoHome ? (
          <Button variant="ghost" size="icon-sm" onClick={onBackHome} aria-label="Back to agents">
            <ChevronLeft />
          </Button>
        ) : null}

        <AgentIdentity agent={agent} agents={agents} onPickAgent={onPickAgent} />

        <div className="ml-auto flex items-center gap-1">
          {agentThreads.length > 0 ? (
            <AgentThreadHistoryPopover
              agentName={name}
              threads={agentThreads}
              onSelectThread={onSelectThread}
            />
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onNewChat} aria-label="New chat">
            <SquarePen />
          </Button>
        </div>
      </header>

      {showWelcome ? (
        <div className="flex min-h-0 flex-1 flex-col md:justify-center md:px-6 md:pb-[28vh] lg:pb-[30vh]">
          <Welcome agent={agent} />
          <div className="shrink-0">
            {sendError ? (
              <div className="mx-auto w-full max-w-3xl px-4 pb-1 md:px-0">
                <RunErrorMarker message={sendError} />
              </div>
            ) : null}

            <Composer
              onSend={onSend}
              disabled={composerDisabled}
              pending={composerPending}
              running={composerRunning}
              stopping={composerStopping}
              onStop={onStop}
              placeholder={composerPlaceholder}
              className="md:bg-transparent md:px-0 md:pt-0 md:pb-0"
              draft={composerDraft}
              draftAttachments={composerDraftAttachments}
              draftNonce={composerDraftNonce}
            />
          </div>
        </div>
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
                anchorCurrentTurn={anchorCurrentTurn}
                awaitingResponse={awaitingResponse}
                waitingLonger={waitingLonger}
                failedBeforeResponse={failedBeforeResponse}
                cancelledBeforeResponse={cancelledBeforeResponse}
                onRetry={onRetry}
                retrying={retrying}
                reconnecting={reconnecting}
              />
            )}
          </div>

          <div className="shrink-0">
            {sendError ? (
              <div className="mx-auto w-full max-w-3xl px-4 pb-1">
                <RunErrorMarker message={sendError} />
              </div>
            ) : null}

            <Composer
              onSend={onSend}
              disabled={composerDisabled}
              pending={composerPending}
              running={composerRunning}
              stopping={composerStopping}
              onStop={onStop}
              placeholder={composerPlaceholder}
              draft={composerDraft}
              draftAttachments={composerDraftAttachments}
              draftNonce={composerDraftNonce}
            />
          </div>
        </>
      )}
    </div>
  )
}

function AgentThreadHistoryPopover({
  agentName,
  threads,
  onSelectThread,
}: {
  agentName: string
  threads: readonly AgentThread[]
  onSelectThread: (threadId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const normalizedSearchTerm = searchTerm.trim().toLowerCase()
  const filteredThreads = useMemo(() => {
    if (!normalizedSearchTerm) return threads
    return threads.filter((thread) =>
      (thread.title?.trim() || "Untitled chat").toLowerCase().includes(normalizedSearchTerm)
    )
  }, [threads, normalizedSearchTerm])
  const groups = useMemo(() => groupThreadsByDate(filteredThreads), [filteredThreads])

  function selectThread(threadId: string) {
    setOpen(false)
    setSearchTerm("")
    onSelectThread(threadId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Recent chats">
          <History />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-1rem)] max-w-80 rounded-2xl p-2 shadow-xl"
        sideOffset={8}
      >
        <div className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground shadow-xs focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search threads..."
            aria-label={`Search ${agentName} threads`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="mt-2 border-t border-border/70 pt-2">
          <div className="max-h-[min(24rem,calc(100vh-8rem))] overflow-y-auto pr-1">
            {groups.length > 0 ? (
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.label}>
                    <p className="px-2 pb-1.5 text-xs font-semibold text-muted-foreground">
                      {historyGroupLabel(group.label)}
                    </p>
                    <div className="space-y-0.5">
                      {group.threads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => selectThread(thread.id)}
                          className="block w-full truncate rounded-lg px-2 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                        >
                          {thread.title?.trim() || "Untitled chat"}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                No matching threads.
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function historyGroupLabel(label: string): string {
  return label === "Previous 7 days" ? "This week" : label
}

function AgentIdentity({
  agent,
  agents,
  onPickAgent,
}: {
  agent: Agent | undefined
  agents: readonly Agent[]
  onPickAgent: (agentId: string) => void
}) {
  const name = agent?.name ?? "Agent"

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

function Welcome({ agent }: { agent: Agent | undefined }) {
  const name = agent?.name ?? "Agent"
  const description = agent?.description?.trim()

  return (
    <div className="flex flex-1 items-start justify-center px-4 pt-[32vh] text-center md:flex-none md:items-end md:px-0 md:pt-0 md:pb-8">
      <div className="inline-flex max-w-full items-center justify-center gap-3">
        <AgentAvatar name={name} className="size-9 text-sm md:size-10" />
        <p className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {name}
        </p>
        {description ? (
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
        ) : null}
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
