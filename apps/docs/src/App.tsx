"use client"

import {
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
  ThemeSwitcher,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  Blocks,
  BookOpen,
  Boxes,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  Code,
  Container,
  Copy,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  Gauge,
  LaptopMinimal,
  Layers,
  LayoutDashboard,
  Lock,
  type LucideIcon,
  Menu,
  Microchip,
  Network,
  Radio,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Server,
  Terminal,
  TriangleAlert,
  Workflow,
  Zap,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react"
import { BuildWithAI } from "./components/BuildWithAI"
import { ConnectorLibrary } from "./components/ConnectorLibrary"
import { HomeWalkthrough } from "./components/HomeWalkthrough"
import { ProjectExplorer } from "./components/ProjectExplorer"
import { ProviderLibrary } from "./components/ProviderLibrary"
import { legacySections } from "./docs/legacySections"
import { searchDocs } from "./docs/search"
import { docs } from "./generated/docs"

type Doc = (typeof docs)[number]
type Navigate = (href: string) => void

interface NavGroup {
  readonly title: string
  readonly items: Doc[]
  readonly labels?: Readonly<Record<string, string>>
}

const sectionIcons: Record<string, LucideIcon | undefined> = {
  "Data integration": Database,
  Build: Code,
  Configuration: Cpu,
  Security: Lock,
  WebSockets: Radio,
  CLI: Terminal,
  Errors: TriangleAlert,
  "HTTP API": Server,
  AI: Microchip,
  Apps: LayoutDashboard,
  "Get Started": Rocket,
  Fundamentals: Blocks,
  Runtime: Cpu,
  Ontology: Network,
  Objects: Boxes,
  Actions: Zap,
  Schedules: Clock,
  Connectors: Cable,
  Datasets: Database,
  Syncs: RefreshCw,
  Pipelines: Layers,
  Projections: Boxes,
  Rules: Gauge,
  Workflows: Workflow,
  Models: Microchip,
  Sandboxes: Container,
  Logging: ScrollText,
  "Building Apps": LayoutDashboard,
  "Client SDK": Code,
  "Server & API": Server,
  Infrastructure: Layers,
  Deployment: Cloud,
  Testing: FlaskConical,
  Examples: BookOpen,
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/"
}

function groupDocs(): NavGroup[] {
  const groups: NavGroup[] = []
  for (const doc of docs) {
    const existing = groups.find((group) => group.title === doc.section)
    if (existing) {
      existing.items.push(doc)
    } else {
      groups.push({ title: doc.section, items: [doc] })
    }
  }
  return groups
}

function sidebarGroups(groups: NavGroup[]): NavGroup[] {
  const section = (title: string): NavGroup =>
    groups.find((group) => group.title === title) ?? { title, items: [] }
  const topic = (title: string, sources: string[]): NavGroup => ({
    title,
    items: sources.flatMap((source) => section(source).items),
  })
  const models = section("Models")
  const aiOrder = [
    "/models",
    "/models/generation",
    "/models/tools-and-authorization",
    "/models/configuration",
    "/sandboxes",
    "/models/usage-and-limits",
  ]
  const aiPages = [...models.items, ...section("Sandboxes").items].sort((a, b) => {
    const aIndex = aiOrder.indexOf(a.routePath)
    const bIndex = aiOrder.indexOf(b.routePath)
    return (aIndex < 0 ? aiOrder.length : aIndex) - (bIndex < 0 ? aiOrder.length : bIndex)
  })
  return [
    section("Get Started"),
    section("Fundamentals"),
    section("Ontology"),
    { title: "Data Integration", items: [] },
    {
      ...section("Connectors"),
      labels: { "/connectors/authentication": "OAuth" },
    },
    ...["Datasets", "Syncs", "Pipelines", "Projections"].map(section),
    { title: "Build", items: [] },
    topic("Apps", ["Building Apps"]),
    ...["Objects", "Actions", "Workflows"].map(section),
    {
      title: "AI",
      items: aiPages,
      labels: {
        "/models": "Overview",
        "/models/configuration": "Model providers",
        "/models/generation": "Generating responses",
        "/models/tools-and-authorization": "Tools & skills",
        "/models/usage-and-limits": "Usage & limits",
      },
    },
    ...["Rules", "Schedules"].map(section),
    { title: "Manage", items: [] },
    {
      title: "Configuration",
      items: [...section("Runtime").items, ...section("Infrastructure").items],
      labels: {
        "/runtime": "Project configuration",
        "/infrastructure": "Infrastructure providers",
      },
    },
    section("Security"),
    section("Deployment"),
    section("Logging"),
    section("Testing"),
    { title: "Reference", items: [] },
    section("Client SDK"),
    {
      title: "HTTP API",
      items: section("HTTP API").items,
      labels: { "/server": "Overview" },
    },
    ...["WebSockets", "CLI", "Errors"].map(section),
    section("Examples"),
  ]
}

// Documentation is generated at build time. Derive its navigation once for every surface.
const groups = groupDocs()
const navigationGroups = sidebarGroups(groups)
const navigationDocs = navigationGroups.flatMap((group) => group.items)

function navigationLabel(doc: Doc, group?: NavGroup) {
  return (
    group?.labels?.[doc.routePath] ??
    (doc.isOverview && group?.items.filter((item) => item.isOverview).length === 1
      ? "Overview"
      : doc.title)
  )
}

function intercept(navigate: Navigate, href: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(href)
  }
}

