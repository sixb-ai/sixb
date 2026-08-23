import {
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft, LoaderCircle, Pencil, Search } from "lucide-react"
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
  readonly onExit?: () => void
  readonly exitLabel?: string
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
  onExit,
  exitLabel = "Back to app",
  className,
}: ThreadSidebarProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const threadGroups = useMemo(() => groupThreadsByDate(threads), [threads])
  const searchGroups = useMemo(
    () =>
      searchOpen ? groupThreadsByDate(filterThreadNavigation(threads, agentsById, searchTerm)) : [],
    [agentsById, searchOpen, searchTerm, threads]
  )

  const updateSearchOpen = (open: boolean) => {
    setSearchOpen(open)
    if (!open) {
      setSearchTerm("")
    }
  }

  const selectSearchResult = (threadId: string) => {
    updateSearchOpen(false)
    onSelectThread(threadId)
  }

  return (
    <aside
      className={cn("min-h-0 flex-col border-r border-border/70 bg-background", className)}
      aria-label="Agent threads"
    >
      <div className="shrink-0 px-2 pt-2 pb-2">
        <nav className="flex flex-col gap-0.5" aria-label="Agent workspace actions">
          {onExit ? (
            <div className="mb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onExit}
                className="h-9 w-full justify-start gap-3 px-2.5 text-[13px] font-semibold text-foreground focus-visible:border-transparent focus-visible:ring-0 focus-visible:underline focus-visible:underline-offset-4"
              >
                <ArrowLeft aria-hidden="true" />
                {exitLabel}
              </Button>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onStartNewThread}
            className="h-9 w-full justify-start gap-3 px-2.5 text-[13px] font-medium text-foreground focus-visible:border-transparent focus-visible:ring-0 focus-visible:underline focus-visible:underline-offset-4"
          >
            <Pencil aria-hidden="true" />
            New thread
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSearchOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            className="h-9 w-full justify-start gap-3 px-2.5 text-[13px] font-medium text-foreground focus-visible:border-transparent focus-visible:ring-0 focus-visible:underline focus-visible:underline-offset-4"
          >
            <Search aria-hidden="true" />
            Search
          </Button>
        </nav>

        <CommandDialog
          open={searchOpen}
          onOpenChange={updateSearchOpen}
          title="Search threads"
          description="Search threads by title or agent."
          shouldFilter={false}
          className="max-w-xl"
        >
          <CommandInput
            autoFocus
            value={searchTerm}
            onValueChange={setSearchTerm}
            placeholder="Search threads..."
            aria-label="Search agent threads"
          />
          <CommandList className="max-h-[min(28rem,70vh)] p-2">
            <CommandEmpty>
              {threadsError
                ? "Could not load threads."
                : threads.length === 0
                  ? "No threads yet."
                  : "No matching threads."}
            </CommandEmpty>
            {searchGroups.map((group) => (
              <CommandGroup key={group.label} heading={group.label}>
                {group.threads.map((thread) => {
                  const title = thread.title?.trim() || "Untitled chat"
                  const agentName = agentsById.get(thread.agentId)?.name ?? thread.agentId

                  return (
                    <CommandItem
                      key={thread.id}
                      value={thread.id}
                      onSelect={() => selectSearchResult(thread.id)}
                      aria-label={`${title}, ${agentName}`}
                      className="items-center rounded-lg px-3 py-2.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {agentName}
                        </span>
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </CommandDialog>

        {agents.length > 1 ? (
          <section className="mt-4" aria-labelledby="agent-selector-heading">
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
                  aria-current={
                    currentThreadId === null && agent.id === selectedAgentId ? "true" : undefined
                  }
                  className={cn(
                    "flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] font-medium outline-none transition-colors hover:bg-muted/70 focus-visible:underline focus-visible:underline-offset-2",
                    currentThreadId === null &&
                      agent.id === selectedAgentId &&
                      "bg-muted text-foreground"
                  )}
                >
                  <span className="truncate">{agent.name}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <nav
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2.5"
        aria-label="Threads"
      >
        {threadsError ? (
          <p className="px-2 py-4 text-sm text-destructive">{threadsError}</p>
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
        "group relative flex w-full items-center rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:underline focus-visible:underline-offset-2",
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
