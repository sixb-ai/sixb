import { isSixbApiError } from "@sixb/client"
import {
  deleteAgentMemoryMutation,
  getAgentMemoryOptions,
  saveAgentMemoryMutation,
} from "@sixb/client/hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Kbd,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Brain,
  ChevronRight,
  Code2,
  File as FileIcon,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  UsersRound,
  X,
} from "lucide-react"
import { type FormEvent, type ReactNode, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { notify, SectionPage } from "../section-page"
import {
  apiErrorMessage,
  Field,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  useLoadFailure,
} from "../section-ui"
import {
  MemoryContents,
  MemoryFileName,
  type MemoryRepoView,
  refreshMemory,
  useFileLabel,
} from "./memory-contents"
import {
  addMemoryEntry,
  type MemoryEntry,
  memoryEntries,
  memoryToday,
  removeMemoryEntry,
  replaceMemoryEntry,
} from "./memory-entries"
import {
  isMemoryNote,
  MEMORY_ENTRY,
  type MemoryRepo,
  memoryPageHref,
  memoryTree,
  sortMemoryPaths,
} from "./memory-files"
import { MemoryHistory } from "./memory-history"
import { useSettingsMessages } from "./messages"

type MemoryFile = MemoryRepoView["files"][number]

/**
 * Settings › Memory: what the chat agent remembers, the signed-in person's own and the project's.
 * Each memory is a row to correct or forget; the files the main memory links to open on their own;
 * History shows every change and restores any of them.
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
  const [forgetting, setForgetting] = useState(false)

  return (
    <SectionPage
      section="settings"
      page="memory"
      // The files beside the one open need the room.
      width="wide"
      title={messages.title}
      description={messages.description}
      actions={
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={repo}
            aria-label={messages.scope}
            onValueChange={(next) => {
              if (next === "user" || next === "project") {
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
                <Button type="button" variant="outline" size="icon-sm" aria-label={messages.more}>
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
        </>
      }
    >
      <Tabs
        value={tab}
        onValueChange={(next) => navigate(memoryPageHref({ repo, history: next === "history" }))}
        className="-mb-2"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-border">
          <TabsList variant="line" className="-mb-px">
            <TabsTrigger value="memories">
              {messages.memoriesTab}
              {remembers ? (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {count}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="history">{messages.historyTab}</TabsTrigger>
          </TabsList>
          <p className="flex items-center gap-1.5 pb-2.5 text-[0.8125rem] text-muted-foreground">
            {repo === "user" ? (
              <Lock className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <UsersRound className="size-3.5 shrink-0" aria-hidden />
            )}
            {repo === "user" ? messages.yoursHint : messages.projectHint}
          </p>
        </div>
      </Tabs>

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
        <MemoriesView key={repo} repo={repo} view={repoQuery.data} path={params.get("file")} />
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

// ---------------------------------------------------------------------------
// Saving: every change on the page is a save of whole files, like the agent's.
// ---------------------------------------------------------------------------

interface MemoryChange {
  readonly path: string
  readonly contents: string | null
}

/**
 * Saves files of the repo from the revision on the page. A save another one beat is refused with a
 * conflict: the page reloads the memory and says so, and what was typed stays where it was.
 */
function useMemorySave(repo: MemoryRepo, view: MemoryRepoView) {
  const messages = useSettingsMessages().memory
  const queryClient = useQueryClient()
  const mutation = useMutation({ ...saveAgentMemoryMutation() })
  const save = async (
    changes: readonly MemoryChange[],
    message: string,
    baseRevision = view.revision
  ): Promise<number | null> => {
    try {
      const saved = await mutation.mutateAsync({
        path: { repo },
        body: { baseRevision, message, changes: [...changes] },
      })
      await refreshMemory(queryClient, repo)
      return saved.revision
    } catch (error) {
      if (isSixbApiError(error) && error.status === 409) {
        notify.error(messages.conflict)
        await refreshMemory(queryClient, repo)
      } else {
        notify.error(apiErrorMessage(error, messages.saveFailed))
      }
      return null
    }
  }
  return { save, pending: mutation.isPending }
}

/** A save's message from what it says, kept short for the history. */
function summary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

/**
 * The memory as files: the tree, with the main memory first and a search, beside the file open,
 * read as a document whose every memory can be corrected or forgotten where it is.
 */
function MemoriesView({
  repo,
  view,
  path,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly path: string | null
}) {
  const messages = useSettingsMessages().memory
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const main = view.files.find((file) => file.path === MEMORY_ENTRY)

  if (view.files.length === 0) {
    return (
      <Panel>
        {adding ? (
          <AddEntryRow
            repo={repo}
            view={view}
            file={{ path: MEMORY_ENTRY, contents: "# Memory\n\n" }}
            onDone={() => setAdding(false)}
          />
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
  return (
    <div className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] md:min-h-[34rem] md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col border-b border-border bg-muted/25 md:border-r md:border-b-0">
        <div className="border-b border-border p-2">
          <InputGroup className="h-8 bg-background">
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={messages.search}
              aria-label={messages.search}
              className="text-[0.8125rem]"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => setQuery("")}
                  aria-label={messages.clearSearch}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>
        <nav
          aria-label={messages.files}
          className="max-h-72 min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none"
        >
          {file ? <FileTree repo={repo} view={view} query={query} active={file.path} /> : null}
        </nav>
      </aside>
      {file ? <FileView key={file.path} repo={repo} view={view} file={file} /> : null}
    </div>
  )
}

/**
 * The files as they are laid out, the main memory pinned first. A search keeps the files whose
 * name or text holds it, with how many lines do.
 */
function FileTree({
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
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const needle = query.trim().toLocaleLowerCase()
  const matches = (file: MemoryFile) =>
    needle === ""
      ? null
      : file.contents.split("\n").filter((line) => line.toLocaleLowerCase().includes(needle)).length
  const shown = view.files.filter(
    (file) =>
      needle === "" || file.path.toLocaleLowerCase().includes(needle) || (matches(file) ?? 0) > 0
  )
  const byPath = new Map(shown.map((file) => [file.path, file]))
  const main = byPath.get(MEMORY_ENTRY)
  const rows = memoryTree(
    sortMemoryPaths([...byPath.keys()]).filter((path) => path !== MEMORY_ENTRY)
  )
  // A search shows every match, whatever folders were closed.
  const hidden = (path: string) =>
    needle === "" && [...closed].some((folder) => path.startsWith(`${folder}/`))

  if (shown.length === 0) {
    return (
      <p className="px-2 py-3 text-[0.8125rem] text-muted-foreground">
        {messages.noMatches(query.trim())}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-px">
      {main ? (
        <li className="mb-1.5 border-b border-border pb-1.5">
          <TreeFile
            repo={repo}
            path={MEMORY_ENTRY}
            name={messages.mainMemory}
            depth={0}
            current={active === MEMORY_ENTRY}
            count={matches(main)}
          />
        </li>
      ) : null}
      {rows.map((row) =>
        hidden(row.path) ? null : row.kind === "folder" ? (
          <li key={`folder:${row.path}`}>
            <button
              type="button"
              aria-expanded={!closed.has(row.path)}
              onClick={() =>
                setClosed((current) => {
                  const next = new Set(current)
                  if (next.has(row.path)) next.delete(row.path)
                  else next.add(row.path)
                  return next
                })
              }
              style={{ paddingLeft: `${0.25 + row.depth * 0.875}rem` }}
              className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[0.8125rem] text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  !closed.has(row.path) && "rotate-90"
                )}
              />
              {closed.has(row.path) ? (
                <Folder aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <FolderOpen aria-hidden className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{row.name}</span>
            </button>
          </li>
        ) : (
          <li key={`file:${row.path}`}>
            <TreeFile
              repo={repo}
              path={row.path}
              name={row.name}
              depth={row.depth}
              current={active === row.path}
              count={matches(byPath.get(row.path) ?? { path: row.path, contents: "" })}
            />
          </li>
        )
      )}
    </ul>
  )
}

function TreeFile({
  repo,
  path,
  name,
  depth,
  current,
  count,
}: {
  readonly repo: MemoryRepo
  readonly path: string
  readonly name: string
  readonly depth: number
  readonly current: boolean
  /** Lines holding the search, while there is one. */
  readonly count: number | null
}) {
  return (
    <Link
      to={memoryPageHref({ repo, file: path })}
      title={path}
      aria-current={current ? "page" : undefined}
      // A file sits under its folder's name, past the folder's chevron.
      style={{ paddingLeft: `${(depth === 0 ? 0.5 : 1.375) + Math.max(0, depth - 1) * 0.875}rem` }}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-[0.8125rem] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        current
          ? "bg-background font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <FileIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {count ? <span className="shrink-0 text-xs tabular-nums opacity-70">{count}</span> : null}
    </Link>
  )
}

/**
 * One file, read as a document. Each memory in it shows its actions on hover, edits in place and
 * forgets with an undo; the whole file can be read as source or edited as text.
 */
function FileView({
  repo,
  view,
  file,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly file: MemoryFile
}) {
  const messages = useSettingsMessages().memory
  const label = useFileLabel()
  const navigate = useNavigate()
  const { save, pending } = useMemorySave(repo, view)
  const [mode, setMode] = useState<"read" | "source" | "text" | "add">("read")
  const [editing, setEditing] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const name = label(file.path)
  const note = isMemoryNote(file.path)
  const entries = useMemo(() => memoryEntries(file.contents), [file.contents])

  const forget = async (entry: MemoryEntry) => {
    const before = file.contents
    const saved = await save(
      [{ path: file.path, contents: removeMemoryEntry(before, entry) }],
      messages.forgotMessage(summary(entry.text))
    )
    if (saved === null) return
    notify.undoable(messages.forgotten, {
      label: messages.undo,
      onUndo: () => void save([{ path: file.path, contents: before }], messages.undoMessage, saved),
    })
  }

  const entryItem = (line: number, content: ReactNode) => {
    const entry = entries.find((candidate) => candidate.line === line)
    if (!entry) return content
    if (editing === line) {
      return (
        <EntryForm
          initial={entry.text}
          submitLabel={messages.save}
          pending={pending}
          className="-ml-1 py-1"
          onCancel={() => setEditing(null)}
          onSubmit={async (text) => {
            const saved = await save(
              [{ path: file.path, contents: replaceMemoryEntry(file.contents, entry, text) }],
              summary(text)
            )
            if (saved !== null) {
              setEditing(null)
              notify.success(messages.saved)
            }
          }}
        />
      )
    }
    return (
      <div className="group/entry relative -mx-2 rounded-md px-2 pr-10 transition-colors hover:bg-muted/50">
        {content}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              aria-label={messages.entryActions}
              className="absolute top-0.5 right-1 text-muted-foreground opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(line)}>
              <Pencil />
              {messages.edit}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void forget(entry)}>
              <Trash2 />
              {messages.forgetEntry}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <article className="flex min-w-0 flex-col">
      <header className="flex min-h-12 items-center gap-2 border-b border-border px-5 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[0.8125rem]" title={file.path}>
          <MemoryFileName path={file.path} />
        </h2>
        {mode === "text" ? null : (
          <div className="flex items-center gap-1">
            {note ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setMode("add")}
              >
                <Plus />
                {messages.add}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={mode === "source"}
              aria-label={mode === "source" ? messages.showDocument : messages.showSource}
              title={mode === "source" ? messages.showDocument : messages.showSource}
              onClick={() => setMode((current) => (current === "source" ? "read" : "source"))}
              className={cn("size-7", mode === "source" && "bg-muted text-foreground")}
            >
              <Code2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={messages.fileActions}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setMode("text")}>
                  <Pencil />
                  {messages.editAsText}
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
        <TextEditor
          name={name}
          contents={file.contents}
          pending={pending}
          onCancel={() => setMode("read")}
          onSave={async (contents, noteText) => {
            const saved = await save(
              [{ path: file.path, contents }],
              noteText || messages.editedMessage(name)
            )
            if (saved !== null) {
              setMode("read")
              notify.success(messages.saved)
            }
          }}
        />
      ) : mode === "source" ? (
        <pre className="min-w-0 overflow-x-auto px-7 py-6 font-mono text-[0.8125rem] leading-6 whitespace-pre-wrap text-foreground/90">
          {file.contents}
        </pre>
      ) : (
        <>
          {mode === "add" ? (
            <div className="border-b border-border">
              <AddEntryRow repo={repo} view={view} file={file} onDone={() => setMode("read")} />
            </div>
          ) : null}
          {file.contents.trim() === "" ? (
            <PanelEmpty icon={Brain} title={messages.fileEmpty} />
          ) : (
            <MemoryContents repo={repo} view={view} file={file} {...(note ? { entryItem } : {})} />
          )}
        </>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={messages.deleteFileTitle(name)}
        description={messages.deleteFileDescription}
        action={messages.deleteFile}
        onConfirm={async () => {
          const saved = await save(
            [{ path: file.path, contents: null }],
            messages.deletedMessage(name)
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

/** A new memory, typed in place at the top of the list it goes to. */
function AddEntryRow({
  repo,
  view,
  file,
  onDone,
}: {
  readonly repo: MemoryRepo
  readonly view: MemoryRepoView
  readonly file: MemoryFile
  readonly onDone: () => void
}) {
  const messages = useSettingsMessages().memory
  const { save, pending } = useMemorySave(repo, view)
  return (
    <EntryForm
      initial=""
      placeholder={repo === "user" ? messages.addPlaceholderYours : messages.addPlaceholderProject}
      submitLabel={messages.add}
      pending={pending}
      onCancel={onDone}
      onSubmit={async (text) => {
        const saved = await save(
          [{ path: file.path, contents: addMemoryEntry(file.contents, text, memoryToday()) }],
          summary(text)
        )
        if (saved !== null) {
          onDone()
          notify.success(messages.addedMemory)
        }
      }}
    />
  )
}

/** The field a memory is written in: Enter saves it, Escape leaves it as it was. */
function EntryForm({
  initial,
  placeholder,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  className,
}: {
  readonly initial: string
  readonly placeholder?: string
  /** In place of the strip it is on its own, such as inside a document. */
  readonly className?: string
  readonly submitLabel: string
  readonly pending: boolean
  readonly onSubmit: (text: string) => void | Promise<void>
  readonly onCancel: () => void
}) {
  const cancel = useSettingsMessages().common.cancel
  const [text, setText] = useState(initial)
  const ready = text.trim() !== "" && text.trim() !== initial.trim()
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (ready && !pending) void onSubmit(text.trim())
  }
  return (
    <form
      onSubmit={submit}
      className={cn(
        "flex flex-col gap-2.5 sm:flex-row sm:items-center",
        className ?? "bg-muted/30 px-5 py-3.5"
      )}
    >
      <Input
        value={text}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder ?? submitLabel}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel()
        }}
        className="h-9 flex-1 bg-background text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!ready || pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** A whole file as text, for what the list of memories cannot change, such as its headings. */
function TextEditor({
  name,
  contents,
  pending,
  onSave,
  onCancel,
}: {
  readonly name: string
  readonly contents: string
  readonly pending: boolean
  readonly onSave: (contents: string, note: string) => void | Promise<void>
  readonly onCancel: () => void
}) {
  const allMessages = useSettingsMessages()
  const messages = allMessages.memory
  const [draft, setDraft] = useState(contents)
  const [note, setNote] = useState("")
  const changed = draft !== contents
  const submit = () => {
    if (changed && !pending) void onSave(draft, note.trim())
  }
  return (
    <form
      className="flex flex-col gap-4 border-t border-border p-5"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Textarea
        aria-label={messages.editing(name)}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
          // Escape leaves only an untouched draft, so a stray key loses nothing.
          if (event.key === "Escape" && !changed) onCancel()
        }}
        spellCheck={false}
        className="min-h-80 resize-y font-mono text-[0.8125rem] leading-6"
      />
      <Field label={messages.note} htmlFor="memory-note">
        <Input
          id="memory-note"
          value={note}
          placeholder={messages.notePlaceholder}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Kbd>{isApplePlatform() ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>↵</Kbd>
          {messages.saveHint}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {allMessages.common.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !changed}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {pending ? messages.saving : messages.save}
        </Button>
      </div>
    </form>
  )
}

/** Whether the reader's keyboard has ⌘, for the shortcut the editor names. */
function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "")
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: ReactNode
  readonly action: string
  readonly onConfirm: () => void | Promise<void>
}) {
  const cancel = useSettingsMessages().common.cancel
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onConfirm()}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Delete the repo with its history, after a confirmation. */
function ForgetDialog({
  repo,
  open,
  onOpenChange,
}: {
  readonly repo: MemoryRepo
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const messages = useSettingsMessages().memory
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const forget = useMutation({
    ...deleteAgentMemoryMutation(),
    onSuccess: async () => {
      notify.success(messages.forgottenAll)
      navigate(memoryPageHref({ repo }))
      await refreshMemory(queryClient, repo)
    },
    onError: (error) =>
      notify.error(
        isSixbApiError(error) && error.status === 403
          ? messages.forgetDenied
          : apiErrorMessage(error, messages.forgetFailed)
      ),
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={messages.forgetConfirmTitle}
      description={repo === "user" ? messages.forgetConfirmYours : messages.forgetConfirmProject}
      action={messages.forgetConfirm}
      onConfirm={() => forget.mutate({ path: { repo } })}
    />
  )
}
