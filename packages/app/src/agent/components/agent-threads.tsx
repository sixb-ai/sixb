import {
  getAgentOptions,
  listAgentApprovalsQueryKey,
  listAgentThreadsQueryKey,
  useAgentActivityStream,
} from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleX, Search, SquarePen } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react"
import { PersonAvatar } from "../../artifacts/person-avatar"
import { useCurrentUser } from "../../session"
import { formatRelativeTime, groupThreadsByDate } from "../format"
import { useAgentThreadLists } from "../hooks/use-thread-lists"
import { useAgentMessages } from "../i18n"
import { personName, threadOwner } from "../sharing"
import { agentThreadTitle } from "../thread-navigation"
import type { AgentThread } from "../types"

export interface AgentThreadsProps {
  readonly onSelectThread: (threadId: string) => void
  readonly onNewThread: () => void
  /** Before the title, such as a way back to the app. */
  readonly headerActions?: ReactNode
  readonly className?: string
}

/**
 * Every thread the reader can open, on a page of its own: searched by title, filtered to
 * the ones shared with them or archived, grouped by when they last moved. Those where a call waits
 * for the reader come first.
 */
export function AgentThreads({
  onSelectThread,
  onNewThread,
  headerActions,
  className,
}: AgentThreadsProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.threads
  const user = useCurrentUser()
  const agent = useQuery({ ...getAgentOptions(), retry: false, staleTime: 5 * 60_000 })
  const agentName = agent.data?.name ?? "Agent"
  // A run starting or ending anywhere, and a call held or decided, reach the list through the
  // project's activity feed; poll only while it is away.
  const queryClient = useQueryClient()
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
  const refreshWaiting = () =>
    queryClient.invalidateQueries({ queryKey: listAgentApprovalsQueryKey() })
  const activity = useAgentActivityStream({
    onActivity: () => void refreshThreads(),
    onApprovalActivity: () => void refreshWaiting(),
    onSubscribed: () => {
      void refreshThreads()
      void refreshWaiting()
    },
  })
  const { threadsQuery, sharedThreadsQuery, threads, sharedThreads, waitingThreadIds } =
    useAgentThreadLists({
      refetchInterval: !activity.connected || activity.error ? 10_000 : false,
    })
  const [searchTerm, setSearchTerm] = useState("")
  const [filter, setFilter] = useState<"all" | "archived" | "shared">("all")
  const canShare = user !== null
  const sharedTotal = Math.max(sharedThreadsQuery.data?.pages[0]?.total ?? 0, sharedThreads.length)

  const query = searchTerm.trim().toLowerCase()
  const matching = useMemo(() => {
    const listed =
      filter === "archived"
        ? threads.filter((thread) => thread.status === "archived")
        : filter === "shared"
          ? sharedThreads
          : threads
    if (!query) return listed
    return listed.filter((thread) =>
      agentThreadTitle(thread, messages).toLowerCase().includes(query)
    )
  }, [filter, query, threads, sharedThreads, messages])

  // What waits on the reader comes first, theirs and what others shared alike.
  const waiting =
    filter === "archived"
      ? []
      : unique([...threads, ...sharedThreads]).filter(
          (thread) =>
            waitingThreadIds.has(thread.id) &&
            (!query || agentThreadTitle(thread, messages).toLowerCase().includes(query))
        )
  const waitingIds = new Set(waiting.map((thread) => thread.id))
  const groups = groupThreadsByDate(matching.filter((thread) => !waitingIds.has(thread.id)))
  const archivedCount = threads.filter((thread) => thread.status === "archived").length
  const sharedIds = new Set(sharedThreads.map((thread) => thread.id))
  // The list shown says its own paging; a failed read of either says so wherever it shows.
  const list = filter === "shared" ? sharedThreadsQuery : threadsQuery
  const errors = [
    filter !== "shared" && threadsQuery.isError ? agentMessages.chat.threadsLoadFailed : null,
    filter !== "archived" && sharedThreadsQuery.isError
      ? agentMessages.chat.sharedThreadsLoadFailed
      : null,
  ].filter((error): error is string => error !== null)
  const loading = list.isPending

  return (
    <div className={cn("min-h-0 overflow-y-auto", className)} onKeyDown={moveRowFocus}>
      <div className="mx-auto w-full max-w-[46rem] px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-14">
        <header className="flex min-h-11 items-center gap-2">
          {headerActions}
          <h1 className="min-w-0 flex-1 truncate text-[28px] leading-tight font-semibold tracking-[-0.02em] text-foreground">
            {messages.title}
          </h1>
          {/* On a phone the title keeps the room: the button is its icon. */}
          <Button
            type="button"
            onClick={onNewThread}
            aria-label={messages.new}
            className="size-9 gap-1.5 rounded-full p-0 sm:w-auto sm:px-4"
          >
            <SquarePen className="size-4" aria-hidden="true" />
            <span className="max-sm:sr-only">{messages.new}</span>
          </Button>
        </header>

        <div className="mt-6 flex h-11 items-center gap-2.5 rounded-xl bg-muted/70 px-3.5 text-muted-foreground transition-colors focus-within:bg-muted">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={messages.search}
            aria-label={messages.searchLabel(agentName)}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
          />
          {searchTerm ? (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              aria-label={messages.clearSearch}
              className="-mr-1.5 flex size-7 items-center justify-center rounded-full outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <CircleX className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {archivedCount > 0 || canShare ? (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={messages.filter}>
            <Filter
              label={messages.all}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            {canShare ? (
              <Filter
                label={messages.sharedFilter(sharedTotal)}
                active={filter === "shared"}
                onClick={() => setFilter("shared")}
              />
            ) : null}
            {archivedCount > 0 ? (
              <Filter
                label={messages.archivedFilter(archivedCount)}
                active={filter === "archived"}
                onClick={() => setFilter("archived")}
              />
            ) : null}
          </div>
        ) : null}

        <div className="mt-6">
          {waiting.length > 0 ? (
            <Section label={agentMessages.approvals.threadWaiting} waiting>
              {waiting.map((thread) => (
                <Row
                  key={thread.id}
                  thread={thread}
                  shared={sharedIds.has(thread.id)}
                  waiting
                  onSelect={onSelectThread}
                />
              ))}
            </Section>
          ) : null}

          {groups.map((group) => (
            <Section key={group.key} label={messages[group.key]}>
              {group.threads.map((thread) => (
                <Row
                  key={thread.id}
                  thread={thread}
                  shared={sharedIds.has(thread.id)}
                  waiting={false}
                  onSelect={onSelectThread}
                />
              ))}
            </Section>
          ))}

          {errors.map((error) => (
            <p key={error} role="alert" className="px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ))}
          {list.isFetchNextPageError ? (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {messages.loadMoreFailed}
            </p>
          ) : null}
          {list.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? messages.loading : messages.loadMore}
              </Button>
            </div>
          ) : null}
          {!loading && matching.length === 0 && waiting.length === 0 ? (
            <p className="px-3 py-16 text-center text-sm text-muted-foreground">
              {query ? messages.empty : filter === "shared" ? messages.sharedEmpty : messages.none}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Filter({
  label,
  active,
  onClick,
}: {
  readonly label: string
  readonly active: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-8 rounded-full px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
        active
          ? "bg-foreground text-background"
          : "bg-muted/70 text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

function Section({
  label,
  waiting = false,
  children,
}: {
  readonly label: string
  /** The threads waiting for the reader: the heading carries the amber mark. */
  readonly waiting?: boolean
  readonly children: ReactNode
}) {
  return (
    <section className="mt-6 first:mt-0" aria-label={label}>
      <h2
        className={cn(
          "flex items-center gap-1.5 px-3 pb-1.5 text-[13px]",
          waiting ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
        )}
      >
        {waiting ? (
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        ) : null}
        {label}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/**
 * One thread: its title, then whether the agent is at work in it, how many messages it holds and
 * whose it is when someone shared it; when it last moved, at the end. Its section says when it
 * waits for the reader.
 */
function Row({
  thread,
  shared,
  waiting,
  onSelect,
}: {
  readonly thread: AgentThread
  /** Someone else's: the row names its owner. */
  readonly shared: boolean
  /** A call in it waits for the reader's approval. */
  readonly waiting: boolean
  readonly onSelect: (threadId: string) => void
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.threads
  const locale = useLocale()
  const title = agentThreadTitle(thread, messages)
  const when =
    thread.status === "archived"
      ? messages.archived
      : formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt, locale, agentMessages.time)
  const owner = shared ? personName(threadOwner(thread)) : null
  const detail = [messages.messageCount(thread.messageCount), owner].filter(Boolean).join(" · ")
  const working = thread.activeRunId !== null

  return (
    <button
      type="button"
      data-thread-option=""
      onClick={() => onSelect(thread.id)}
      data-thread-working={working ? "" : undefined}
      aria-label={[
        title,
        waiting ? agentMessages.approvals.threadWaiting : working ? messages.working : null,
        detail,
        when,
      ]
        .filter(Boolean)
        .join(", ")}
      className="group flex min-h-16 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      {owner ? <PersonAvatar name={owner} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
          {working ? (
            <>
              <span className="inline-flex items-center gap-1.5 align-middle">
                <span
                  className="size-1.5 rounded-full bg-sky-500 motion-safe:animate-pulse"
                  aria-hidden="true"
                />
                {messages.working}
              </span>
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          {detail}
        </span>
      </span>
      {when ? (
        <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">{when}</span>
      ) : null}
    </button>
  )
}

function unique(threads: readonly AgentThread[]): readonly AgentThread[] {
  return [...new Map(threads.map((thread) => [thread.id, thread])).values()]
}

/** Up and down move between the rows, as in a list. */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-thread-option]")]
  if (options.length === 0) return
  const index = options.indexOf(document.activeElement as HTMLElement)
  const delta = event.key === "ArrowDown" ? 1 : -1
  const next = index < 0 ? (delta > 0 ? 0 : options.length - 1) : index + delta
  options[(next + options.length) % options.length]?.focus()
  event.preventDefault()
}