// The shared theme provider reads localStorage during initialization.
// Keep the server and first client render identical until it has mounted.
function DocsThemeSwitcher() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (mounted) return <ThemeSwitcher />
  return (
    <Button type="button" variant="outline" size="icon-sm" aria-label="Theme" disabled>
      <LaptopMinimal />
    </Button>
  )
}

function RawHtml({
  html,
  className,
  onClick,
}: {
  html: string
  className?: string
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
}) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: Rendered from trusted in-repo markdown and snippets.
  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

export function App({ initialPath }: { initialPath: string }) {
  const router = useRouter()
  const [path, setPath] = useState(() => normalize(initialPath))
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setPath(normalize(initialPath))
  }, [initialPath])

  useEffect(() => {
    const onPop = () => setPath(normalize(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const navigate = useCallback<Navigate>(
    (href) => {
      const [rawPath, hash] = href.split("#")
      const next = normalize(rawPath ?? "/")
      const samePage = next === normalize(window.location.pathname)
      if (!samePage) {
        router.push(hash ? `${next}#${hash}` : next, { scroll: false })
      }
      setPath(next)
      setSearchOpen(false)
      setMenuOpen(false)
      // Switching pages jumps to the top instantly; only same-page anchors animate.
      const behavior: ScrollBehavior = samePage ? "smooth" : "instant"
      requestAnimationFrame(() => {
        if (hash) document.getElementById(hash)?.scrollIntoView({ behavior })
        else window.scrollTo({ top: 0, behavior })
      })
    },
    [router]
  )

  useEffect(() => {
    const redirectSection = () => {
      const destination = legacySections[path]?.[window.location.hash.slice(1)]
      if (destination) router.replace(destination)
    }
    redirectSection()
    window.addEventListener("hashchange", redirectSection)
    return () => window.removeEventListener("hashchange", redirectSection)
  }, [path, router])

  const current = docs.find((doc) => doc.routePath === path)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar
        onMenu={() => setMenuOpen(true)}
        onSearch={() => setSearchOpen(true)}
        navigate={navigate}
      />
      <div className="flex w-full">
        <DesktopSidebar groups={navigationGroups} path={path} navigate={navigate} />
        <main className="min-w-0 flex-1">
          <div
            className={cn(
              "mx-auto flex w-full gap-16 px-6 py-10 lg:px-10 lg:py-12",
              current ? "max-w-[1100px]" : "docs-landing-content"
            )}
          >
            <div className="min-w-0 flex-1">
              {current ? (
                <DocPage key={current.routePath} doc={current} navigate={navigate} />
              ) : (
                <Landing />
              )}
            </div>
            {current && current.headings.length > 0 ? (
              <Toc key={current.routePath} path={current.routePath} headings={current.headings} />
            ) : null}
          </div>
        </main>
      </div>
      <MobileSidebar
        open={menuOpen}
        setOpen={setMenuOpen}
        groups={navigationGroups}
        path={path}
        navigate={navigate}
      />
      <SearchPalette
        open={searchOpen}
        setOpen={setSearchOpen}
        groups={groups}
        navigate={navigate}
      />
    </div>
  )
}

function TopBar({
  onMenu,
  onSearch,
  navigate,
}: {
  onMenu: () => void
  onSearch: () => void
  navigate: Navigate
}) {
  return (
    <header className="sticky top-0 z-40 bg-background/80 backdrop-blur">
      <div className="flex h-14 w-full items-center gap-1 px-4 sm:gap-3 lg:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="Open menu"
          onClick={onMenu}
        >
          <Menu />
        </Button>
        <div className="mr-auto flex items-center gap-2.5 tracking-tight">
          <a
            href="https://sixb.ai"
            aria-label="Sixb website"
            className="flex items-center gap-2 font-semibold text-foreground"
          >
            <svg
              viewBox="0 0 1080 1080"
              className="size-[22px] shrink-0 text-foreground"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M15.94,471.64l67.46,455.36,599.79-189.73,380.88-355.72L368.99,153C243.22,266.91,122.33,375.93,15.94,471.64Z" />
            </svg>
            <span>Sixb</span>
          </a>
          <span
            className="select-none text-lg font-light text-muted-foreground/40"
            aria-hidden="true"
          >
            /
          </span>
          <a href="/" onClick={intercept(navigate, "/")} className="font-semibold text-foreground">
            Docs
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href="https://github.com/sixb-ai/sixb"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Sixb on GitHub (opens in a new tab)"
            title="GitHub"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
          <a
            href="https://discord.gg/rPSbZSRDzQ"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Sixb on Discord (opens in a new tab)"
            title="Discord"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.609 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.618-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.675 4.37a.07.07 0 0 0-.032.027C.533 9.043-.32 13.579.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.676-3.548-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.419 0 1.334-.955 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.419 0 1.334-.946 2.419-2.157 2.419z" />
            </svg>
          </a>
        </div>
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-muted/40 pr-2 pl-3 text-sm text-muted-foreground transition-colors hover:bg-muted sm:flex"
        >
          <Search className="size-4" />
          <span className="pr-10">Search docs</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] leading-none">
            ⌘K
          </kbd>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="sm:hidden"
          aria-label="Search"
          onClick={onSearch}
        >
          <Search />
        </Button>
        <DocsThemeSwitcher />
      </div>
    </header>
  )
}

// Route pages remount the docs shell. Keep navigation state for this browser session.
const sidebarPositions = { desktop: 0, mobile: 0 }
let sidebarOpenTopic: string | null = null

function useSidebarScroll(surface: keyof typeof sidebarPositions) {
  return useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return
      element.scrollTop = sidebarPositions[surface]
      let timer: ReturnType<typeof setTimeout> | undefined
      const onScroll = () => {
        sidebarPositions[surface] = element.scrollTop
        element.dataset.scrolling = "true"
        clearTimeout(timer)
        timer = setTimeout(() => {
          delete element.dataset.scrolling
        }, 800)
      }
      element.addEventListener("scroll", onScroll, { passive: true })
      return () => {
        sidebarPositions[surface] = element.scrollTop
        element.removeEventListener("scroll", onScroll)
        clearTimeout(timer)
      }
    },
    [surface]
  )
}

