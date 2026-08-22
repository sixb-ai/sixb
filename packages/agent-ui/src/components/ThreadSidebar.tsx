import { Button, Input } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { LoaderCircle, Search, SquarePen } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { formatRelativeTime, groupThreadsByDate } from "../format"
import { THREAD_PAGE_SIZE, threadNavigationSections } from "../threadNavigation"
import type { Agent, AgentThread } from "../types"
import { AgentAvatar } from "./AgentAvatar"

export interface ThreadSidebarProps {
  readonly agents: readonly Agent[]
  readonly threads: readonly AgentThread[]
  readonly agentsById: ReadonlyMap<string, Agent>
  readonly currentThreadId: string | null
  readonly threadsError?: string | null
  readonly totalThreads: number
  readonly hasMoreThreads: boolean
  readonly loadingMoreThreads: boolean
  readonly loadMoreThreadsError: boolean
  readonly activityConnected: boolean
  readonly onPickAgent: (agentId: string) => void
  readonly onStartNewThread: () => void
  readonly onSelectThread: (threadId: string) => void
  readonly onLoadMoreThreads: () => void
  readonly className?: string
}

/** Persistent command rail for starting and switching Agent conversations. */
export function ThreadSidebar({
  agents,
  threads,
  agentsById,
  currentThreadId,
  threadsError,
  totalThreads,
  hasMoreThreads,
  loadingMoreThreads,
  loadMoreThreadsError,
  activityConnected,
  onPickAgent,
  onStartNewThread,
  onSelectThread,
  onLoadMoreThreads,
  className,
}: ThreadSidebarProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const sections = useMemo(
    () => threadNavigationSections(threads, agentsById, searchTerm),
    [agentsById, searchTerm, threads]
  )
  const recentGroups = useMemo(() => groupThreadsByDate(sections.recent), [sections.recent])
  const runningCount = threads.filter((thread) => thread.activeRunId !== null).length
  const showAgentName = agents.length > 1
  const noMatches =
    searchTerm.trim().length > 0 && sections.running.length + sections.recent.length === 0

  return (
    <aside
      className={cn("min-h-0 flex-col border-r border-border/70 bg-background", className)}
      aria-label="Agent threads"
    >
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              Threads
            </h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  activityConnected ? "bg-emerald-500" : "bg-amber-500"
                )}
                aria-hidden="true"
              />
              {runningCount > 0
                ? `${runningCount} ${runningCount === 1 ? "thread" : "threads"} running`
                : activityConnected
                  ? "Live · All idle"
                  : "Status reconnecting…"}
            </p>
          </div>
          <NewChatButton
            agents={agents}
            onPickAgent={onPickAgent}
            onStartNewThread={onStartNewThread}
          />
        </div>

        <div className="relative mt-2.5">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/80"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search threads"
            aria-label="Search agent threads"
            className="h-8 rounded-lg border-transparent bg-muted/60 pr-2 pl-8 text-xs shadow-none transition-colors hover:bg-muted focus-visible:border-input focus-visible:bg-background"
          />
        </div>
      </div>

      <nav
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2.5"
        aria-label="Threads"
      >
        {threadsError ? (
          <p className="px-2 py-4 text-sm text-destructive">{threadsError}</p>
        ) : noMatches ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No matching threads.
          </p>
        ) : threads.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-sm font-medium text-foreground">No threads yet</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Start a chat and it will stay here while the agent works.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sections.running.length > 0 ? (
              <ThreadSection label="Running">
                {sections.running.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    agent={agentsById.get(thread.agentId)}
                    showAgentName={showAgentName}
                    selected={thread.id === currentThreadId}
                    onSelect={onSelectThread}
                  />
                ))}
              </ThreadSection>
            ) : null}

            {recentGroups.map((group) => (
              <ThreadSection key={group.label} label={group.label}>
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    agent={agentsById.get(thread.agentId)}
                    showAgentName={showAgentName}
                    selected={thread.id === currentThreadId}
                    onSelect={onSelectThread}
                  />
                ))}
              </ThreadSection>
            ))}
          </div>
        )}
      </nav>

      {!threadsError &&
      threads.length > 0 &&
      (hasMoreThreads || loadingMoreThreads || loadMoreThreadsError) ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {threads.length} of {totalThreads}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            disabled={loadingMoreThreads}
            onClick={onLoadMoreThreads}
          >
            {loadingMoreThreads ? (
              <>
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Loading
              </>
            ) : loadMoreThreadsError ? (
              "Try again"
            ) : (
              `Load ${Math.min(THREAD_PAGE_SIZE, Math.max(0, totalThreads - threads.length))} more`
            )}
          </Button>
        </div>
      ) : null}
    </aside>
  )
}

function NewChatButton({
  agents,
  onPickAgent,
  onStartNewThread,
}: {
  agents: readonly Agent[]
  onPickAgent: (agentId: string) => void
  onStartNewThread: () => void
}) {
  const soleAgent = agents.length === 1 ? agents[0] : undefined

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 gap-1.5 px-2 text-xs"
      onClick={() => (soleAgent ? onPickAgent(soleAgent.id) : onStartNewThread())}
      aria-label="New chat"
    >
      <SquarePen className="size-3.5" />
      New
    </Button>
  )
}

function ThreadSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`agent-threads-${sectionId(label)}`}>
      <h2
        id={`agent-threads-${sectionId(label)}`}
        className="px-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function ThreadRow({
  thread,
  agent,
  showAgentName,
  selected,
  onSelect,
}: {
  thread: AgentThread
  agent: Agent | undefined
  showAgentName: boolean
  selected: boolean
  onSelect: (threadId: string) => void
}) {
  const running = thread.activeRunId !== null
  const title = thread.title?.trim() || "Untitled chat"
  const agentName = agent?.name ?? thread.agentId

  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      title={title}
      aria-current={selected ? "page" : undefined}
      aria-label={`${title}, ${agentName}${running ? ", running" : ""}`}
      className={cn(
        "group relative flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted text-foreground"
      )}
    >
      {showAgentName ? (
        <AgentAvatar name={agentName} className="size-5 text-[8px] text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5 text-foreground">
          {title}
        </span>
        <span className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
          <span className="shrink-0">
            {running ? "Working" : formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt)}
          </span>
        </span>
      </span>
      {running ? (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin text-emerald-600 motion-reduce:animate-none dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : null}
    </button>
  )
}

function sectionId(label: string): string {
  return label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
}
