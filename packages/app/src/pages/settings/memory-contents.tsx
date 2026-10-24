import type { GetAgentMemoryResponse } from "@sixb/client"
import { getAgentMemoryQueryKey, listAgentMemoryRevisionsQueryKey } from "@sixb/client/hooks"
import { Markdown } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import type { QueryClient } from "@tanstack/react-query"
import { Children, type ComponentProps, type ReactNode, useMemo } from "react"
import { Link } from "react-router-dom"
import {
  isMemoryNote,
  linkMemoryFiles,
  MEMORY_ENTRY,
  type MemoryRepo,
  memoryFileHref,
  memoryFileName,
  memoryFolder,
  memoryLinkName,
} from "./memory-files"
import { useSettingsMessages } from "./messages"

export type MemoryRepoView = GetAgentMemoryResponse

/** A file as the page names it in text: the main memory, or its path without `.md`. */
export function useFileLabel(): (path: string) => string {
  const main = useSettingsMessages().memory.mainMemory
  return (path) => (path === MEMORY_ENTRY ? main : memoryFileName(path))
}

/** A file's name with its folders quieter than the file itself. */
export function MemoryFileName({ path }: { readonly path: string }) {
  const label = useFileLabel()
  const folder = memoryFolder(path)
  if (path === MEMORY_ENTRY) return <span className="font-medium">{label(path)}</span>
  return (
    <>
      {folder ? <span className="text-muted-foreground">{folder}/</span> : null}
      <span className="font-medium">{label(path.slice(folder ? folder.length + 1 : 0))}</span>
    </>
  )
}

/**
 * A memory file read as a document, its `[[links]]` opening the files they name. With `entryItem`,
 * the page fills each top-level entry itself, by the line it is on in the file, such as to add its
 * actions.
 */
export function MemoryContents({
  repo,
  view,
  file,
  links = true,
  entryItem,
}: {
  readonly repo: MemoryRepo
  readonly view: Pick<MemoryRepoView, "files">
  readonly file: MemoryRepoView["files"][number]
  readonly links?: boolean
  readonly entryItem?: (line: number, content: ReactNode) => ReactNode
}) {
  const paths = useMemo(() => new Set(view.files.map((entry) => entry.path)), [view.files])
  const markdown = isMemoryNote(file.path)
    ? linkMemoryFiles(
        file.contents,
        links ? paths : new Set(),
        (path) => memoryFileHref(repo, path),
        memoryLinkName
      )
    : // Another file, such as a saved query, reads as the code it is.
      `\`\`\`${file.path.slice(file.path.lastIndexOf(".") + 1)}\n${file.contents}\n\`\`\``
  const components = useMemo(
    () => ({
      a: MemoryLink,
      li: ({ node, children, ...props }: ComponentProps<"li"> & { node?: MarkdownNode }) => {
        const content = <EntryContent>{children}</EntryContent>
        // Linking files changes words, not lines, so the node's line is the file's.
        const line = node?.position?.start.line
        return (
          <li {...props}>
            {entryItem && line !== undefined ? entryItem(line - 1, content) : content}
          </li>
        )
      },
    }),
    [entryItem]
  )
  return (
    // At the size of the page around it, not of a document: `.prose` sets its own, outside layers.
    <Markdown
      className="min-w-0 px-7 py-6 !text-sm !leading-6 [&_h1]:!mb-4 [&_h1]:!text-xl [&_h1]:!font-semibold [&_h2]:!mt-7 [&_h2]:!mb-2 [&_h2]:!text-base [&_h3]:!mt-5 [&_h3]:!text-sm [&_li]:!my-1 [&_ol]:!mb-4 [&_p]:!mb-3 [&_pre]:!mb-3 [&_ul]:!mb-4 [&_ul]:!pl-5 [&_ul_li::marker]:text-muted-foreground/60"
      components={components}
    >
      {markdown}
    </Markdown>
  )
}

interface MarkdownNode {
  readonly position?: { readonly start: { readonly line: number } }
}

/** The date an entry ends with, which the page reads apart from the entry. */
export const ADDED = /\s*\(added (\d{4}-\d{2}-\d{2})\)\s*$/

/** An entry's words, with the date it was added read as a quiet date rather than as words. */
function EntryContent({ children }: { readonly children?: ReactNode }) {
  const messages = useSettingsMessages().memory
  const entryDate = useEntryDate()
  const parts = Children.toArray(children)
  const last = parts.at(-1)
  const added = typeof last === "string" ? last.match(ADDED) : null
  if (!added?.[1] || typeof last !== "string") return <>{children}</>
  return (
    <>
      {parts.slice(0, -1)}
      {last.slice(0, added.index)}
      <span
        title={added[1]}
        className="ml-2 text-xs whitespace-nowrap text-muted-foreground/80 tabular-nums"
      >
        {messages.added(entryDate(added[1]))}
      </span>
    </>
  )
}

/** A day written `YYYY-MM-DD`, in the reader's locale, its year left out when it is this one. */
export function useEntryDate(): (day: string) => string {
  const locale = useLocale()
  return (day) => {
    // Noon, so no time zone moves the day.
    const date = new Date(`${day}T12:00:00`)
    if (Number.isNaN(date.getTime())) return day
    const thisYear = date.getFullYear() === new Date().getFullYear()
    return date.toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(thisYear ? {} : { year: "numeric" }),
    })
  }
}

/** A link between memory files stays on the page; any other opens outside it. */
function MemoryLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  if (href?.startsWith("?")) {
    return (
      <Link
        to={href}
        className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] transition-colors hover:decoration-foreground"
      >
        {children}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  )
}

/** Reload the repo, every revision of it read for the history, and its history. */
export function refreshMemory(queryClient: QueryClient, repo: MemoryRepo) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getAgentMemoryQueryKey({ path: { repo } }) }),
    queryClient.invalidateQueries({
      queryKey: listAgentMemoryRevisionsQueryKey({ path: { repo } }),
    }),
  ])
}
