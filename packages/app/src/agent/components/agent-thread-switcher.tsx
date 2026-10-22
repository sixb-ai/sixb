import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { History, LoaderCircle, Plus, Search, X } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react"
import { formatRelativeTime, groupThreadsByDate } from "../format"
import { useAgentMessages } from "../i18n"
import { personName, threadOwner } from "../sharing"
import { agentThreadTitle } from "../thread-navigation"
import type { AgentThread } from "../types"
import { PersonAvatar } from "./person-avatar"

/** The conversations other people shared with the reader, paged like their own. */
export interface SharedThreadList {
  readonly threads: readonly AgentThread[]
  /** All of them, beyond the pages read so far. */
  readonly total: number
  readonly error?: string | null
  readonly hasMore?: boolean
  readonly loadingMore?: boolean
  readonly loadMoreError?: boolean
  readonly onLoadMore?: () => void
}

const NO_SHARED_THREADS: SharedThreadList = { threads: [], total: 0 }

export interface AgentThreadSwitcherProps {
  readonly agentName: string
  readonly currentThread: AgentThread | null
  readonly threads: readonly AgentThread[]
  /**
   * Conversations other people shared with the reader, listed apart from their own. Omitted
   * where nothing can be shared, without a signed-in user.
   */
  readonly sharedThreads?: SharedThreadList
  readonly runningThreadCount?: number
  readonly threadsError?: string | null
  readonly hasMoreThreads?: boolean
  readonly loadingMoreThreads?: boolean
  readonly loadMoreThreadsError?: boolean
  readonly onLoadMoreThreads?: () => void
  readonly onSelectThread: (threadId: string) => void
  readonly onNewThread?: () => void
}

