import type { ListAgentMemoryRevisionsResponse } from "@sixb/client"
import {
  getAgentMemoryOptions,
  listAgentMemoryRevisionsOptions,
  saveAgentMemoryMutation,
} from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, History, Loader2, RotateCcw } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { threadPathFromLink } from "../../agent/thread-navigation"
import { useCurrentUser } from "../../session"
import { notify } from "../section-page"
import { apiErrorMessage, Panel, PanelEmpty, PanelSkeleton, Pill, useFormat } from "../section-ui"
import {
  ADDED,
  isMemoryNote,
  type MemoryDiffLine,
  type MemoryRepo,
  type MemoryRepoView,
  memoryLineDiff,
  memoryLinkName,
  memoryLinkPath,
  noteTitle,
  refreshMemory,
} from "./memory-files"
import { useSettingsMessages } from "./messages"

type Revision = ListAgentMemoryRevisionsResponse["revisions"][number]
type Change = Revision["changes"][number]
type MemoryMessages = ReturnType<typeof useSettingsMessages>["memory"]

const PAGE_SIZE = 20

/**
 * Every save to the repo, newest first and by day, beside what the one chosen did to each file: the
 * newest at first, so the page opens on the latest change.
 */
export function MemoryHistory({
  repo,
  view,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
}) {
  const messages = useSettingsMessages().memory
  const day = useDayLabel()
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [chosen, setChosen] = useState<number | null>(null)
  const historyQuery = useQuery({
    ...listAgentMemoryRevisionsOptions({ path: { repo }, query: { limit: String(limit) } }),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const revisions = historyQuery.data?.revisions ?? []
  const open = revisions.find((revision) => revision.revision === chosen) ?? revisions[0] ?? null
  const days = useMemo(() => {
    const groups: { label: string; revisions: Revision[] }[] = []
    for (const revision of revisions) {
      const label = day(revision.createdAt)
      const last = groups.at(-1)
      if (last?.label === label) last.revisions.push(revision)
      else groups.push({ label, revisions: [revision] })
    }
    return groups
  }, [revisions, day])

  if (historyQuery.isPending) {
    return (
      <Panel>
        <PanelSkeleton rows={4} />
      </Panel>
    )
  }
  if (historyQuery.isError) {
    return (
      <Panel>
        <PanelEmpty
          tone="error"
          icon={History}
          title={messages.unavailable}
          description={apiErrorMessage(historyQuery.error, messages.historyFailed)}
        />
      </Panel>
    )
  }
  if (days.length === 0) {
    return (
      <Panel>
        <PanelEmpty
          icon={History}
          title={messages.historyEmpty}
          description={messages.historyEmptyDescription}
        />
      </Panel>
    )
  }

  return (
    <div className="grid min-w-0 items-start gap-8 md:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col">
        {days.map((group, index) => (
          <section key={group.label} aria-label={group.label} className={cn(index > 0 && "mt-6")}>
            <h3 className="mb-1.5 pl-7 text-xs font-medium text-muted-foreground">{group.label}</h3>
            {/* The line the day's changes hang from, through the middle of their dots. */}
            <ol className="relative before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-px before:bg-border">
              {group.revisions.map((revision) => (
                <RevisionRow
                  key={revision.revision}
                  revision={revision}
                  view={view}
                  current={revision.revision === open?.revision}
                  onOpen={() => setChosen(revision.revision)}
                />
              ))}
            </ol>
          </section>
        ))}
        {historyQuery.data?.hasMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 self-start"
            disabled={historyQuery.isFetching}
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            {historyQuery.isFetching ? <Loader2 className="animate-spin" /> : null}
            {messages.showMore}
          </Button>
        ) : null}
        <p className="mt-6 pl-7 text-xs text-muted-foreground/80">{messages.historyKept}</p>
      </div>
      {open ? (
        <ChangeDetail key={open.revision} repo={repo} view={view} revision={open} />
      ) : (
        <p className="text-sm text-muted-foreground">{messages.chooseChange}</p>
      )}
    </div>
  )
}

/** "Today", "Yesterday", or the day with its weekday, and its year only when past. */
function useDayLabel(): (timestamp: string) => string {
  const locale = useLocale()
  const messages = useSettingsMessages().memory
  return useMemo(() => {
    const startOf = (date: Date) =>
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    return (timestamp: string) => {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return timestamp
      const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000)
      if (days === 0) return messages.today
      if (days === 1) return messages.yesterday
      return date.toLocaleDateString(locale, {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
      })
    }
  }, [locale, messages])
}

