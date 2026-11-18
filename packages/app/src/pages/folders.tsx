/**
 * Browsing a list of definitions by the folders they sit in: `datasets/raw/erp/orders.ts` puts
 * `orders` in the folder `raw/erp`. A list page shows its top level with a tile for each folder,
 * and opening one becomes the page itself, titled by the folder with a way back up, the way a
 * detail page is. Searching looks through every folder at once and groups what it finds by
 * folder. A project without folders sees its lists exactly as before.
 *
 * The open folder lives in the URL (`?folder=raw/erp`), so the browser's back button, reloads and
 * shared links all keep it.
 */
import { defineMessages, type MessageTree, plural, type Translation } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { type ReactNode, useMemo } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"

export const en = {
  items: (count: number) => plural("en", count, { one: "1 item", other: `${count} items` }),
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  items: (count: number) => plural("fr", count, { one: "1 élément", other: `${count} éléments` }),
}

const useFolderMessages = defineMessages<typeof en>({ en, fr }).useMessages

const FOLDER_PARAM = "folder"

/** A definition as the API lists it: in a folder below its directory, or at its top. */
export interface Foldered {
  readonly folder?: string
}

/** One empty list for every page to start from while its query loads, so memos hold. */
export const noItems: readonly never[] = []

export interface FolderTile {
  /** The folder's own name, such as `erp`. */
  readonly name: string
  /** Its full path, such as `raw/erp`. */
  readonly path: string
  /** Everything inside it, in subfolders too. */
  readonly count: number
  readonly href: string
}

export interface FolderGroup<TItem> {
  /** Undefined for the items at the top. */
  readonly folder: string | undefined
  readonly items: readonly TItem[]
}

export interface FolderBrowser<TItem> {
  /** The open folder's subfolders, by name. */
  readonly folders: readonly FolderTile[]
  /** The items directly in the open folder. */
  readonly items: readonly TItem[]
  /** While the list is narrowed, every match grouped by folder, the top first. */
  readonly groups: readonly FolderGroup<TItem>[] | undefined
  /** What the page's header shows: the list's own at the top, the folder's inside one. */
  readonly frame: {
    readonly title: string
    readonly description?: string
    readonly back?: { readonly href: string; readonly label: string }
    readonly meta?: ReactNode
  }
}

/**
 * Arrange `items` by folder for the page at the current URL. Pass every item while nothing narrows
 * the list, and only the matches with `narrowed` while a search or filter does: folders then give
 * way to the matches from all of them, grouped by folder.
 */
export function useFolderBrowser<TItem extends Foldered>({
  items,
  title,
  description,
  meta,
  narrowed = false,
}: {
  readonly items: readonly TItem[]
  /** The list's own title and description, shown at the top. */
  readonly title: string
  readonly description?: string
  readonly meta?: ReactNode
  readonly narrowed?: boolean
}): FolderBrowser<TItem> {
  const messages = useFolderMessages()
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const arranged = useMemo(
    () => arrangeByFolder(items, searchParams.get(FOLDER_PARAM) ?? undefined, narrowed),
    [items, narrowed, searchParams]
  )

  const hrefFor = (folder: string | undefined) => {
    const params = new URLSearchParams(searchParams)
    if (folder) params.set(FOLDER_PARAM, folder)
    else params.delete(FOLDER_PARAM)
    // A folder's slashes read better left as they are, and a query allows them.
    const query = params.toString().replaceAll("%2F", "/")
    return query ? `${pathname}?${query}` : pathname
  }

  const { folder } = arranged
  const parent = folder ? parentOf(folder) : undefined
  return {
    items: arranged.items,
    groups: arranged.groups,
    folders: arranged.folders.map((tile) => ({ ...tile, href: hrefFor(tile.path) })),
    frame: folder
      ? {
          title: nameOf(folder),
          back: { href: hrefFor(parent), label: parent ? nameOf(parent) : title },
          meta: <span className="tabular-nums">{messages.items(arranged.total)}</span>,
        }
      : { title, description, meta },
  }
}

/** What a list holds at one folder, before it becomes links and a page header. */
export interface FolderArrangement<TItem> {
  /** The open folder, or `undefined` at the top. */
  readonly folder: string | undefined
  readonly folders: readonly Omit<FolderTile, "href">[]
  readonly items: readonly TItem[]
  readonly groups: readonly FolderGroup<TItem>[] | undefined
  /** Everything in the open folder, in its subfolders too. */
  readonly total: number
}

/**
 * The open folder's subfolders, each with how much it holds, and the items directly in it; or
 * while `narrowed`, every item grouped by its folder. A folder nothing is in any more, say after
 * its files moved, opens the top instead.
 */
export function arrangeByFolder<TItem extends Foldered>(
  items: readonly TItem[],
  requested: string | undefined,
  narrowed: boolean
): FolderArrangement<TItem> {
  if (narrowed) {
    const byFolder = new Map<string | undefined, TItem[]>()
    for (const item of items) {
      const group = byFolder.get(item.folder)
      if (group) group.push(item)
      else byFolder.set(item.folder, [item])
    }
    const groups = [...byFolder.entries()]
      .sort(([left], [right]) => compareFolders(left, right))
      .map(([folder, grouped]) => ({ folder, items: grouped }))
    return { folder: undefined, folders: [], items, groups, total: items.length }
  }

  const within = requested ? items.filter((item) => isWithin(item.folder, requested)) : items
  const folder = requested && within.length > 0 ? requested : undefined
  const inFolder = folder ? within : items

  const counts = new Map<string, number>()
  const direct: TItem[] = []
  for (const item of inFolder) {
    if (item.folder === folder) {
      direct.push(item)
      continue
    }
    // Inside `folder`, so `item.folder` is longer than it and its next segment is the subfolder.
    const rest = folder ? item.folder?.slice(folder.length + 1) : item.folder
    const name = rest?.split("/")[0]
    if (!name) continue
    const child = folder ? `${folder}/${name}` : name
    counts.set(child, (counts.get(child) ?? 0) + 1)
  }
  const folders = [...counts.entries()]
    .map(([path, count]) => ({ name: nameOf(path), path, count }))
    .sort((left, right) => compareNames(left.name, right.name))

  return { folder, folders, items: direct, groups: undefined, total: inFolder.length }
}

