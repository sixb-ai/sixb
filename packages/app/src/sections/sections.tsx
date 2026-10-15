import type { GroupDefinition } from "@sixb/core"
import {
  Braces,
  Cable,
  Database,
  Layers,
  RefreshCw,
  Settings,
  ShieldCheck,
  UserRound,
  UsersRound,
  Workflow,
} from "lucide-react"
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react"
import { useLocation } from "react-router-dom"
import { useAppMessages } from "../locale"
import { type CurrentUser, useCurrentUser } from "../session"
import type { NavEntry, NavItem } from "../shell/nav-items"
import {
  type AppSectionId,
  type SectionDefinition,
  type SectionPageDefinition,
  sectionCatalog,
} from "./catalog"

/**
 * Who sees each built-in section, exported from `app/layout.tsx`. A section left out is open to
 * every signed-in person; `[]` hides it from everyone. It hides screens and protects no data: each
 * page's API still checks the person's own permissions.
 */
export type AppVisibility = { readonly [Section in AppSectionId]?: readonly GroupDefinition[] }

/** A built-in section with the pages this person may open, for drawing navigation. */
export interface AppSection {
  readonly id: AppSectionId
  readonly label: string
  /** The section's first page this person may open. */
  readonly href: string
  readonly icon: ComponentType<{ readonly className?: string }>
  /** Grouped as `NavItems` takes them. */
  readonly pages: readonly NavEntry[]
}

interface SectionsContextValue {
  readonly enabled: boolean
  readonly visibility: AppVisibility | undefined
}

// Off until the generated app says its built-in section pages exist, so a shell rendered
// anywhere else never links to pages that are not there.
const SectionsContext = createContext<SectionsContextValue>({
  enabled: false,
  visibility: undefined,
})

export interface SectionsProviderProps {
  readonly visibility: AppVisibility | undefined
  /** Shared links open one page under a grant, so they get no sections. */
  readonly enabled?: boolean
  readonly children: ReactNode
}

/** Carries the project's `visibility` export to every section part. Rendered by the generated app. */
export function SectionsProvider({ visibility, enabled = true, children }: SectionsProviderProps) {
  const value = useMemo(() => ({ enabled, visibility }), [enabled, visibility])
  return <SectionsContext.Provider value={value}>{children}</SectionsContext.Provider>
}

export interface OpenSection {
  readonly definition: SectionDefinition
  readonly pages: readonly SectionPageDefinition[]
}

/**
 * The sections and pages one person may open. Without a signed-in person (auth off) every section
 * that does not need one is open; `visibility` only narrows what a signed-in person sees.
 */
export function resolveOpenSections(input: {
  readonly user: Pick<CurrentUser, "groupIds"> | null
  readonly visibility: AppVisibility | undefined
  readonly enabled: boolean
}): readonly OpenSection[] {
  if (!input.enabled) return []
  return sectionCatalog.flatMap((definition) => {
    if (definition.requiresUser && !input.user) return []
    const admitted = !input.user || admits(input.visibility?.[definition.id], input.user.groupIds)
    const pages = definition.pages.filter((page) => page.always === true || admitted)
    return pages.length > 0 ? [{ definition, pages }] : []
  })
}

function admits(groups: readonly GroupDefinition[] | undefined, groupIds: readonly string[]) {
  if (groups === undefined) return true
  return groups.some((group) => groupIds.includes(group.id))
}

/** The sections this person may open, internal shape. */
export function useOpenSections(): readonly OpenSection[] {
  const { enabled, visibility } = useContext(SectionsContext)
  const user = useCurrentUser()
  return useMemo(
    () => resolveOpenSections({ user, visibility, enabled }),
    [user, visibility, enabled]
  )
}

const sectionIcons: Record<AppSectionId, ComponentType<{ readonly className?: string }>> = {
  settings: Settings,
  data: Database,
}

const pageIcons: Record<string, ComponentType<{ readonly className?: string }>> = {
  personal: UserRound,
  developers: Braces,
  members: UsersRound,
  "service-accounts": ShieldCheck,
  connectors: Cable,
  syncs: RefreshCw,
  datasets: Database,
  pipelines: Workflow,
  projections: Layers,
}

/**
 * The built-in sections this person may open, with their pages, for a shell drawn by hand. Each
 * holds only the pages the project's `visibility` lets this person see.
 */
export function useSections(): readonly AppSection[] {
  const open = useOpenSections()
  const messages = useAppMessages().sections
  return useMemo(
    () =>
      open.map(({ definition, pages }) => {
        const labels = messages[definition.id]
        const pageLabels: Record<string, string> = labels.pages
        const groupLabels: Record<string, string> = "groups" in labels ? labels.groups : {}
        // Ungrouped pages stand alone; consecutive pages of one group share its heading.
        const entries: NavEntry[] = []
        let current: { readonly key: string; readonly items: NavItem[] } | undefined
        for (const page of pages) {
          const item: NavItem = {
            label: pageLabels[page.id] ?? page.id,
            href: page.path,
            icon: pageIcons[page.id],
          }
          if (!page.group) {
            entries.push(item)
            current = undefined
            continue
          }
          if (current?.key !== page.group) {
            current = { key: page.group, items: [] }
            entries.push({ group: groupLabels[page.group] ?? page.group, items: current.items })
          }
          current.items.push(item)
        }
        return {
          id: definition.id,
          label: labels.label,
          href: pages[0]?.path ?? definition.path,
          icon: sectionIcons[definition.id],
          pages: entries,
        }
      }),
    [open, messages]
  )
}

/**
 * The built-in section the current page belongs to, or `null` outside one. A shell drawn by hand
 * uses it to give section pages the whole frame: they bring their own margins, and some, such as a
 * dataset's rows, fill the height. A project's page that replaces a section page is in the section
 * too.
 */
export function useCurrentSection(): AppSection | null {
  const { pathname } = useLocation()
  return useSections().find((section) => sectionContains(section, pathname)) ?? null
}

/** Whether `pathname` is one of the section's pages, or below one. */
export function sectionContains(section: AppSection, pathname: string): boolean {
  return section.pages.some((entry) =>
    ("group" in entry ? entry.items : [entry]).some(
      (page) => pathname === page.href || pathname.startsWith(`${page.href}/`)
    )
  )
}

// A section shows its pages in the sidebar when the shell has a `SectionNav`, and as tabs above
// the page otherwise. The count is module state because a shell and a page share no parent the
// framework owns; registering in a layout effect settles it before the first paint.
let mountedSectionNavs = 0
const sectionNavListeners = new Set<() => void>()

function subscribeSectionNav(listener: () => void): () => void {
  sectionNavListeners.add(listener)
  return () => sectionNavListeners.delete(listener)
}

function notifySectionNav(): void {
  for (const listener of sectionNavListeners) listener()
}

/** Marks that the shell draws section pages in its sidebar. */
export function useRegisterSectionNav(): void {
  useLayoutEffect(() => {
    mountedSectionNavs += 1
    notifySectionNav()
    return () => {
      mountedSectionNavs -= 1
      notifySectionNav()
    }
  }, [])
}

/** Whether a `SectionNav` is on screen, so a section page can leave out its own tabs. */
export function useSectionNavMounted(): boolean {
  return useSyncExternalStore(
    subscribeSectionNav,
    () => mountedSectionNavs > 0,
    () => false
  )
}
