import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Spinner,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronLeft, History, SquarePen } from "lucide-react"
import { formatRelativeTime } from "../format"
import type { LiveRunState } from "../liveRun"
import type { Agent, AgentMessage, AgentThread } from "../types"
import { AgentAvatar } from "./AgentAvatar"
import { Composer } from "./Composer"
import { RunErrorMarker } from "./MessageView"
import { Transcript } from "./Transcript"

export interface ConversationPanelProps {
  readonly agent: Agent | undefined
  readonly messages: readonly AgentMessage[]
  readonly live: LiveRunState
  readonly messagesLoading: boolean
  readonly messagesError: string | null
  readonly streaming: boolean
  readonly pendingUserText?: string | null
  /** A run has been requested and we're waiting on it — show the thinking shimmer immediately. */
  readonly awaitingResponse: boolean
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
  readonly onSend: (text: string) => void
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
  readonly composerDraftNonce?: number
}

export function ConversationPanel({
  agent,
  messages,
  live,
  messagesLoading,
  messagesError,
  streaming,
  pendingUserText,
  awaitingResponse,
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
  composerDraftNonce,
}: ConversationPanelProps) {
  const name = agent?.name ?? "Agent"
  // Optimistic activity (a just-sent message or a live run) takes over the pane immediately, so the
  // brief durable-message load never flashes a centered "Loading…".
  const hasActivity = Boolean(pendingUserText) || live.parts.length > 0 || awaitingResponse
  const showWelcome =
    !messagesLoading &&
    !messagesError &&
    !hasActivity &&
    messages.length === 0 &&
    live.parts.length === 0 &&
    !pendingUserText

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 px-2.5 py-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(!canGoHome && "md:hidden")}
          onClick={onBackHome}
          aria-label="Back to agents"
        >
          <ChevronLeft />
        </Button>

        <AgentIdentity agent={agent} agents={agents} onPickAgent={onPickAgent} />

        <div className="ml-auto flex items-center gap-1">
          {streaming ? (
            <Badge variant="secondary" className="gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" />
              Streaming
            </Badge>
          ) : null}
          {agentThreads.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Recent chats">
                  <History />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Recent chats with {name}</DropdownMenuLabel>
                {agentThreads.map((thread) => (
                  <DropdownMenuItem
                    key={thread.id}
                    onSelect={() => onSelectThread(thread.id)}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {thread.title?.trim() || "Untitled chat"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onNewChat} aria-label="New chat">
            <SquarePen />
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {messagesLoading && !hasActivity ? (
          <div className="flex flex-1 items-center justify-center">
            <LoadingInline label="Loading conversation…" />
          </div>
        ) : messagesError && !hasActivity ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="max-w-md text-sm text-destructive">{messagesError}</p>
          </div>
        ) : showWelcome ? (
          <Welcome agent={agent} />
        ) : (
          <Transcript
            messages={messages}
            live={live}
            pendingUserText={pendingUserText}
            awaitingResponse={awaitingResponse}
            reconnecting={reconnecting}
          />
        )}
      </div>

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
        draftNonce={composerDraftNonce}
      />
    </div>
  )
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

  if (agents.length <= 1) {
    return (
      <div className="flex min-w-0 items-center gap-2.5 px-1.5">
        <AgentAvatar name={name} />
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
      </div>
    )
  }

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
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 pb-20 text-center">
      <AgentAvatar name={agent?.name ?? "Agent"} className="size-14 text-lg" />
      <div className="space-y-1.5">
        <p className="text-lg font-semibold text-foreground">{agent?.name ?? "Agent"}</p>
        {agent?.description ? (
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{agent.description}</p>
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