/**
 * A folder browser's body: the open folder's subfolders as tiles, then its items through
 * `children`, or while narrowed each folder's matches under its name. `children` only runs for a
 * non-empty list, so a folder holding only folders shows no empty list.
 */
export function FolderContents<TItem>({
  browser,
  rootLabel,
  children,
}: {
  readonly browser: FolderBrowser<TItem>
  /** Names the matches at the top while narrowed, such as "Datasets". */
  readonly rootLabel: string
  readonly children: (items: readonly TItem[]) => ReactNode
}) {
  if (browser.groups) {
    // With every match in one place, as in a project without folders, a heading would only repeat
    // the page.
    if (browser.groups.length < 2) return <>{children(browser.items)}</>
    return (
      <div className="flex flex-col gap-6">
        {browser.groups.map((group) => (
          <section key={group.folder ?? ""} className="flex flex-col gap-2.5">
            <FolderHeading folder={group.folder} rootLabel={rootLabel} />
            {children(group.items)}
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {browser.folders.length > 0 ? <FolderTiles folders={browser.folders} /> : null}
      {browser.items.length > 0 ? children(browser.items) : null}
    </div>
  )
}

function FolderTiles({ folders }: { readonly folders: readonly FolderTile[] }) {
  const messages = useFolderMessages()
  return (
    // As many columns as fit tiles wide enough for a usual name, so names are read, not cut: one
    // on a phone.
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12.5rem),1fr))] gap-2.5">
      {folders.map((folder) => (
        <li key={folder.path} className="min-w-0">
          <Link
            to={folder.href}
            title={folder.name}
            className={cn(
              "group flex h-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5",
              "shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] outline-none transition-[background-color,border-color,transform] duration-150",
              "hover:border-foreground/15 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
              "motion-safe:active:scale-[0.985]"
            )}
          >
            <FolderGlyph className="h-7 w-8 shrink-0" />
            <span className="min-w-0 flex-1">
              {/* A name too long for its tile wraps, at its hyphens first, rather than lose its end. */}
              <span className="line-clamp-2 text-sm leading-5 font-medium break-words">
                {folder.name}
              </span>
              <span className="block text-xs leading-4 tabular-nums text-muted-foreground">
                {messages.items(folder.count)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** A folder's full path over its matches, with a glyph that says what it is. */
function FolderHeading({
  folder,
  rootLabel,
}: {
  readonly folder: string | undefined
  readonly rootLabel: string
}) {
  return (
    <h3 className="flex min-w-0 items-center gap-2 px-0.5 text-[0.8125rem] leading-5 font-medium text-muted-foreground">
      {/* The top is the list itself, not a folder. */}
      {folder ? <FolderGlyph className="h-3.5 w-4 shrink-0" /> : null}
      <span className="truncate">{folder ? folder.replaceAll("/", " / ") : rootLabel}</span>
    </h3>
  )
}

/** A folder, drawn as one: its tab behind, its front over it, in a quiet system blue. */
function FolderGlyph({ className }: { readonly className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 32 26" className={className}>
      <path
        d="M1.5 5A3.5 3.5 0 0 1 5 1.5h6.2a3 3 0 0 1 2.1.88L15.4 4.5H27A3.5 3.5 0 0 1 30.5 8v2h-29z"
        className="fill-[#6aa6e6] dark:fill-[#3f6fa3]"
      />
      <rect
        x="1.5"
        y="7"
        width="29"
        height="17.5"
        rx="3.25"
        className="fill-[#8cc0f2] dark:fill-[#5288c2]"
      />
      <path d="M2.75 9.25h26.5" className="stroke-white/40 dark:stroke-white/15" strokeWidth="1" />
    </svg>
  )
}

/**
 * Where a detail page's back link goes: its folder when it has one, so leaving a definition
 * returns to where it was found, or the list itself.
 */
export function folderBack(
  list: { readonly href: string; readonly label: string },
  folder: string | undefined
): { readonly href: string; readonly label: string } {
  if (!folder) return list
  return { href: `${list.href}?${FOLDER_PARAM}=${encodeFolder(folder)}`, label: nameOf(folder) }
}

function encodeFolder(folder: string): string {
  return folder.split("/").map(encodeURIComponent).join("/")
}

/** Whether `folder` is `ancestor` or inside it. Everything is within the top. */
function isWithin(folder: string | undefined, ancestor: string | undefined): boolean {
  if (ancestor === undefined) return true
  if (folder === undefined) return false
  return folder === ancestor || folder.startsWith(`${ancestor}/`)
}

function nameOf(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1)
}

function parentOf(folder: string): string | undefined {
  const slash = folder.lastIndexOf("/")
  return slash === -1 ? undefined : folder.slice(0, slash)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function compareNames(left: string, right: string): number {
  return collator.compare(left, right)
}

/** The top first, then folders by path. */
function compareFolders(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  return compareNames(left, right)
}
