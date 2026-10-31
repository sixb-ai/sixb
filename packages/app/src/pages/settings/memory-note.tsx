import type { ListAgentMemoryRevisionsResponse } from "@sixb/client"
import { getAgentMemoryOptions, getAgentThreadOptions } from "@sixb/client/hooks"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useQueries } from "@tanstack/react-query"
import { Code2, FileText, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { threadPathFromLink } from "../../agent/thread-navigation"
import { useCurrentUser } from "../../session"
import { notify } from "../section-page"
import { useFormat } from "../section-ui"
import { ConfirmDialog, EntryEditor, summary, TextEditor, useMemorySave } from "./memory-editors"
import {
  insertMemoryEntry,
  type MemoryBlock,
  type MemoryEntry,
  memoryBlocks,
  memoryEntries,
  memoryToday,
  removeMemoryEntry,
  replaceMemoryEntry,
} from "./memory-entries"
import {
  isMemoryNote,
  MEMORY_ENTRY,
  type MemoryFile,
  type MemoryRepo,
  type MemoryRepoView,
  memoryFileHref,
  memoryFileName,
  memoryLinkPath,
  memoryPageHref,
  noteTitle,
  words,
} from "./memory-files"
import { useSettingsMessages } from "./messages"

type Revision = ListAgentMemoryRevisionsResponse["revisions"][number]

/** Where a memory came from: the save that first wrote its words, and its conversation's name. */
interface EntryOrigin {
  readonly revision: Revision
  readonly conversation: { readonly href: string; readonly title?: string } | null
}

/**
 * Each entry's origin, by the earliest save whose version of the note holds the entry's line as it
 * reads now: an entry reworded later dates from the rewording.
 */
function useEntryOrigins(
  repo: MemoryRepo,
  file: MemoryFile,
  revisions: readonly Revision[]
): ReadonlyMap<number, EntryOrigin> {
  const currentUserId = useCurrentUser()?.id
  const touching = useMemo(
    () =>
      revisions
        .filter((revision) => revision.changes.some((change) => change.path === file.path))
        .sort((a, b) => a.revision - b.revision),
    [revisions, file.path]
  )
  // A revision never changes, so each read of one is kept for good.
  const versions = useQueries({
    queries: touching.map((revision) => ({
      ...getAgentMemoryOptions({ path: { repo }, query: { revision: String(revision.revision) } }),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    })),
  })
  // Only this person's own conversations open for them.
  const threadIds = [
    ...new Set(
      touching.flatMap((revision) =>
        revision.source && revision.author.id === currentUserId
          ? [threadPathFromLink(revision.source)]
          : []
      )
    ),
  ]
  const threads = useQueries({
    queries: threadIds.map((href) => ({
      ...getAgentThreadOptions({
        path: { threadId: decodeURIComponent(href.slice(href.lastIndexOf("/") + 1)) },
      }),
      retry: false,
      staleTime: 60_000,
    })),
  })
  const titles = new Map(threadIds.map((href, index) => [href, threads[index]?.data?.title]))
  const lines = file.contents.split("\n")
  const origins = new Map<number, EntryOrigin>()
  for (const entry of memoryEntries(file.contents)) {
    const line = lines[entry.line]
    if (line === undefined) continue
    const index = touching.findIndex((_, at) =>
      versions[at]?.data?.files
        .find((version) => version.path === file.path)
        ?.contents.split("\n")
        .includes(line)
    )
    const revision = touching[index]
    if (!revision) continue
    const href =
      revision.source && revision.author.id === currentUserId
        ? threadPathFromLink(revision.source)
        : null
    origins.set(entry.line, {
      revision,
      conversation: href ? { href, title: titles.get(href) } : null,
    })
  }
  return origins
}

/** Pieces of a note's sections, in order: a section's title, and what is under it. */
interface Section {
  readonly heading: { readonly line: number; readonly text: string } | null
  readonly blocks: readonly MemoryBlock[]
}

function sectionsOf(contents: string): { intro: string[]; sections: Section[] } {
  const intro: string[] = []
  const sections: Section[] = []
  let current: { heading: Section["heading"]; blocks: MemoryBlock[] } | null = null
  for (const block of memoryBlocks(contents)) {
    if (block.kind === "heading") {
      current = { heading: { line: block.line, text: block.text }, blocks: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      if (block.kind === "text") {
        intro.push(block.text)
        continue
      }
      current = { heading: null, blocks: [] }
      sections.push(current)
    }
    current.blocks.push(block)
  }
  return { intro, sections }
}

/** The notes that link to `path`, by their `[[links]]`. */
function linksTo(files: readonly MemoryFile[], path: string): MemoryFile[] {
  return files.filter(
    (file) =>
      file.path !== path &&
      [...file.contents.matchAll(/\[\[([^[\]\n]+)\]\]/g)].some(
        (match) => memoryLinkPath((match[1] ?? "").trim()) === path
      )
  )
}

type MemoryMessages = ReturnType<typeof useSettingsMessages>["memory"]

/**
 * A note as a document: its title and what it is for, then each section's memories. A memory shows
 * when and where it was learned on hover, edits in place and forgets with an undo where it was.
 */
export function NoteDocument({
  repo,
  view,
  file,
  revisions,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly file: MemoryFile
  readonly revisions: readonly Revision[]
}) {
  const messages = useSettingsMessages().memory
  const format = useFormat()
  const navigate = useNavigate()
  const { save, pending } = useMemorySave(repo, view)
  const [mode, setMode] = useState<"read" | "source" | "text">("read")
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  // A memory just forgotten keeps its place, crossed out, until the next one is.
  const [forgotten, setForgotten] = useState<{
    readonly line: number
    readonly text: string
    readonly undo: () => void
  } | null>(null)
  const title = noteTitle(file, messages)
  const note = isMemoryNote(file.path)
  const origins = useEntryOrigins(repo, file, revisions)
  const backlinks = linksTo(view.files, file.path)
  const touching = revisions.filter((revision) =>
    revision.changes.some((change) => change.path === file.path)
  )
  const latest = touching[0]
  const conversations = new Set(touching.flatMap((revision) => revision.source ?? [])).size
  const { intro, sections } = useMemo(() => sectionsOf(file.contents), [file.contents])
  const titles = useMemo(
    () => new Map(view.files.map((entry) => [entry.path, noteTitle(entry, messages)])),
    [view.files, messages]
  )

  const forget = async (entry: MemoryEntry) => {
    const before = file.contents
    const saved = await save(
      [{ path: file.path, contents: removeMemoryEntry(before, entry) }],
      messages.forgotMessage(summary(entry.text))
    )
    if (saved === null) return
    setForgotten({
      line: entry.line,
      text: entry.text,
      undo: () => {
        setForgotten(null)
        void save([{ path: file.path, contents: before }], messages.undoMessage, saved)
      },
    })
  }

  const readLine =
    file.path === MEMORY_ENTRY
      ? messages.readFirst
      : backlinks[0]
        ? messages.readLinked(noteTitle(backlinks[0], messages))
        : messages.readOnLink

  return (
    <article className="min-w-0">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[1.375rem] leading-8 font-semibold tracking-[-0.018em]">
            {title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.8125rem] text-muted-foreground">
            <span className="font-mono text-xs">{file.path}</span>
            <span aria-hidden>·</span>
            <span>{readLine}</span>
            {latest ? (
              <>
                <span aria-hidden>·</span>
                <span>{messages.updated(format.relative(latest.createdAt))}</span>
              </>
            ) : null}
            {conversations > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span
                  title={messages.fromHint}
                  className="underline decoration-muted-foreground/40 decoration-dotted underline-offset-[3px]"
                >
                  {messages.fromConversations(conversations)}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {mode === "text" ? null : (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setMode("text")}
            >
              <Code2 />
              {messages.editAsText}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={messages.fileActions}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => setMode((current) => (current === "source" ? "read" : "source"))}
                >
                  <Code2 />
                  {mode === "source" ? messages.showDocument : messages.showSource}
                </DropdownMenuItem>
                {file.path === MEMORY_ENTRY ? null : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                      <Trash2 />
                      {messages.deleteFile}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </header>

      {mode === "text" ? (
        <div className="mt-6">
          <TextEditor
            name={title}
            contents={file.contents}
            revision={view.revision}
            pending={pending}
            onCancel={() => setMode("read")}
            onSave={async (contents, noteText, baseRevision) => {
              const saved = await save(
                [{ path: file.path, contents }],
                noteText || messages.editedMessage(title),
                baseRevision
              )
              if (saved !== null) {
                setMode("read")
                notify.success(messages.saved)
              }
            }}
          />
        </div>
      ) : mode === "source" || !note ? (
        <pre className="mt-6 min-w-0 overflow-x-auto rounded-lg bg-muted/40 px-5 py-4 font-mono text-[0.8125rem] leading-6 whitespace-pre-wrap text-foreground/90">
          {file.contents}
        </pre>
      ) : (
        <>
          {intro.length > 0 ? (
            <p className="mt-5 max-w-[40rem] text-base leading-[1.65] text-muted-foreground">
              {intro.join(" ")}
            </p>
          ) : null}
          {file.contents.replace(/^\s*#[^\n]*\n?/, "").trim() === "" ? (
            <p className="mt-6 text-sm text-muted-foreground">{messages.fileEmpty}</p>
          ) : null}
          {sections.map((section, index) => {
            const entries = section.blocks.flatMap((block) =>
              block.kind === "entry" ? [block.entry] : []
            )
            const last = section.blocks.at(-1)
            const after = last
              ? last.kind === "entry"
                ? last.entry.line
                : last.line
              : (section.heading?.line ?? 0)
            const sectionKey = section.heading?.line ?? `start:${index}`
            return (
              <section key={sectionKey} className="group/section">
                {section.heading ? (
                  <h3 className="mt-8 mb-1.5 text-base font-semibold tracking-[-0.01em]">
                    {section.heading.text}
                  </h3>
                ) : (
                  <div className="h-5" />
                )}
                <div>
                  {section.blocks.map((block) => {
                    const ghost =
                      forgotten && block.kind === "entry" && block.entry.line === forgotten.line ? (
                        <ForgottenRow
                          key="forgotten"
                          text={forgotten.text}
                          onUndo={forgotten.undo}
                          messages={messages}
                        />
                      ) : null
                    if (block.kind === "text") {
                      return (
                        <p
                          key={block.line}
                          className="my-2 max-w-[40rem] text-base leading-[1.65] text-muted-foreground"
                        >
                          {block.text}
                        </p>
                      )
                    }
                    if (block.kind !== "entry") return null
                    const entry = block.entry
                    return (
                      <div key={entry.line}>
                        {ghost}
                        <EntryRow
                          repo={repo}
                          entry={entry}
                          titles={titles}
                          origin={origins.get(entry.line)}
                          editing={editing === entry.line}
                          pending={pending}
                          onEdit={() => {
                            setEditing(entry.line)
                            setForgotten(null)
                          }}
                          onCancel={() => setEditing(null)}
                          onSave={async (text) => {
                            const saved = await save(
                              [
                                {
                                  path: file.path,
                                  contents: replaceMemoryEntry(file.contents, entry, text),
                                },
                              ],
                              summary(text)
                            )
                            if (saved !== null) setEditing(null)
                          }}
                          onForget={() => void forget(entry)}
                          messages={messages}
                        />
                      </div>
                    )
                  })}
                  {/* Forgetting the section's last memory leaves its place at the end. */}
                  {forgotten &&
                  entries.length > 0 &&
                  forgotten.line > (entries.at(-1)?.line ?? 0) &&
                  forgotten.line <= after + 1 &&
                  !section.blocks.some(
                    (block) => block.kind === "entry" && block.entry.line === forgotten.line
                  ) ? (
                    <ForgottenRow
                      text={forgotten.text}
                      onUndo={forgotten.undo}
                      messages={messages}
                    />
                  ) : null}
                  {adding === after ? (
                    <div className="py-1.5 pl-[30px]">
                      <EntryEditor
                        initial=""
                        placeholder={
                          repo === "user"
                            ? messages.addPlaceholderYours
                            : messages.addPlaceholderProject
                        }
                        submitLabel={messages.add}
                        pending={pending}
                        onCancel={() => setAdding(null)}
                        onSubmit={async (text) => {
                          const saved = await save(
                            [
                              {
                                path: file.path,
                                contents: insertMemoryEntry(
                                  file.contents,
                                  after,
                                  text,
                                  memoryToday()
                                ),
                              },
                            ],
                            summary(text)
                          )
                          if (saved !== null) {
                            setAdding(null)
                            notify.success(messages.addedMemory)
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(after)
                        setEditing(null)
                      }}
                      className="flex h-8 items-center gap-2 pl-px text-[0.875rem] text-muted-foreground/70 opacity-0 transition-opacity group-hover/section:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      {section.heading ? messages.addTo(section.heading.text) : messages.addHere}
                    </button>
                  )}
                </div>
              </section>
            )
          })}
          {backlinks.length > 0 ? (
            <footer className="mt-10 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-[0.8125rem] text-muted-foreground">
              <span>{messages.linkedFrom}</span>
              {backlinks.map((link) => (
                <Link
                  key={link.path}
                  to={memoryFileHref(repo, link.path)}
                  className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-foreground/80 transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <FileText className="size-3" aria-hidden />
                  {noteTitle(link, messages)}
                </Link>
              ))}
            </footer>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={messages.deleteFileTitle(title)}
        description={messages.deleteFileDescription}
        action={messages.deleteFile}
        onConfirm={async () => {
          const saved = await save(
            [{ path: file.path, contents: null }],
            messages.deletedMessage(title)
          )
          if (saved !== null) {
            notify.success(messages.fileDeleted)
            navigate(memoryPageHref({ repo }))
          }
        }}
      />
    </article>
  )
}

/**
 * One memory: a bullet and its words, with the date and conversation it came from in the margin
 * beside it on hover, or focus on touch, where open, edit and forget also wait.
 */
function EntryRow({
  repo,
  entry,
  titles,
  origin,
  editing,
  pending,
  onEdit,
  onCancel,
  onSave,
  onForget,
  messages,
}: {
  readonly repo: MemoryRepo
  readonly entry: MemoryEntry
  readonly titles: ReadonlyMap<string, string>
  readonly origin: EntryOrigin | undefined
  readonly editing: boolean
  readonly pending: boolean
  readonly onEdit: () => void
  readonly onCancel: () => void
  readonly onSave: (text: string) => Promise<void>
  readonly onForget: () => void
  readonly messages: MemoryMessages
}) {
  const format = useFormat()
  const when = origin
    ? format.relative(origin.revision.createdAt)
    : entry.added
      ? format.date(`${entry.added}T12:00:00`)
      : null
  const where = origin?.conversation
    ? (origin.conversation.title ?? messages.inConversation)
    : origin
      ? origin.revision.source
        ? messages.inTeammateConversation
        : messages.editedByYou
      : null
  return (
    <div
      tabIndex={-1}
      className="group/entry grid grid-cols-[16px_minmax(0,40rem)] gap-x-3.5 py-[5px] outline-none md:grid-cols-[16px_minmax(0,40rem)_minmax(0,1fr)]"
    >
      <span aria-hidden className="mt-[11px] ml-[5px] size-[5px] rounded-full bg-foreground/45" />
      {editing ? (
        <EntryEditor
          initial={entry.text}
          submitLabel={messages.save}
          pending={pending}
          onCancel={onCancel}
          onSubmit={onSave}
          hint={messages.editHint}
        />
      ) : (
        <p
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest("a")) onEdit()
          }}
          className="m-0 cursor-text text-base leading-[1.65] tracking-[-0.006em] text-foreground"
        >
          <EntryWords repo={repo} text={entry.text} titles={titles} />
        </p>
      )}
      {editing ? null : (
        <div className="relative col-start-2 min-w-0 md:col-start-auto">
          <div className="flex h-[26px] items-center gap-2 opacity-0 transition-opacity group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 md:absolute md:inset-x-0 md:top-0 [@media(hover:none)]:opacity-100">
            <div className="-ml-1.5 flex shrink-0">
              {origin?.conversation ? (
                <Button
                  asChild
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                >
                  <Link
                    to={origin.conversation.href}
                    aria-label={messages.openConversation}
                    title={messages.openConversation}
                  >
                    <MessageSquare />
                  </Link>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={messages.edit}
                title={messages.edit}
                onClick={onEdit}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                aria-label={messages.forgetEntry}
                title={messages.forgetEntry}
                disabled={pending}
                onClick={onForget}
              >
                <Trash2 />
              </Button>
            </div>
            {when || where ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {[when, where].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** An entry's words, each `[[link]]` as a link to the note it names, by that note's title. */
function EntryWords({
  repo,
  text,
  titles,
}: {
  readonly repo: MemoryRepo
  readonly text: string
  readonly titles: ReadonlyMap<string, string>
}) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const path = memoryLinkPath((match[1] ?? "").trim())
    const title = titles.get(path)
    parts.push(
      title ? (
        <Link
          key={at}
          to={memoryFileHref(repo, path)}
          className="text-foreground underline decoration-foreground/25 underline-offset-[3px] transition-colors hover:decoration-foreground"
        >
          {title}
        </Link>
      ) : (
        words(memoryFileName(path.slice(path.lastIndexOf("/") + 1)))
      )
    )
    last = at + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

function ForgottenRow({
  text,
  onUndo,
  messages,
}: {
  readonly text: string
  readonly onUndo: () => void
  readonly messages: MemoryMessages
}) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,40rem)] gap-x-3.5 py-[5px]" role="status">
      <span aria-hidden />
      <div className="flex min-w-0 items-center gap-3 text-[0.9375rem] leading-[1.65] text-muted-foreground">
        <span className="min-w-0 truncate line-through decoration-muted-foreground/40">
          {text.replace(/\[\[([^[\]\n]+)\]\]/g, "$1")}
        </span>
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 text-sm font-medium text-foreground hover:underline"
        >
          {messages.undo}
        </button>
      </div>
    </div>
  )
}
