import {
  Bolt,
  Box,
  Braces,
  Brain,
  Cable,
  ChartNoAxesCombined,
  Database,
  GitBranch,
  Layers,
  LayoutGrid,
  ListChecks,
  MousePointerClick,
  Network,
  RefreshCw,
  ScrollText,
  Settings,
  SquareTerminal,
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
import { useCurrentUser, useSessionAccess } from "../session"
import { isCurrentItem, type NavEntry, type NavItem } from "../shell/nav-items"
import {
  type AppSectionId,
  type SectionAccess,
  type SectionDefinition,
  type SectionPageDefinition,
  sectionCatalog,
} from "./catalog"

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

// Off until the generated app says its built-in section pages exist, so a shell rendered
// anywhere else never links to pages that are not there.
const SectionsContext = createContext(false)

export interface SectionsProviderProps {
  /** Shared links open one page under a grant, so they get no sections. */
  readonly enabled?: boolean
  readonly children: ReactNode
}

/** Says the built-in section pages exist. Rendered by the generated app. */
export function SectionsProvider({ enabled = true, children }: SectionsProviderProps) {
  return <SectionsContext.Provider value={enabled}>{children}</SectionsContext.Provider>
}

export interface OpenSection {
  readonly definition: SectionDefinition
  readonly pages: readonly SectionPageDefinition[]
}

/**
 * The sections and pages one person may open. Without a signed-in person (auth off) every section
 * that does not need one is open, all its pages included. Signed in, a section or page that
 * `requires` something opens when the session's `access` allows any of it. Hiding a screen
 * protects no data: each page's API still checks the person's own grants.
 */
export function resolveOpenSections(input: {
  readonly signedIn: boolean
  readonly access: Readonly<Record<SectionAccess, boolean>> | null
  readonly enabled: boolean
}): readonly OpenSection[] {
  if (!input.enabled) return []
  return sectionCatalog.flatMap((definition) => {
    if (definition.requiresUser && !input.signedIn) return []
    const allows = (requires: readonly SectionAccess[] | undefined) =>
      !input.signedIn || !requires || requires.some((need) => input.access?.[need] === true)
    if (!allows(definition.requires)) return []
    const pages = definition.pages.filter((page) => allows(page.requires))
    return pages.length > 0 ? [{ definition, pages }] : []
  })
}

/** Whether this person may open a section, such as the Console a page links into. */
export function useSectionOpen(section: AppSectionId): boolean {
  return useOpenSections().some((open) => open.definition.id === section)
}

/** Whether this app draws its sections; shared links open one page and get none. */
export function useSectionsEnabled(): boolean {
  return useContext(SectionsContext)
}

/** The sections this person may open, internal shape. */
export function useOpenSections(): readonly OpenSection[] {
  const enabled = useContext(SectionsContext)
  const signedIn = useCurrentUser() !== null
  const access = useSessionAccess()
  return useMemo(
    () => resolveOpenSections({ signedIn, access, enabled }),
    [signedIn, access, enabled]
  )
}

const sectionIcons: Record<AppSectionId, ComponentType<{ readonly className?: string }>> = {
  console: SquareTerminal,
  settings: Settings,
}

const pageIcons: Record<string, ComponentType<{ readonly className?: string }>> = {
  personal: UserRound,
  developers: Braces,
  memory: Brain,
  members: UsersRound,
  connectors: Cable,
  syncs: RefreshCw,
  datasets: Database,
  pipelines: Workflow,
  projections: Layers,
  logs: ScrollText,
  usage: ChartNoAxesCombined,
  activity: MousePointerClick,
  "object-types": LayoutGrid,
  objects: Box,
  graph: Network,
  actions: Bolt,
  workflows: GitBranch,
  rules: ListChecks,
}

/**
 * The built-in sections this person may open, with their pages, for a shell drawn by hand. Each
 * holds only the pages this person may open.
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
            activeFor: page.activeFor,
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

/** Whether `pathname` is one of the section's pages, below one, or a page one claims. */
function sectionContains(section: AppSection, pathname: string): boolean {
  return section.pages.some((entry) =>
    ("group" in entry ? entry.items : [entry]).some((page) => isCurrentItem(pathname, page))
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