/** How a change was made and by whom: in a conversation or by hand, by this person or another. */
function useChangeOrigin(): (revision: Revision) => {
  readonly label: string
  readonly conversation: string | null
} {
  const messages = useSettingsMessages().memory
  const currentUserId = useCurrentUser()?.id
  return (revision) => {
    const { author, source } = revision
    if (author.type === "serviceAccount") {
      return { label: messages.byServiceAccount, conversation: null }
    }
    if (author.type === "system") return { label: messages.bySystem, conversation: null }
    const mine = author.id === currentUserId
    // Someone else's conversation would not open for this person.
    if (source) {
      return mine
        ? { label: messages.inYourConversation, conversation: threadPathFromLink(source) }
        : { label: messages.inTeammateConversation, conversation: null }
    }
    return { label: mine ? messages.editedByYou : messages.editedByTeammate, conversation: null }
  }
}

function RevisionRow({
  revision,
  view,
  current,
  onOpen,
}: {
  readonly revision: Revision
  readonly view: MemoryRepoView
  readonly current: boolean
  readonly onOpen: () => void
}) {
  const messages = useSettingsMessages().memory
  const locale = useLocale()
  const origin = useChangeOrigin()(revision)
  const time = new Date(revision.createdAt).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  })
  const notes = revision.changes.map((change) => {
    const file = view.files.find((candidate) => candidate.path === change.path)
    return file
      ? noteTitle(file, messages)
      : noteTitle({ path: change.path, contents: "" }, messages)
  })

  return (
    <li className="relative">
      <span
        aria-hidden
        className={cn(
          "absolute top-[13px] left-2 size-[7px] rounded-full ring-4 ring-background transition-colors",
          current ? "bg-foreground" : "bg-muted-foreground/40"
        )}
      />
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "ml-5 block w-[calc(100%-1.25rem)] rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          current ? "bg-muted" : "hover:bg-muted/50"
        )}
      >
        <span className="line-clamp-2 text-sm leading-5 font-medium">{revision.message}</span>
        <span className="mt-0.5 block truncate text-[0.8125rem] text-muted-foreground">
          <time dateTime={revision.createdAt} className="tabular-nums">
            {time}
          </time>
          <span aria-hidden className="mx-1.5 text-muted-foreground/50">
            ·
          </span>
          {origin.label}
          <span aria-hidden className="mx-1.5 text-muted-foreground/50">
            ·
          </span>
          {messages.touched(notes)}
        </span>
      </button>
    </li>
  )
}

