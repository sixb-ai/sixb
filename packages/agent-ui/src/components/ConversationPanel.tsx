import type { ModelReasoningLevel } from "@sixb/core/models"
import { Button, Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"
import type { LiveRunState } from "../liveRun"
import type {
  Agent,
  AgentContextEntryInput,
  AgentContextInput,
  AgentFileRef,
  AgentMessage,
  AgentThread,
  LanguageModel,
} from "../types"
import { AgentThreadSwitcher } from "./AgentThreadSwitcher"
import { Composer } from "./Composer"
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
  readonly onSend: (
    text: string,
    attachments: readonly AgentFileRef[],
    context: readonly AgentContextEntryInput[]
  ) => void
  readonly onNewChat: () => void
  readonly onSelectThread: (threadId: string) => void
  readonly composerDisabled: boolean
  readonly composerPending: boolean
  /** A run is in flight: the composer shows a stop button wired to {@link onStop}. */
  readonly composerRunning: boolean
  /** A stop has been requested and we're waiting for the run to end. */
  readonly composerStopping: boolean
  readonly onStop: () => void
  readonly models: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  readonly modelsLoading?: boolean
  readonly modelsError?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: ModelReasoningLevel) => void
  readonly composerPlaceholder?: string
  /** Text to restore into the composer (e.g. after a failed send), applied when the nonce changes. */
  readonly composerDraft?: string
  readonly composerDraftAttachments?: readonly AgentFileRef[]
  readonly composerDraftContext?: readonly AgentContextEntryInput[]
  readonly composerDraftNonce?: number
  readonly ambientContext?: readonly AgentContextInput[]
  readonly compact?: boolean
  readonly welcomeContent?: ReactNode
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
  currentThread,
  agentThreads,
  runningThreadCount,
  threadsError,
  hasMoreThreads,
  loadingMoreThreads,
  loadMoreThreadsError,
  onLoadMoreThreads,
  onSend,
  onNewChat,
  onSelectThread,
  composerDisabled,
  composerPending,
  composerRunning,
  composerStopping,
  onStop,
  models,
  selectedModel,
  selectedReasoning,
  modelsLoading,
  modelsError,
  onSelectModel,
  onSelectReasoning,
  composerPlaceholder,
  composerDraft,
  composerDraftAttachments,
  composerDraftContext,
  composerDraftNonce,
  ambientContext = [],
  compact = false,
  welcomeContent,
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
  const renderComposer = (wideClassName?: string) => (
    <Composer
      onSend={onSend}
      error={sendError ?? undefined}
      disabled={composerDisabled}
      pending={composerPending}
      running={composerRunning}
      stopping={composerStopping}
      onStop={onStop}
      models={models}
      selectedModel={selectedModel}
      selectedReasoning={selectedReasoning}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      onSelectModel={onSelectModel}
      onSelectReasoning={onSelectReasoning}
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
            threadsError={threadsError}
            hasMoreThreads={hasMoreThreads}
            loadingMoreThreads={loadingMoreThreads}
            loadMoreThreadsError={loadMoreThreadsError}
            onLoadMoreThreads={onLoadMoreThreads}
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
          <div className="ml-auto flex items-center gap-1">
            {headerActions}
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
              <div>{renderComposer()}</div>
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
            <Welcome agent={agent} compact={compact} content={welcomeContent} />
            <div className="shrink-0">
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

          <div className="shrink-0">{renderComposer()}</div>
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
