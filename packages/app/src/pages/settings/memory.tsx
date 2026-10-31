import { getAgentMemoryOptions, listAgentMemoryRevisionsOptions } from "@sixb/client/hooks"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  Brain,
  FileText,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react"
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { notify, SectionPage } from "../section-page"
import { Panel, PanelEmpty, PanelSkeleton, useLoadFailure } from "../section-ui"
import { EntryEditor, ForgetDialog, summary, useMemorySave } from "./memory-editors"
import { insertMemoryEntry, memoryEntries, memoryToday } from "./memory-entries"
import {
  isMemoryNote,
  MEMORY_ENTRY,
  type MemoryFile,
  type MemoryRepo,
  type MemoryRepoView,
  memoryFolder,
  memoryPageHref,
  noteTitle,
  sortMemoryPaths,
  words,
} from "./memory-files"
import { MemoryHistory } from "./memory-history"
import { NoteDocument } from "./memory-note"
import { useSettingsMessages } from "./messages"

/** A page of revisions large enough to date and attribute every note on it. */
const REVISIONS_READ = 100

/**
 * Settings › Memory: what the agent remembers, the signed-in person's own and the team's. Each note
 * reads as a document: its memories say when and where they were learned, and each can be fixed in
 * place or forgotten. History shows every save, what it changed, and restores any file.
 */