function DesktopSidebar({
  groups,
  path,
  navigate,
}: {
  groups: NavGroup[]
  path: string
  navigate: Navigate
}) {
  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <div
        ref={useSidebarScroll("desktop")}
        className="docs-sidebar-scroll sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-3 pt-4 pb-8 lg:px-4"
      >
        <SidebarNav groups={groups} path={path} navigate={navigate} />
      </div>
    </aside>
  )
}

function MobileSidebar({
  open,
  setOpen,
  groups,
  path,
  navigate,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  groups: NavGroup[]
  path: string
  navigate: Navigate
}) {
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        ref={useSidebarScroll("mobile")}
        side="left"
        className="docs-sidebar-scroll w-72 overflow-y-auto p-6"
      >
        <SheetTitle className="mb-6 text-base font-semibold">Sixb Docs</SheetTitle>
        <SidebarNav groups={groups} path={path} navigate={navigate} />
      </SheetContent>
    </Sheet>
  )
}

function SidebarNav({
  groups,
  path,
  navigate,
}: {
  groups: NavGroup[]
  path: string
  navigate: Navigate
}) {
  const activeTitle = groups.find((group) =>
    group.items.some((doc) => doc.routePath === path)
  )?.title
  const [openSection, setOpenSection] = useState<string | null>(
    () => activeTitle ?? sidebarOpenTopic
  )

  useLayoutEffect(() => {
    sidebarOpenTopic = openSection
  }, [openSection])

  useEffect(() => {
    if (activeTitle) setOpenSection(activeTitle)
  }, [activeTitle])

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-0.5">
      {groups.map((group) => {
        if (group.items.length === 0) {
          return (
            <p
              key={group.title}
              className="mt-6 mb-1 px-3 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase"
            >
              {group.title}
            </p>
          )
        }
        const Icon = sectionIcons[group.title]
        const expanded = openSection === group.title
        const sectionActive = group.title === activeTitle

        // Single-page sections collapse to a direct link — no empty disclosure.
        if (group.items.length === 1) {
          const doc = group.items[0]
          if (!doc) return null
          const active = doc.routePath === path
          return (
            <a
              key={group.title}
              href={doc.routePath}
              onClick={intercept(navigate, doc.routePath)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                group.title === "Examples" && "mt-5 border-t border-border pt-4",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              {Icon ? <Icon className="size-4 shrink-0" /> : null}
              {group.title}
            </a>
          )
        }

        return (
          <div key={group.title} className="flex flex-col">
            <button
              type="button"
              onClick={() =>
                setOpenSection((previous) => (previous === group.title ? null : group.title))
              }
              aria-expanded={expanded}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors hover:text-foreground",
                sectionActive ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {Icon ? <Icon className="size-4 shrink-0" /> : null}
              <span className="flex-1">{group.title}</span>
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
                  expanded && "rotate-90"
                )}
              />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div
                inert={!expanded}
                className={cn(
                  "overflow-hidden transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "opacity-100" : "opacity-0"
                )}
              >
                <div className="mt-0.5 mb-1 ml-[1.45rem] flex flex-col border-l border-border">
                  {group.items.map((doc) => {
                    const active = doc.routePath === path
                    const label = navigationLabel(doc, group)
                    return (
                      <a
                        key={doc.routePath}
                        href={doc.routePath}
                        onClick={intercept(navigate, doc.routePath)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "-ml-px border-l-2 py-1.5 pl-4 text-[14px] transition-colors",
                          active
                            ? "border-[color:var(--docs-accent)] font-medium text-[color:var(--docs-accent)]"
                            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                        )}
                      >
                        {label}
                      </a>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function DocPage({ doc, navigate }: { doc: Doc; navigate: Navigate }) {
  const index = navigationDocs.findIndex((entry) => entry.routePath === doc.routePath)
  const prev = index > 0 ? navigationDocs[index - 1] : undefined
  const next = index < navigationDocs.length - 1 ? navigationDocs[index + 1] : undefined

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      const copy = target.closest<HTMLButtonElement>("[data-copy]")
      if (copy) {
        const code = copy.closest(".code-block")?.querySelector("pre")?.textContent ?? ""
        navigator.clipboard.writeText(code)
        copy.classList.add("is-copied")
        window.setTimeout(() => copy.classList.remove("is-copied"), 1500)
        return
      }
      const link = target.closest("a")
      if (!link) return
      const href = link.getAttribute("href") ?? ""
      const base = normalize(href.split("#")[0] ?? "")
      if (
        href.startsWith("/") &&
        !href.endsWith(".md") &&
        docs.some((entry) => entry.routePath === base)
      ) {
        event.preventDefault()
        navigate(href)
      }
    },
    [navigate]
  )

  const hasBreadcrumb = doc.routePath !== "/get-started"

  return (
    <article
      className={cn("relative mx-auto w-full max-w-[720px]", !hasBreadcrumb && "docs-get-started")}
    >
      {hasBreadcrumb ? (
        <div className="mb-5 flex items-center justify-between gap-4">
          <Breadcrumb doc={doc} navigate={navigate} />
          <CopyMarkdownButton markdownPath={doc.markdownPath} />
        </div>
      ) : (
        <div className="absolute top-1 right-0 z-10">
          <CopyMarkdownButton markdownPath={doc.markdownPath} />
        </div>
      )}
      <DocContent html={doc.html} onClick={onClick} />
      {hasBreadcrumb && (prev || next) ? (
        <nav className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
          {prev ? <Pager doc={prev} dir="Previous" navigate={navigate} /> : <span />}
          {next ? <Pager doc={next} dir="Next" navigate={navigate} /> : <span />}
        </nav>
      ) : null}
    </article>
  )
}

function Breadcrumb({ doc, navigate }: { doc: Doc; navigate: Navigate }) {
  // The standalone Get Started page is a top-level entry with no parent crumb.
  if (doc.routePath === "/get-started") return null
  const topic = navigationGroups.find((group) =>
    group.items.some((item) => item.routePath === doc.routePath)
  )
  const title = topic?.title ?? doc.section
  const overview = topic?.items[0]
  const label = navigationLabel(doc, topic)
  const linkSection = overview && overview.routePath !== doc.routePath
  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {linkSection ? (
        <a
          href={overview.routePath}
          onClick={intercept(navigate, overview.routePath)}
          className="truncate transition-colors hover:text-foreground"
        >
          {title}
        </a>
      ) : (
        <span className="truncate">{title}</span>
      )}
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
      <span className="truncate text-foreground">{label}</span>
    </nav>
  )
}

function CopyMarkdownButton({ markdownPath }: { markdownPath: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    try {
      const response = await fetch(markdownPath)
      await navigator.clipboard.writeText(await response.text())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard or fetch unavailable — leave the label unchanged.
    }
  }, [markdownPath])

  return (
    <div className="flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 rounded-l-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <span className="relative inline-flex size-3.5 items-center justify-center">
          <Copy
            className={cn(
              "absolute size-3.5 transition-all duration-200",
              copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
            )}
          />
          <Check
            className={cn(
              "absolute size-3.5 text-[color:var(--docs-accent)] transition-all duration-200",
              copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
            )}
          />
        </span>
        {copied ? "Copied" : "Copy markdown"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More markdown options"
            className="inline-flex items-center rounded-r-lg border border-l-0 border-border px-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => void onCopy()} className="items-start gap-2.5">
            <Copy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Copy markdown</span>
              <span className="text-xs text-muted-foreground">
                Copy this page as Markdown for LLMs
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="items-start gap-2.5">
            <a href={markdownPath} target="_blank" rel="noreferrer">
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex flex-col">
                <span className="text-sm font-medium">View as Markdown</span>
                <span className="text-xs text-muted-foreground">Open this page as plain text</span>
              </span>
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function Pager({ doc, dir, navigate }: { doc: Doc; dir: "Previous" | "Next"; navigate: Navigate }) {
  return (
    <a
      href={doc.routePath}
      onClick={intercept(navigate, doc.routePath)}
      className={cn(
        "flex flex-col gap-1 rounded-xl border border-border p-4 transition-colors hover:bg-accent/50",
        dir === "Next" && "sm:items-end sm:text-right"
      )}
    >
      <span className="text-xs text-muted-foreground">{dir}</span>
      <span className="font-medium text-foreground">{doc.title}</span>
    </a>
  )
}

function Toc({ path, headings }: { path: string; headings: Doc["headings"] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "")

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 }
    )
    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [headings])

  return (
    <aside className="hidden w-56 shrink-0 xl:block">
      <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto py-10 lg:py-12">
        <p className="mb-3 text-xs font-semibold tracking-wide text-foreground">On this page</p>
        <nav className="flex flex-col border-l border-border text-sm">
          {headings.map((heading) => (
            <a
              key={heading.id}
              href={`${path}#${heading.id}`}
              onClick={() => setActive(heading.id)}
              className={cn(
                "-ml-px border-l-2 py-1 transition-colors",
                heading.level === 3 ? "pl-7" : "pl-4",
                active === heading.id
                  ? "border-[color:var(--docs-accent)] font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {heading.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  )
}

function Landing() {
  return (
    <div className="docs-landing">
      <HomeWalkthrough />
    </div>
  )
}

function SearchPalette({
  open,
  setOpen,
  groups,
  navigate,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  groups: NavGroup[]
  navigate: Navigate
}) {
  const [query, setQuery] = useState("")
  const hasQuery = query.trim().length > 0
  const results = useMemo(
    () => (hasQuery ? searchDocs(docs, query).slice(0, 20) : []),
    [hasQuery, query]
  )
  const visibleGroups = hasQuery ? [{ title: "Results", items: results }] : groups

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search docs"
      description="Search the documentation"
      shouldFilter={false}
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search documentation..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {visibleGroups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.items.map((doc) => (
              <CommandItem
                key={doc.routePath}
                value={doc.routePath}
                onSelect={() => navigate(doc.routePath)}
              >
                <FileText />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span>{doc.title}</span>
                    {hasQuery && doc.section !== doc.title ? (
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {doc.section}
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">{doc.summary}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

function DocContent({
  html,
  onClick,
}: {
  html: string
  onClick: (event: MouseEvent<HTMLDivElement>) => void
}) {
  const parts = html.split(
    /(<div data-(?:build-with-ai|project-explorer|connector-library|provider-library="(?:models|sandboxes)")><\/div>)/g
  )
  const renderCode = (code: string) => <RawHtml className="prose" onClick={onClick} html={code} />
  return parts.map((part, index) => {
    // Content and widget positions are fixed for the lifetime of a document.
    const key = `${index}-${part.slice(0, 50)}`
    if (part === "<div data-build-with-ai></div>")
      return (
        <div key={key} className="mt-4">
          <BuildWithAI />
        </div>
      )
    if (part === "<div data-project-explorer></div>")
      return <ProjectExplorer key={key} renderCode={renderCode} />
    if (part === "<div data-connector-library></div>") return <ConnectorLibrary key={key} />
    if (part === '<div data-provider-library="models"></div>')
      return <ProviderLibrary key={key} kind="models" />
    if (part === '<div data-provider-library="sandboxes"></div>')
      return <ProviderLibrary key={key} kind="sandboxes" />
    return <RawHtml key={key} className="prose" onClick={onClick} html={part} />
  })
}
