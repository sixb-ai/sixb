import { Button, Input } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { LoaderCircle, Pencil, Search } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { groupThreadsByDate } from "../format"
import { filterThreadNavigation, THREAD_PAGE_SIZE } from "../threadNavigation"
import type { Agent, AgentThread } from "../types"

export interface ThreadSidebarProps {
  readonly agents: readonly Agent[]
  readonly threads: readonly AgentThread[]
  readonly agentsById: ReadonlyMap<string, Agent>
  readonly currentThreadId: string | null
  readonly selectedAgentId: string | null
  readonly threadsError?: string | null
  readonly totalThreads: number
  readonly hasMoreThreads: boolean
  readonly loadingMoreThreads: boolean
  readonly loadMoreThreadsError: boolean
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
  selectedAgentId,
  threadsError,
  totalThreads,
  hasMoreThreads,
  loadingMoreThreads,
  loadMoreThreadsError,
  onPickAgent,
  onStartNewThread,
  onSelectThread,
  onLoadMoreThreads,
  className,
}: ThreadSidebarProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const visibleThreads = useMemo(
    () => filterThreadNavigation(threads, agentsById, searchTerm),
    [agentsById, searchTerm, threads]
  )
  const threadGroups = useMemo(() => groupThreadsByDate(visibleThreads), [visibleThreads])
  const noMatches = searchTerm.trim().length > 0 && visibleThreads.length === 0

  return (
    <aside
      className={cn("min-h-0 flex-col border-r border-border/70 bg-background", className)}
      aria-label="Agent threads"
    >
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-foreground">
            Threads
          </h1>
          <NewChatButton onStartNewThread={onStartNewThread} />
        </div>

        <div className="relative mt-3">
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

        <section className="mt-3" aria-labelledby="agent-selector-heading">
          <h2
            id="agent-selector-heading"
            className="px-2 pb-1 text-[11px] font-medium text-muted-foreground"
          >
            Agents
          </h2>
          <div className="space-y-0.5">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onPickAgent(agent.id)}
                aria-current={agent.id === selectedAgentId ? "true" : undefined}
                className={cn(
                  "flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] font-medium outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
                  agent.id === selectedAgentId && "bg-muted text-foreground"
                )}
              >
                <span className="truncate">{agent.name}</span>
              </button>
            ))}
          </div>
        </section>
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
            {threadGroups.map((group) => (
              <ThreadSection key={group.label} label={group.label}>
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
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

function NewChatButton({ onStartNewThread }: { onStartNewThread: () => void }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={onStartNewThread}
      aria-label="New chat"
    >
      <Pencil />
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
  selected,
  onSelect,
}: {
  thread: AgentThread
  selected: boolean
  onSelect: (threadId: string) => void
}) {
  const title = thread.title?.trim() || "Untitled chat"
  const running = thread.activeRunId !== null

  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      title={title}
      aria-current={selected ? "page" : undefined}
      aria-label={running ? `${title}, running` : title}
      className={cn(
        "group relative flex w-full items-center rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted text-foreground"
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
        {title}
      </span>
      {running ? (
        <LoaderCircle
          className="ml-2 size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
    </button>
  )
}

function sectionId(label: string): string {
  return label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
}