export function SettingsMemoryPage() {
  const messages = useSettingsMessages().memory
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const repo: MemoryRepo = params.get("repo") === "project" ? "project" : "user"
  const tab = params.get("view") === "history" ? "history" : "memories"
  const repoQuery = useQuery({ ...getAgentMemoryOptions({ path: { repo } }), retry: false })
  const view = repoQuery.data
  const remembers = view !== undefined && view.revision > 0
  const count = useMemo(
    () =>
      (view?.files ?? [])
        .filter((file) => isMemoryNote(file.path))
        .reduce((total, file) => total + memoryEntries(file.contents).length, 0),
    [view?.files]
  )
  const [query, setQuery] = useState("")
  const [forgetting, setForgetting] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  // `/` searches, as it does across the app, unless something else is being typed in.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      event.preventDefault()
      search.current?.focus()
    }
    window.addEventListener("keydown", focusSearch)
    return () => window.removeEventListener("keydown", focusSearch)
  }, [])

  return (
    <SectionPage
      section="settings"
      page="memory"
      // The notes beside the one open need the room.
      width="wide"
      title={messages.title}
      description={repo === "user" ? messages.yoursHint : messages.projectHint}
    >
      <div className="-mt-3 flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-border">
        <div role="tablist" aria-label={messages.title} className="flex gap-6">
          {(["memories", "history"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => navigate(memoryPageHref({ repo, history: id === "history" }))}
              className={cn(
                "-mb-px flex h-10 items-center gap-1.5 border-b-2 text-sm font-medium transition-colors",
                tab === id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {id === "memories" ? messages.memoriesTab : messages.historyTab}
              {id === "memories" && remembers ? (
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 pb-1.5">
          {tab === "memories" && remembers ? (
            <label className="flex h-8 w-56 items-center gap-2 rounded-md bg-muted/70 pr-1.5 pl-2.5 text-muted-foreground transition-colors focus-within:bg-muted">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <input
                ref={search}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("")
                    event.currentTarget.blur()
                  }
                }}
                placeholder={messages.search}
                aria-label={messages.search}
                className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query ? null : <Kbd className="bg-background">/</Kbd>}
            </label>
          ) : null}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={repo}
            aria-label={messages.scope}
            onValueChange={(next) => {
              if (next === "user" || next === "project") {
                setQuery("")
                navigate(memoryPageHref({ repo: next, history: tab === "history" }))
              }
            }}
          >
            <ToggleGroupItem value="user" className="px-3">
              {messages.yours}
            </ToggleGroupItem>
            <ToggleGroupItem value="project" className="px-3">
              {messages.project}
            </ToggleGroupItem>
          </ToggleGroup>
          {remembers ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={messages.more}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setForgetting(true)}>
                  <Trash2 />
                  {messages.forget}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {repoQuery.isPending ? (
        <Panel>
          <PanelSkeleton rows={4} />
        </Panel>
      ) : repoQuery.isError ? (
        <Panel>
          <MemoryUnavailable repo={repo} error={repoQuery.error} />
        </Panel>
      ) : tab === "history" ? (
        <MemoryHistory key={repo} repo={repo} view={repoQuery.data} />
      ) : (
        <MemoriesView
          key={repo}
          repo={repo}
          view={repoQuery.data}
          path={params.get("file")}
          query={query}
        />
      )}

      <ForgetDialog repo={repo} open={forgetting} onOpenChange={setForgetting} />
    </SectionPage>
  )
}

function MemoryUnavailable({
  repo,
  error,
}: {
  readonly repo: MemoryRepo
  readonly error: unknown
}) {
  const messages = useSettingsMessages().memory
  const failure = useLoadFailure(error, {
    fallback: messages.loadFailed,
    ...(repo === "project" ? { denied: messages.deniedProject } : {}),
  })
  return (
    <PanelEmpty tone="error" icon={Brain} title={failure.title} description={failure.description} />
  )
}

/**
 * The memory as notes beside the one open: the main memory first, then each note by its folder,
 * and the open note read as a document.
 */
function MemoriesView({
  repo,
  view,
  path,
  query,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly path: string | null
  readonly query: string
}) {
  const messages = useSettingsMessages().memory
  const navigate = useNavigate()
  const { save, pending } = useMemorySave(repo, view)
  const [adding, setAdding] = useState(false)
  const main = view.files.find((file) => file.path === MEMORY_ENTRY)
  const revisionsQuery = useQuery({
    ...listAgentMemoryRevisionsOptions({
      path: { repo },
      query: { limit: String(REVISIONS_READ) },
    }),
    retry: false,
  })

  if (view.files.length === 0) {
    return (
      <Panel>
        {adding ? (
          <div className="px-5 py-4">
            <EntryEditor
              initial=""
              placeholder={
                repo === "user" ? messages.addPlaceholderYours : messages.addPlaceholderProject
              }
              submitLabel={messages.add}
              pending={pending}
              onCancel={() => setAdding(false)}
              onSubmit={async (text) => {
                const contents = insertMemoryEntry(
                  `# ${messages.mainMemory}\n`,
                  0,
                  text,
                  memoryToday()
                )
                const saved = await save([{ path: MEMORY_ENTRY, contents }], summary(text))
                if (saved !== null) {
                  setAdding(false)
                  notify.success(messages.addedMemory)
                }
              }}
            />
          </div>
        ) : (
          <PanelEmpty
            icon={Brain}
            title={messages.emptyTitle}
            description={repo === "user" ? messages.emptyYours : messages.emptyProject}
            action={
              <Button type="button" size="sm" onClick={() => setAdding(true)}>
                <Plus />
                {messages.add}
              </Button>
            }
          />
        )}
      </Panel>
    )
  }

  const file = view.files.find((candidate) => candidate.path === path) ?? main ?? view.files[0]
  if (!file) return null
  const notes = sortMemoryPaths(view.files.map((entry) => entry.path))
  return (
    <div className="grid min-w-0 gap-8 md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
      <NotesNav repo={repo} view={view} query={query} active={file.path} />
      <div className="min-w-0">
        {/* Phones get the notes as a picker above the open one. */}
        <Select
          value={file.path}
          onValueChange={(next) => navigate(memoryPageHref({ repo, file: next }))}
        >
          <SelectTrigger className="mb-6 w-full md:hidden" aria-label={messages.notes}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {notes.map((notePath) => {
              const note = view.files.find((entry) => entry.path === notePath)
              return note ? (
                <SelectItem key={notePath} value={notePath}>
                  {noteTitle(note, messages)}
                </SelectItem>
              ) : null
            })}
          </SelectContent>
        </Select>
        <NoteDocument
          key={file.path}
          repo={repo}
          view={view}
          file={file}
          revisions={revisionsQuery.data?.revisions ?? []}
        />
      </div>
    </div>
  )
}

/** The notes as a list: the main memory, then notes at the top level, then each folder's. */
function NotesNav({
  repo,
  view,
  query,
  active,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly query: string
  readonly active: string
}) {
  const messages = useSettingsMessages().memory
  const { save, pending } = useMemorySave(repo, view)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const needle = query.trim().toLocaleLowerCase()
  const matches = (file: MemoryFile) =>
    file.contents.split("\n").filter((line) => line.toLocaleLowerCase().includes(needle)).length
  const shown = view.files.filter(
    (file) =>
      needle === "" ||
      file.path.toLocaleLowerCase().includes(needle) ||
      noteTitle(file, messages).toLocaleLowerCase().includes(needle) ||
      matches(file) > 0
  )
  const ordered = sortMemoryPaths(shown.map((file) => file.path))
    .map((path) => shown.find((file) => file.path === path))
    .filter((file): file is MemoryFile => file !== undefined)
  // Top-level notes first, then each folder's under its name.
  const rows: ({ kind: "folder"; name: string } | { kind: "note"; file: MemoryFile })[] = []
  const topLevel = ordered.filter((file) => memoryFolder(file.path) === "")
  for (const file of topLevel) rows.push({ kind: "note", file })
  let folder: string | null = null
  for (const file of ordered.filter((entry) => memoryFolder(entry.path) !== "")) {
    const own = memoryFolder(file.path)
    if (own !== folder) {
      folder = own
      rows.push({ kind: "folder", name: words(own.split("/").join(" / ")) })
    }
    rows.push({ kind: "note", file })
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const title = name.trim()
    if (!title || pending) return
    const slug = title
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
    const path = `${slug || "note"}.md`
    if (view.files.some((file) => file.path === path)) {
      navigate(memoryPageHref({ repo, file: path }))
      setCreating(false)
      return
    }
    const saved = await save([{ path, contents: `# ${title}\n` }], messages.editedMessage(title))
    if (saved !== null) {
      setCreating(false)
      setName("")
      navigate(memoryPageHref({ repo, file: path }))
    }
  }

  return (
    <nav aria-label={messages.notes} className="hidden min-w-0 flex-col gap-px md:flex">
      {rows.length === 0 ? (
        <p className="px-2.5 py-2 text-[0.8125rem] text-muted-foreground">
          {messages.noMatches(query.trim())}
        </p>
      ) : (
        rows.map((row) =>
          row.kind === "folder" ? (
            <div
              key={`folder:${row.name}`}
              className="mt-4 px-2.5 pb-1 text-xs font-medium text-muted-foreground/80"
            >
              {row.name}
            </div>
          ) : (
            <NoteLink
              key={row.file.path}
              repo={repo}
              file={row.file}
              title={noteTitle(row.file, messages)}
              current={active === row.file.path}
              count={needle ? matches(row.file) : memoryEntries(row.file.contents).length}
            />
          )
        )
      )}
      {creating ? (
        <form onSubmit={create} className="mt-3 px-1">
          <Input
            value={name}
            autoFocus
            placeholder={messages.newNotePlaceholder}
            aria-label={messages.newNotePlaceholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setCreating(false)
            }}
            onBlur={() => {
              if (!name.trim()) setCreating(false)
            }}
            className="h-8 text-[0.8125rem]"
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-3 flex h-8 items-center gap-2 rounded-md px-2.5 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
          {messages.newNote}
        </button>
      )}
    </nav>
  )
}

function NoteLink({
  repo,
  file,
  title,
  current,
  count,
}: {
  readonly repo: MemoryRepo
  readonly file: MemoryFile
  readonly title: string
  readonly current: boolean
  readonly count: number
}) {
  const Icon =
    file.path === MEMORY_ENTRY
      ? repo === "user"
        ? UserRound
        : UsersRound
      : memoryFolder(file.path) === "people"
        ? UserRound
        : FileText
  return (
    <Link
      to={memoryPageHref({ repo, file: file.path })}
      title={file.path}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[0.8125rem] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        current
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count > 0 ? (
        <span className="shrink-0 text-xs font-normal tabular-nums opacity-60">{count}</span>
      ) : null}
    </Link>
  )
}