/** One change: who made it and where, and what it did to every file it touched. */
function ChangeDetail({
  repo,
  view,
  revision,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly revision: Revision
}) {
  const allMessages = useSettingsMessages()
  const format = useFormat()
  const origin = useChangeOrigin()(revision)
  // A revision never changes, so each read of one is kept for good.
  const readAt = (revisionNumber: number) => ({
    ...getAgentMemoryOptions({ path: { repo }, query: { revision: String(revisionNumber) } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const afterQuery = useQuery(readAt(revision.revision))
  const beforeQuery = useQuery(readAt(revision.revision - 1))
  const failed = afterQuery.error ?? beforeQuery.error

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] md:sticky md:top-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-[0.9375rem] leading-6 font-semibold">{revision.message}</h3>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {origin.label}
            <span aria-hidden className="mx-1.5 text-muted-foreground/50">
              ·
            </span>
            {format.dateTime(revision.createdAt)}
          </p>
        </div>
        {origin.conversation ? (
          <Link
            to={origin.conversation}
            className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {allMessages.memory.openConversation}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </header>
      {afterQuery.isPending || beforeQuery.isPending ? (
        <PanelSkeleton rows={2} />
      ) : failed ? (
        <PanelEmpty
          tone="error"
          icon={History}
          title={allMessages.memory.unavailable}
          description={apiErrorMessage(failed, allMessages.memory.loadFailed)}
        />
      ) : (
        <div className="divide-y divide-border">
          {revision.changes.map((change) => (
            <FileChange
              key={change.path}
              repo={repo}
              view={view}
              revision={revision}
              change={change}
              before={beforeQuery.data?.files.find((file) => file.path === change.path)}
              after={afterQuery.data?.files.find((file) => file.path === change.path)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * What a change did to one file, with the file as the change left it, or for a deletion as it
 * read just before, to make current again.
 */
function FileChange({
  repo,
  view,
  revision,
  change,
  before,
  after,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly revision: Revision
  readonly change: Change
  readonly before: { readonly contents: string } | undefined
  readonly after: { readonly contents: string } | undefined
}) {
  const messages = useSettingsMessages().memory
  const format = useFormat()
  const queryClient = useQueryClient()
  const name = noteTitle(
    { path: change.path, contents: (after ?? before)?.contents ?? "" },
    messages
  )
  // Missing means the version was pruned: the change shows the path existed then.
  const version = change.deleted ? before : after
  const current = view.files.find((file) => file.path === change.path)
  const isCurrent = version !== undefined && version.contents === current?.contents
  const restore = useMutation({
    ...saveAgentMemoryMutation(),
    onSuccess: async () => {
      notify.success(messages.restored)
      await refreshMemory(queryClient, repo)
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.restoreFailed)),
  })

  return (
    <section className="min-w-0">
      <header className="flex items-baseline gap-2.5 px-5 pt-4 pb-1">
        <h3 className="min-w-0 truncate text-sm font-semibold">{name}</h3>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70">
          {change.path}
        </span>
        {change.deleted ? <Pill tone="muted">{messages.deleted}</Pill> : null}
        {isCurrent ? (
          <span className="shrink-0 text-xs text-muted-foreground/80">{messages.current}</span>
        ) : version ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-1 h-7 shrink-0 px-2 text-[0.8125rem] text-muted-foreground hover:text-foreground"
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate({
                path: { repo },
                body: {
                  baseRevision: view.revision,
                  message: messages.restoredMessage(name, format.date(revision.createdAt)),
                  changes: [{ path: change.path, contents: version.contents }],
                },
              })
            }
          >
            {restore.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {change.deleted ? messages.bringBack : messages.restore}
          </Button>
        ) : null}
      </header>
      {version === undefined ? (
        <p className="px-5 pt-1 pb-4 text-[0.8125rem] text-muted-foreground">
          {messages.versionMissing}
        </p>
      ) : (
        <MemoryDiff
          note={isMemoryNote(change.path)}
          lines={memoryLineDiff(
            before?.contents ?? "",
            change.deleted ? "" : (after?.contents ?? "")
          )}
          messages={messages}
        />
      )}
    </section>
  )
}

/** Lines kept around a change, so it reads in context; longer runs fold into one line. */
const CONTEXT_LINES = 2

/**
 * A change as removed and added lines, with only a little of what it kept around them. A note's
 * changes read as its text: an edge and a faint tint mark them, and its blank lines are left out.
 */
function MemoryDiff({
  note,
  lines,
  messages,
}: {
  /** A note's lines read as the page reads its text; any other file's as code. */
  readonly note: boolean
  readonly lines: readonly MemoryDiffLine[]
  readonly messages: MemoryMessages
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set())
  const shown = useMemo(
    () => (note ? lines.filter((line) => line.text.trim() !== "") : lines),
    [lines, note]
  )
  const rows = useMemo(() => foldUnchanged(shown, unfolded), [shown, unfolded])
  if (!lines.some((line) => line.kind !== "same")) {
    return (
      <p className="px-5 pt-1 pb-4 text-[0.8125rem] text-muted-foreground">{messages.noChanges}</p>
    )
  }
  return (
    <div
      className={cn(
        "px-3 pt-1 pb-3",
        note ? "text-[0.875rem] leading-6" : "font-mono text-xs leading-6"
      )}
    >
      {rows.map((row) =>
        row.kind === "folded" ? (
          <button
            key={`fold:${row.start}`}
            type="button"
            onClick={() => setUnfolded((current) => new Set(current).add(row.start))}
            className="block w-full rounded-md px-3 py-1 text-left font-sans text-xs text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {messages.unchangedLines(row.count)}
          </button>
        ) : (
          <div
            key={`line:${row.index}`}
            className={cn(
              "border-l-2 py-0.5 pr-3 pl-3",
              !note && "whitespace-pre-wrap",
              row.line.kind === "same" && "border-transparent text-muted-foreground",
              row.line.kind === "added" &&
                "border-emerald-500/70 bg-emerald-500/[0.06] text-foreground",
              row.line.kind === "removed" &&
                "border-red-500/60 bg-red-500/[0.05] text-muted-foreground line-through decoration-red-500/40"
            )}
          >
            {row.line.kind === "same" ? null : (
              <span className="sr-only">
                {row.line.kind === "added" ? messages.addedLine : messages.removedLine}
              </span>
            )}
            <span className="min-w-0 break-words">
              {note ? <NoteLine text={row.line.text} /> : row.line.text || " "}
            </span>
          </div>
        )
      )}
    </div>
  )
}

/**
 * One line of a note as the page reads it: a bullet as a bullet, a heading in bold and a `[[link]]`
 * by the file's name in words. The date an entry was added stays in the file; the change says when.
 */
function NoteLine({ text }: { readonly text: string }) {
  const heading = text.match(/^#{1,6}\s+(.*)$/)
  if (heading) return <span className="font-semibold text-foreground">{heading[1]}</span>
  const bullet = text.match(/^(\s*)[-*+]\s+(.*)$/)
  const body = ((bullet ? bullet[2] : text) ?? "").replace(ADDED, "")
  const shown = body.replace(/\[\[([^[\]\n]+)\]\]/g, (_, link: string) =>
    memoryLinkName(memoryLinkPath(link.trim()))
  )
  return (
    <>
      {bullet ? (
        <span aria-hidden className="mr-2.5 opacity-50">
          •
        </span>
      ) : null}
      {shown || " "}
    </>
  )
}

type DiffRow =
  | { readonly kind: "line"; readonly index: number; readonly line: MemoryDiffLine }
  | { readonly kind: "folded"; readonly start: number; readonly count: number }

/** The diff with each run of lines far from any change folded into one row, unless opened. */
function foldUnchanged(lines: readonly MemoryDiffLine[], unfolded: ReadonlySet<number>): DiffRow[] {
  const changed = lines.map((line) => line.kind !== "same")
  const near = (index: number) =>
    changed.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1).some(Boolean)
  const rows: DiffRow[] = []
  let run: { index: number; line: MemoryDiffLine }[] = []
  const flush = () => {
    const start = run[0]?.index
    if (start === undefined) return
    if (unfolded.has(start)) {
      for (const { index, line } of run) rows.push({ kind: "line", index, line })
    } else {
      rows.push({ kind: "folded", start, count: run.length })
    }
    run = []
  }
  for (const [index, line] of lines.entries()) {
    if (near(index)) {
      flush()
      rows.push({ kind: "line", index, line })
    } else {
      run.push({ index, line })
    }
  }
  flush()
  return rows
}
