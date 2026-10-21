import type { ListAgentMemoryRevisionsResponse } from "@sixb/client"
import {
  getAgentMemoryOptions,
  listAgentMemoryRevisionsOptions,
  saveAgentMemoryMutation,
} from "@sixb/client/hooks"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, History, Loader2, MessageSquare, RotateCcw } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useCurrentUser } from "../../session"
import { notify } from "../section-page"
import {
  apiErrorMessage,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  useFormat,
} from "../section-ui"
import {
  ADDED,
  MemoryFileName,
  type MemoryRepoView,
  refreshMemory,
  useEntryDate,
  useFileLabel,
} from "./memory-contents"
import {
  isMemoryNote,
  type MemoryDiffLine,
  type MemoryRepo,
  memoryLineDiff,
  memoryLinkName,
  memoryLinkPath,
} from "./memory-files"
import { useSettingsMessages } from "./messages"

type Revision = ListAgentMemoryRevisionsResponse["revisions"][number]
type Change = Revision["changes"][number]
type MemoryMessages = ReturnType<typeof useSettingsMessages>["memory"]

const PAGE_SIZE = 20

/** Every save to the repo, newest first and by day; a change opens to what it did. */
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
  const [open, setOpen] = useState<Revision | null>(null)
  const historyQuery = useQuery({
    ...listAgentMemoryRevisionsOptions({ path: { repo }, query: { limit: String(limit) } }),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const days = useMemo(() => {
    const groups: { label: string; revisions: Revision[] }[] = []
    for (const revision of historyQuery.data?.revisions ?? []) {
      const label = day(revision.createdAt)
      const last = groups.at(-1)
      if (last?.label === label) last.revisions.push(revision)
      else groups.push({ label, revisions: [revision] })
    }
    return groups
  }, [historyQuery.data?.revisions, day])

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
    <div className="flex flex-col gap-4">
      <Panel>
        {days.map((group) => (
          <section key={group.label} aria-label={group.label} className="divide-y divide-border">
            <h3 className="bg-muted/30 px-4 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </h3>
            {group.revisions.map((revision) => (
              <RevisionRow
                key={revision.revision}
                revision={revision}
                onOpen={() => setOpen(revision)}
              />
            ))}
          </section>
        ))}
      </Panel>
      {historyQuery.data?.hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center"
          disabled={historyQuery.isFetching}
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
        >
          {historyQuery.isFetching ? <Loader2 className="animate-spin" /> : null}
          {messages.showMore}
        </Button>
      ) : null}
      {open ? (
        <ChangeDialog repo={repo} view={view} revision={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}

/** "Today", "Yesterday", or the day, with its weekday this week and its year only when past. */
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
        ...(days < 7 ? { weekday: "long" } : {}),
        month: "long",
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
        ? { label: messages.inYourConversation, conversation: source }
        : { label: messages.inTeammateConversation, conversation: null }
    }
    return { label: mine ? messages.editedByYou : messages.editedByTeammate, conversation: null }
  }
}

function RevisionRow({
  revision,
  onOpen,
}: {
  readonly revision: Revision
  readonly onOpen: () => void
}) {
  const messages = useSettingsMessages().memory
  const label = useFileLabel()
  const locale = useLocale()
  const origin = useChangeOrigin()(revision)
  const time = new Date(revision.createdAt).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    <PanelRow
      title={<span className="min-w-0 truncate">{revision.message}</span>}
      meta={
        <>
          <span className="truncate">{origin.label}</span>
          <MetaDot />
          <time dateTime={revision.createdAt} className="shrink-0 tabular-nums">
            {time}
          </time>
          <MetaDot />
          <span className="truncate">
            {messages.touched(revision.changes.map((change) => label(change.path)))}
          </span>
        </>
      }
      onClick={onOpen}
      trailing={
        <>
          {origin.conversation ? (
            <Button
              asChild
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
            >
              <Link
                to={origin.conversation}
                aria-label={messages.openConversation}
                title={messages.openConversation}
              >
                <MessageSquare />
              </Link>
            </Button>
          ) : null}
          <ChevronRight aria-hidden className="size-4 text-muted-foreground/60" />
        </>
      }
    />
  )
}

