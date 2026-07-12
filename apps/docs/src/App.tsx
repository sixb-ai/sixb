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
  Bot,
  Boxes,
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
  Layers,
  LayoutDashboard,
  Lock,
  type LucideIcon,
  Menu,
  Network,
  Rocket,
  ScrollText,
  Search,
  Server,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { searchDocs } from "./docs/search"
import { docs } from "./generated/docs"
import { heroSnippets } from "./generated/snippets"

type Doc = (typeof docs)[number]
type Navigate = (href: string) => void

interface NavGroup {
  readonly title: string
  readonly items: Doc[]
}

const sectionIcons: Record<string, LucideIcon> = {
  "Get Started": Rocket,
  Fundamentals: Blocks,
  Runtime: Cpu,
  Ontology: Network,
  Objects: Boxes,
  Actions: Zap,
  Schedules: Clock,
  Data: Database,
  Rules: Gauge,
  Workflows: Workflow,
  Agents: Bot,
  Sandboxes: Container,
  "Events & Webhooks": Webhook,
  Logging: ScrollText,
  "Building Apps": LayoutDashboard,
  "Client SDK": Code,
  "Server & API": Server,
  Auth: Lock,
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

function intercept(navigate: Navigate, href: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(href)
  }
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
  const groups = useMemo(groupDocs, [])
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

  const current = docs.find((doc) => doc.routePath === path)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar
        onMenu={() => setMenuOpen(true)}
        onSearch={() => setSearchOpen(true)}
        navigate={navigate}
      />
      <div className="flex w-full">
        <DesktopSidebar groups={groups} path={path} navigate={navigate} />
        <main className="min-w-0 flex-1">
          <div className="mx-auto flex w-full max-w-[1100px] gap-16 px-6 py-10 lg:px-10 lg:py-12">
            <div className="min-w-0 flex-1">
              {current ? (
                <DocPage key={current.routePath} doc={current} navigate={navigate} />
              ) : (
                <Landing navigate={navigate} />
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
        groups={groups}
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
      <div className="flex h-14 w-full items-center gap-3 px-4 lg:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="Open menu"
          onClick={onMenu}
        >
          <Menu />
        </Button>
        <a
          href="/"
          onClick={intercept(navigate, "/")}
          aria-label="Sixb Docs home"
          className="mr-auto flex items-center gap-2.5 tracking-tight"
        >
          <svg
            viewBox="0 0 1080 1080"
            className="size-[22px] shrink-0 text-foreground"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M15.94,471.64l67.46,455.36,599.79-189.73,380.88-355.72L368.99,153C243.22,266.91,122.33,375.93,15.94,471.64Z" />
          </svg>
          <span
            className="select-none text-lg font-light text-muted-foreground/40"
            aria-hidden="true"
          >
            /
          </span>
          <span className="font-semibold text-foreground">Docs</span>
        </a>
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
        <ThemeSwitcher />
      </div>
    </header>
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
      <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-3 pt-4 pb-8 lg:px-4">
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
      <SheetContent side="left" className="w-72 overflow-y-auto p-6">
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
  const [openSection, setOpenSection] = useState<string | null>(() => activeTitle ?? null)

  useEffect(() => {
    if (activeTitle) setOpenSection(activeTitle)
  }, [activeTitle])

  return (
    <nav className="flex flex-col gap-0.5">
      {groups.map((group) => {
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
              onClick={() => setOpenSection((prev) => (prev === group.title ? null : group.title))}
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
                    const label =
                      doc.isOverview && doc.title === group.title ? "Overview" : doc.title
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
  const index = docs.findIndex((entry) => entry.routePath === doc.routePath)
  const prev = index > 0 ? docs[index - 1] : undefined
  const next = index < docs.length - 1 ? docs[index + 1] : undefined

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
    <article className="relative mx-auto w-full max-w-[720px]">
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
      <RawHtml className="prose" onClick={onClick} html={doc.html} />
      {prev || next ? (
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
  const overview = docs.find((entry) => entry.section === doc.section && entry.isOverview)
  const label = doc.isOverview && doc.title === doc.section ? "Overview" : doc.title
  const linkSection = overview && overview.routePath !== doc.routePath
  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {linkSection ? (
        <a
          href={overview.routePath}
          onClick={intercept(navigate, overview.routePath)}
          className="truncate transition-colors hover:text-foreground"
        >
          {doc.section}
        </a>
      ) : (
        <span className="truncate">{doc.section}</span>
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

const landingGroups: ReadonlyArray<{
  readonly title: string
  readonly cards: ReadonlyArray<{ readonly section: string; readonly description: string }>
}> = [
  {
    title: "Model your domain",
    cards: [
      {
        section: "Ontology",
        description: "Define objects, properties, links, and telemetry as one typed model.",
      },
      {
        section: "Objects",
        description: "Read, write, query, and traverse instances through a typed runtime API.",
      },
      {
        section: "Actions",
        description: "Typed, validated commands for changing state safely.",
      },
    ],
  },
  {
    title: "Bring in live data",
    cards: [
      {
        section: "Data",
        description: "Sync external systems into datasets and project them into objects.",
      },
      {
        section: "Schedules",
        description: "Cron triggers that drive syncs, pipelines, and workflows.",
      },
      {
        section: "Workflows",
        description: "Multi-step processes, including human-in-the-loop steps.",
      },
    ],
  },
  {
    title: "Ship the interface",
    cards: [
      {
        section: "Building Apps",
        description: "Custom React apps built on the same typed runtime.",
      },
      {
        section: "Client SDK",
        description: "A type-safe client with React Query hooks for the browser.",
      },
      {
        section: "Server & API",
        description: "An HTTP + WebSocket API with OpenAPI, generated for you.",
      },
    ],
  },
]

function sectionRoute(section: string): string {
  return docs.find((doc) => doc.section === section && doc.isOverview)?.routePath ?? "/"
}

function onHeroCopy(event: MouseEvent<HTMLDivElement>) {
  const copy = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]")
  if (!copy) return
  const code = copy.closest(".code-block")?.querySelector("pre")?.textContent ?? ""
  navigator.clipboard.writeText(code)
  copy.classList.add("is-copied")
  window.setTimeout(() => copy.classList.remove("is-copied"), 1500)
}

function LandingLink({
  href,
  navigate,
  children,
}: {
  href: string
  navigate: Navigate
  children: ReactNode
}) {
  return (
    <a
      href={href}
      onClick={intercept(navigate, href)}
      className="font-medium text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground"
    >
      {children}
    </a>
  )
}

function Landing({ navigate }: { navigate: Navigate }) {
  const [tab, setTab] = useState(0)
  const html = (heroSnippets[tab] ?? heroSnippets[0])?.html ?? ""

  return (
    <div className="mx-auto w-full max-w-[1080px]">
      <section className="grid items-start gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-12">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Documentation</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-[2.8rem] sm:leading-[1.08]">
            Build operational software, end to end
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            The TypeScript framework for operational software. One typed ontology powers your data,
            APIs, and apps.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <a href="/get-started" onClick={intercept(navigate, "/get-started")}>
                Get started
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href="/fundamentals/project-structure"
                onClick={intercept(navigate, "/fundamentals/project-structure")}
              >
                Project structure
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="/examples" onClick={intercept(navigate, "/examples")}>
                Examples
              </a>
            </Button>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-5 border-b border-border">
            {heroSnippets.map((entry, index) => (
              <button
                key={entry.label}
                type="button"
                onClick={() => setTab(index)}
                className={cn(
                  "-mb-px border-b-2 px-0.5 py-2 text-sm font-medium transition-colors",
                  index === tab
                    ? "border-[color:var(--docs-accent)] text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <RawHtml className="prose hero-code" onClick={onHeroCopy} html={html} />
        </div>
      </section>

      <p className="mt-16 max-w-2xl text-base leading-relaxed text-muted-foreground">
        Define a type once and it flows through the whole system. The same{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
          Customer
        </code>{" "}
        powers your{" "}
        <LandingLink href="/objects/querying" navigate={navigate}>
          queries
        </LandingLink>
        ,{" "}
        <LandingLink href="/server" navigate={navigate}>
          API
        </LandingLink>
        ,{" "}
        <LandingLink href="/client" navigate={navigate}>
          client
        </LandingLink>
        , and{" "}
        <LandingLink href="/apps" navigate={navigate}>
          app
        </LandingLink>
        .
      </p>

      {landingGroups.map((group) => (
        <section key={group.title} className="mt-12">
          <h2 className="text-lg font-semibold tracking-tight">{group.title}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.cards.map((card) => {
              const Icon = sectionIcons[card.section]
              const route = sectionRoute(card.section)
              return (
                <a
                  key={card.section}
                  href={route}
                  onClick={intercept(navigate, route)}
                  className="group flex flex-col gap-2 rounded-xl border border-border p-5 transition-colors hover:bg-accent/40"
                >
                  <span className="flex items-center gap-2 font-medium text-foreground">
                    {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
                    {card.section}
                  </span>
                  <span className="text-sm leading-relaxed text-muted-foreground">
                    {card.description}
                  </span>
                </a>
              )
            })}
          </div>
        </section>
      ))}

      <section className="mt-12 border-t border-border pt-6 text-sm text-muted-foreground">
        Going to production?{" "}
        <LandingLink href="/auth" navigate={navigate}>
          Auth
        </LandingLink>
        ,{" "}
        <LandingLink href="/infrastructure" navigate={navigate}>
          Infrastructure
        </LandingLink>
        ,{" "}
        <LandingLink href="/deployment" navigate={navigate}>
          Deployment
        </LandingLink>
        , and{" "}
        <LandingLink href="/testing" navigate={navigate}>
          Testing
        </LandingLink>
        .
      </section>
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
