import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { History, LoaderCircle, Plus, Search, X } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react"
import { formatRelativeTime, groupThreadsByDate } from "../format"
import { agentThreadTitle } from "../threadNavigation"
import type { AgentThread } from "../types"

export interface AgentThreadSwitcherProps {
  readonly agentName: string
  readonly currentThread: AgentThread | null
  readonly threads: readonly AgentThread[]
  readonly runningThreadCount?: number
  readonly onSelectThread: (threadId: string) => void
  readonly onNewThread?: () => void
  readonly triggerLabel?: string
}

export function AgentThreadSwitcher({
  agentName,
  currentThread,
  threads,
  runningThreadCount = 0,
  onSelectThread,
  onNewThread,
  triggerLabel,
}: AgentThreadSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [filter, setFilter] = useState<"all" | "archived">("all")
  const [snapshotIds, setSnapshotIds] = useState<readonly string[]>([])
  const allThreads = useMemo(() => uniqueThreads(currentThread, threads), [currentThread, threads])
  const allThreadsById = new Map(allThreads.map((thread) => [thread.id, thread]))
  const shownThreads = open
    ? snapshotIds.flatMap((threadId) => {
        const thread = allThreadsById.get(threadId)
        return thread ? [thread] : []
      })
    : allThreads
  const normalizedSearchTerm = searchTerm.trim().toLowerCase()
  const matchingThreads = useMemo(() => {
    const byState =
      filter === "archived"
        ? shownThreads.filter((thread) => thread.status === "archived")
        : shownThreads
    if (!normalizedSearchTerm) return byState
    return byState.filter((thread) =>
      agentThreadTitle(thread).toLowerCase().includes(normalizedSearchTerm)
    )
  }, [filter, normalizedSearchTerm, shownThreads])
  const matchingIds = new Set(matchingThreads.map((thread) => thread.id))
  const currentVisible = currentThread && matchingIds.has(currentThread.id) ? currentThread : null
  const groups = groupThreadsByDate(
    matchingThreads.filter((thread) => thread.id !== currentVisible?.id)
  )
  const archivedCount = shownThreads.filter((thread) => thread.status === "archived").length
  const showTriggerText = Boolean(triggerLabel)
  const historyLabel =
    runningThreadCount > 0
      ? `${runningThreadCount} ${runningThreadCount === 1 ? "thread" : "threads"} running. Open thread history. Current: ${agentThreadTitle(currentThread)}`
      : `Thread history. Current: ${agentThreadTitle(currentThread)}`

  function updateOpen(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setSnapshotIds(allThreads.map((thread) => thread.id))
    else {
      setSearchTerm("")
      setFilter("all")
    }
  }

  function selectThread(threadId: string) {
    updateOpen(false)
    onSelectThread(threadId)
  }

  function startThread() {
    updateOpen(false)
    onNewThread?.()
  }

  return (
    <Dialog open={open} onOpenChange={updateOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={showTriggerText ? "sm" : "icon-lg"}
          aria-label={historyLabel}
          title={runningThreadCount > 0 ? `${runningThreadCount} running` : "Thread history"}
          className={cn(showTriggerText && "gap-2 px-3", "[&_svg]:size-5")}
        >
          {runningThreadCount > 0 ? (
            <span
              data-active-thread-count={runningThreadCount}
              aria-hidden="true"
              className="relative grid size-5 shrink-0 place-items-center"
            >
              <LoaderCircle className="absolute inset-0 size-5 animate-spin [animation-duration:1.4s] motion-reduce:animate-none" />
              <span className="text-[8px] font-semibold leading-none tabular-nums">
                {runningThreadCount > 99 ? "99+" : runningThreadCount}
              </span>
            </span>
          ) : (
            <History />
          )}
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onKeyDown={moveThreadFocus}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(calc(100vw-2rem),40rem)] sm:max-w-[40rem] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-2xl sm:border"
      >
        <DialogDescription className="sr-only">
          Search and switch between conversations with {agentName}.
        </DialogDescription>

        <div className="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
          <DialogTitle className="text-lg">Threads</DialogTitle>
          {onNewThread ? (
            <Button type="button" size="sm" className="ml-auto gap-1.5" onClick={startThread}>
              <Plus />
              New thread
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close thread history"
              className={cn(
                !onNewThread && "ml-auto",
                "text-muted-foreground hover:text-foreground"
              )}
            >
              <X />
            </Button>
          </DialogClose>
        </div>

        <div className="shrink-0 border-border/60 border-b px-4 pb-3 sm:px-5">
          <div className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-muted/20 px-3 text-muted-foreground transition-colors focus-within:border-foreground/25 focus-within:bg-background">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              autoFocus
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search threads"
              aria-label={`Search ${agentName} threads`}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {archivedCount > 0 ? (
            <div className="mt-2.5 flex gap-1.5" aria-label="Filter threads">
              <FilterButton
                label="All"
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              {archivedCount > 0 ? (
                <FilterButton
                  label={`Archived ${archivedCount}`}
                  active={filter === "archived"}
                  onClick={() => setFilter("archived")}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-h-[min(68dvh,36rem)] sm:flex-none sm:px-4 sm:pb-4">
          {currentVisible ? (
            <ThreadSwitcherSection label="Current">
              <ThreadSwitcherRow thread={currentVisible} selected onSelect={selectThread} />
            </ThreadSwitcherSection>
          ) : null}

          {groups.map((group) => (
            <ThreadSwitcherSection key={group.label} label={historyGroupLabel(group.label)}>
              {group.threads.map((thread) => (
                <ThreadSwitcherRow
                  key={thread.id}
                  thread={thread}
                  selected={thread.id === currentThread?.id}
                  onSelect={selectThread}
                />
              ))}
            </ThreadSwitcherSection>
          ))}

          {matchingThreads.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              No matching threads.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
        active
          ? "bg-foreground text-background"
          : "bg-muted/70 text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

function ThreadSwitcherSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-4 first:mt-0" aria-label={label}>
      <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function ThreadSwitcherRow({
  thread,
  selected,
  onSelect,
}: {
  thread: AgentThread
  selected: boolean
  onSelect: (threadId: string) => void
}) {
  const title = agentThreadTitle(thread)
  const relativeTime = formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt)
  const meta = thread.status === "archived" ? "Archived" : relativeTime

  return (
    <button
      type="button"
      data-thread-option=""
      onClick={() => onSelect(thread.id)}
      aria-current={selected ? "page" : undefined}
      aria-label={[title, selected ? "current" : null, meta || null].filter(Boolean).join(", ")}
      className={cn(
        "group flex min-h-14 w-full items-center rounded-xl px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30",
        selected && "bg-muted/70"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
        </span>
      </span>
      {meta ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </button>
  )
}

function uniqueThreads(
  currentThread: AgentThread | null,
  threads: readonly AgentThread[]
): readonly AgentThread[] {
  const byId = new Map<string, AgentThread>()
  if (currentThread) byId.set(currentThread.id, currentThread)
  for (const thread of threads) byId.set(thread.id, thread)
  return [...byId.values()]
}

function moveThreadFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  if (event.target instanceof HTMLInputElement) return
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-thread-option]")]
  if (options.length === 0) return
  const currentIndex = options.indexOf(document.activeElement as HTMLElement)
  const delta = event.key === "ArrowDown" ? 1 : -1
  const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : options.length - 1) : currentIndex + delta
  options[(nextIndex + options.length) % options.length]?.focus()
  event.preventDefault()
}

function historyGroupLabel(label: string): string {
  return label === "Previous 7 days" ? "This week" : label
}