/** One change: every file it touched, what it did to each, and a way to bring a file back. */
function ChangeDialog({
  repo,
  view,
  revision,
  onClose,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly revision: Revision
  readonly onClose: () => void
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
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-5 sm:max-w-2xl"
        // The dialog is read before anything in it is pressed.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="pr-6 leading-6">{revision.message}</DialogTitle>
          <DialogDescription>
            {origin.label}
            <span aria-hidden className="mx-1.5 text-muted-foreground/50">
              ·
            </span>
            {format.dateTime(revision.createdAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
          {afterQuery.isPending || beforeQuery.isPending ? (
            <Panel>
              <PanelSkeleton rows={2} />
            </Panel>
          ) : failed ? (
            <Panel>
              <PanelEmpty
                tone="error"
                icon={History}
                title={allMessages.memory.unavailable}
                description={apiErrorMessage(failed, allMessages.memory.loadFailed)}
              />
            </Panel>
          ) : (
            revision.changes.map((change) => (
              <FileChange
                key={change.path}
                repo={repo}
                view={view}
                revision={revision}
                change={change}
                before={beforeQuery.data?.files.find((file) => file.path === change.path)}
                after={afterQuery.data?.files.find((file) => file.path === change.path)}
                onRestored={onClose}
              />
            ))
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {allMessages.common.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  onRestored,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly revision: Revision
  readonly change: Change
  readonly before: { readonly contents: string } | undefined
  readonly after: { readonly contents: string } | undefined
  readonly onRestored: () => void
}) {
  const messages = useSettingsMessages().memory
  const format = useFormat()
  const label = useFileLabel()
  const queryClient = useQueryClient()
  const name = label(change.path)
  // Missing means the version was pruned: the change shows the path existed then.
  const version = change.deleted ? before : after
  const current = view.files.find((file) => file.path === change.path)
  const isCurrent = version !== undefined && version.contents === current?.contents
  const restore = useMutation({
    ...saveAgentMemoryMutation(),
    onSuccess: async () => {
      notify.success(messages.restored)
      onRestored()
      await refreshMemory(queryClient, repo)
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.restoreFailed)),
  })

  return (
    <section className="shrink-0 overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <h3 className="min-w-0 flex-1 truncate text-[0.8125rem]" title={change.path}>
          <MemoryFileName path={change.path} />
        </h3>
        {change.deleted ? <Pill tone="muted">{messages.deleted}</Pill> : null}
        {isCurrent ? (
          <span className="text-xs text-muted-foreground">{messages.current}</span>
        ) : version ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
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
            {restore.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {change.deleted ? messages.bringBack : messages.restore}
          </Button>
        ) : null}
      </header>
      {version === undefined ? (
        <p className="px-4 py-3 text-[0.8125rem] text-muted-foreground">
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

/** A change as removed and added lines, with only a little of what it kept around them. */
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
  const rows = useMemo(() => foldUnchanged(lines, unfolded), [lines, unfolded])
  if (!lines.some((line) => line.kind !== "same")) {
    return <p className="px-4 py-3 text-[0.8125rem] text-muted-foreground">{messages.noChanges}</p>
  }
  return (
    <div
      className={cn("py-1.5", note ? "text-[0.8125rem] leading-6" : "font-mono text-xs leading-6")}
    >
      {rows.map((row) =>
        row.kind === "folded" ? (
          <button
            key={`fold:${row.start}`}
            type="button"
            onClick={() => setUnfolded((current) => new Set(current).add(row.start))}
            className="block w-full px-4 py-0.5 text-left font-sans text-xs text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {messages.unchangedLines(row.count)}
          </button>
        ) : (
          <div
            key={`line:${row.index}`}
            className={cn(
              "flex gap-3 px-4 py-0.5",
              !note && "whitespace-pre-wrap",
              row.line.kind === "added" &&
                "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
              row.line.kind === "removed" &&
                "bg-red-500/10 text-red-900 line-through decoration-red-900/30 dark:text-red-200 dark:decoration-red-200/30"
            )}
          >
            <span aria-hidden className="w-3 shrink-0 text-center opacity-60 select-none">
              {row.line.kind === "added" ? "+" : row.line.kind === "removed" ? "−" : ""}
            </span>
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
 * One line of a note as the page reads it: a bullet as a bullet, a heading in bold, a `[[link]]`
 * by the file's name in words, and the date an entry was added as a quiet date.
 */
function NoteLine({ text }: { readonly text: string }) {
  const messages = useSettingsMessages().memory
  const entryDate = useEntryDate()
  const heading = text.match(/^#{1,6}\s+(.*)$/)
  if (heading) return <span className="font-semibold">{heading[1]}</span>
  const bullet = text.match(/^(\s*)[-*+]\s+(.*)$/)
  const body = (bullet ? bullet[2] : text) ?? ""
  const added = body.match(ADDED)
  const words = (added ? body.slice(0, added.index) : body).replace(
    /\[\[([^[\]\n]+)\]\]/g,
    (_, link: string) => memoryLinkName(memoryLinkPath(link.trim()))
  )
  return (
    <>
      {bullet ? (
        <span aria-hidden className="mr-2 opacity-50">
          •
        </span>
      ) : null}
      {words || " "}
      {added?.[1] ? (
        <span className="ml-2 text-xs whitespace-nowrap opacity-60 tabular-nums">
          {messages.added(entryDate(added[1]))}
        </span>
      ) : null}
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