export function AgentThreadSwitcher({
  agentName,
  currentThread,
  threads,
  sharedThreads,
  runningThreadCount = 0,
  threadsError,
  hasMoreThreads,
  loadingMoreThreads,
  loadMoreThreadsError,
  onLoadMoreThreads,
  onSelectThread,
  onNewThread,
}: AgentThreadSwitcherProps) {
  const messages = useAgentMessages().threads
  const shared = sharedThreads ?? NO_SHARED_THREADS
  const canShare = sharedThreads !== undefined
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [filter, setFilter] = useState<"all" | "archived" | "shared">("all")
  const [snapshot, setSnapshot] = useState<{
    readonly own: readonly string[]
    readonly shared: readonly string[]
  }>({ own: [], shared: [] })
  const allThreads = useMemo(() => uniqueThreads(currentThread, threads), [currentThread, threads])

  // While open, rows keep the order they had when it opened, whatever activity moves meanwhile.
  const shownThreads = open ? inSnapshotOrder(allThreads, snapshot.own) : allThreads
  const shownShared = open ? inSnapshotOrder(shared.threads, snapshot.shared) : shared.threads
  const normalizedSearchTerm = searchTerm.trim().toLowerCase()
  const matchingThreads = useMemo(() => {
    const byState =
      filter === "archived"
        ? shownThreads.filter((thread) => thread.status === "archived")
        : filter === "shared"
          ? shownShared
          : shownThreads
    if (!normalizedSearchTerm) return byState
    return byState.filter((thread) =>
      agentThreadTitle(thread, messages).toLowerCase().includes(normalizedSearchTerm)
    )
  }, [filter, normalizedSearchTerm, shownThreads, shownShared, messages])
  const matchingIds = new Set(matchingThreads.map((thread) => thread.id))
  const currentVisible = currentThread && matchingIds.has(currentThread.id) ? currentThread : null
  const groups = groupThreadsByDate(
    matchingThreads.filter((thread) => thread.id !== currentVisible?.id)
  )
  const archivedCount = shownThreads.filter((thread) => thread.status === "archived").length
  const currentTitle = agentThreadTitle(currentThread, messages)
  const historyLabel =
    runningThreadCount > 0
      ? messages.runningHistory(runningThreadCount, currentTitle)
      : messages.historyCurrent(currentTitle)

  // The list shown says its own errors and pages.
  const list =
    filter === "shared"
      ? {
          error: null,
          loadMoreError: shared.loadMoreError,
          hasMore: shared.hasMore,
          loadingMore: shared.loadingMore,
          onLoadMore: shared.onLoadMore,
        }
      : {
          error: threadsError,
          loadMoreError: loadMoreThreadsError,
          hasMore: hasMoreThreads,
          loadingMore: loadingMoreThreads,
          onLoadMore: onLoadMoreThreads,
        }

  function updateOpen(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setSnapshot({
        own: allThreads.map((thread) => thread.id),
        shared: shared.threads.map((thread) => thread.id),
      })
    } else {
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
          size="icon-lg"
          aria-label={historyLabel}
          title={runningThreadCount > 0 ? messages.running(runningThreadCount) : messages.history}
          className="[&_svg]:size-5"
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
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onKeyDown={moveThreadFocus}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(calc(100vw-2rem),40rem)] sm:max-w-[40rem] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-2xl sm:border"
      >
        <DialogDescription className="sr-only">{messages.description(agentName)}</DialogDescription>

        <div className="flex h-16 shrink-0 items-center gap-3 px-4 sm:px-5">
          <DialogTitle className="text-lg">{messages.title}</DialogTitle>
          {onNewThread ? (
            <Button type="button" size="sm" className="ml-auto gap-1.5" onClick={startThread}>
              <Plus />
              {messages.new}
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={messages.close}
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
              placeholder={messages.search}
              aria-label={messages.searchLabel(agentName)}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {archivedCount > 0 || canShare ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label={messages.filter}>
              <FilterButton
                label={messages.all}
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              {canShare ? (
                <FilterButton
                  label={messages.sharedFilter(Math.max(shared.total, shared.threads.length))}
                  active={filter === "shared"}
                  onClick={() => setFilter("shared")}
                />
              ) : null}
              {archivedCount > 0 ? (
                <FilterButton
                  label={messages.archivedFilter(archivedCount)}
                  active={filter === "archived"}
                  onClick={() => setFilter("archived")}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-h-[min(68dvh,36rem)] sm:flex-none sm:px-4 sm:pb-4">
          {currentVisible ? (
            <ThreadSwitcherSection label={messages.current}>
              <ThreadSwitcherRow
                thread={currentVisible}
                selected
                shared={filter === "shared"}
                onSelect={selectThread}
              />
            </ThreadSwitcherSection>
          ) : null}

          {groups.map((group) => (
            <ThreadSwitcherSection key={group.key} label={messages[group.key]}>
              {group.threads.map((thread) => (
                <ThreadSwitcherRow
                  key={thread.id}
                  thread={thread}
                  selected={thread.id === currentThread?.id}
                  shared={filter === "shared"}
                  onSelect={selectThread}
                />
              ))}
            </ThreadSwitcherSection>
          ))}

          {list.error ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {list.error}
            </p>
          ) : null}
          {shared.error && filter !== "archived" ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {shared.error}
            </p>
          ) : null}
          {list.loadMoreError ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {messages.loadMoreFailed}
            </p>
          ) : null}
          {list.hasMore && list.onLoadMore ? (
            <Button
              variant="outline"
              size="sm"
              disabled={list.loadingMore}
              onClick={list.onLoadMore}
            >
              {list.loadingMore ? messages.loading : messages.loadMore}
            </Button>
          ) : null}
          {matchingThreads.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              {filter === "shared" && !normalizedSearchTerm ? messages.sharedEmpty : messages.empty}
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
  shared = false,
  onSelect,
}: {
  thread: AgentThread
  selected: boolean
  /** Someone else's conversation: the row names its owner. */
  shared?: boolean
  onSelect: (threadId: string) => void
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.threads
  const locale = useLocale()
  const title = agentThreadTitle(thread, messages)
  const relativeTime = formatRelativeTime(
    thread.lastMessageAt ?? thread.updatedAt,
    locale,
    agentMessages.time
  )
  const meta = thread.status === "archived" ? messages.archived : relativeTime
  const owner = personName(threadOwner(thread))

  return (
    <button
      type="button"
      data-thread-option=""
      onClick={() => onSelect(thread.id)}
      aria-current={selected ? "page" : undefined}
      aria-label={[title, selected ? messages.currentState : null, meta || null]
        .filter(Boolean)
        .join(", ")}
      className={cn(
        "group flex min-h-14 w-full items-center rounded-xl px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30",
        selected && "bg-muted/70"
      )}
    >
      {shared ? <PersonAvatar name={owner} className="mr-3" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {shared
            ? messages.sharedBy(owner, thread.messageCount)
            : messages.messages(thread.messageCount)}
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

/** Threads in the order of a snapshot of their ids, with any new ones after it. */
function inSnapshotOrder(
  threads: readonly AgentThread[],
  snapshot: readonly string[]
): readonly AgentThread[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const known = new Set(snapshot)

  return [
    ...snapshot.flatMap((threadId) => {
      const thread = byId.get(threadId)
      return thread ? [thread] : []
    }),
    ...threads.filter((thread) => !known.has(thread.id)),
  ]
}

function uniqueThreads(
  currentThread: AgentThread | null,
  threads: readonly AgentThread[]
): readonly AgentThread[] {
  const byId = new Map<string, AgentThread>()
  for (const thread of threads) byId.set(thread.id, thread)
  if (currentThread) byId.set(currentThread.id, currentThread)
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
