import {
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Sheet,
  SheetContent,
  SheetTitle,
  ThemeSwitcher,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, FileText, Menu, Search } from "lucide-react"
import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react"
import { docs } from "./generated/docs"

type Doc = (typeof docs)[number]
type Navigate = (href: string) => void

interface NavGroup {
  readonly title: string
  readonly items: Doc[]
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

export function App() {
  const groups = useMemo(groupDocs, [])
  const [path, setPath] = useState(() => normalize(window.location.pathname))
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

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

  const navigate = useCallback<Navigate>((href) => {
    const [rawPath, hash] = href.split("#")
    const next = normalize(rawPath ?? "/")
    if (next !== normalize(window.location.pathname)) {
      window.history.pushState(null, "", hash ? `${next}#${hash}` : next)
    }
    setPath(next)
    setSearchOpen(false)
    setMenuOpen(false)
    requestAnimationFrame(() => {
      if (hash) document.getElementById(hash)?.scrollIntoView()
      else window.scrollTo({ top: 0 })
    })
  }, [])

  const current = docs.find((doc) => doc.routePath === path)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar
        onMenu={() => setMenuOpen(true)}
        onSearch={() => setSearchOpen(true)}
        navigate={navigate}
      />
      <div className="mx-auto flex w-full max-w-[1440px] px-4 lg:px-8">
        <DesktopSidebar groups={groups} path={path} navigate={navigate} />
        <main className="min-w-0 flex-1 py-10 lg:py-12 lg:pl-4 xl:pl-10">
          {current ? (
            <DocPage key={current.routePath} doc={current} navigate={navigate} />
          ) : (
            <Landing groups={groups} navigate={navigate} />
          )}
        </main>
        {current && current.headings.length > 0 ? (
          <Toc key={current.routePath} path={current.routePath} headings={current.headings} />
        ) : null}
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
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 lg:px-8">
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
          className="mr-auto flex items-center gap-2 font-semibold tracking-tight"
        >
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
            S
          </span>
          Sixb Docs
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
      <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto py-10 pr-6">
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
  return (
    <nav className="flex flex-col gap-7">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <p className="mb-1.5 px-3 text-xs font-semibold tracking-wide text-foreground">
            {group.title}
          </p>
          {group.items.map((doc) => {
            const active = doc.routePath === path
            return (
              <a
                key={doc.routePath}
                href={doc.routePath}
                onClick={intercept(navigate, doc.routePath)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                {doc.title}
              </a>
            )
          })}
        </div>
      ))}
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
        copy.textContent = "Copied"
        window.setTimeout(() => {
          copy.textContent = "Copy"
        }, 1500)
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

  return (
    <article className="relative mx-auto w-full max-w-[760px] lg:mx-0">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="absolute top-1.5 right-0 font-normal text-muted-foreground"
      >
        <a href={doc.markdownPath} target="_blank" rel="noreferrer">
          Markdown
        </a>
      </Button>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Docs HTML is generated from trusted repository markdown. */}
      <div className="prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
      {prev || next ? (
        <nav className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
          {prev ? <Pager doc={prev} dir="Previous" navigate={navigate} /> : <span />}
          {next ? <Pager doc={next} dir="Next" navigate={navigate} /> : <span />}
        </nav>
      ) : null}
    </article>
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
    <aside className="hidden w-60 shrink-0 xl:block">
      <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto py-12 pl-8">
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
                  ? "border-foreground font-medium text-foreground"
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

function Landing({ groups, navigate }: { groups: NavGroup[]; navigate: Navigate }) {
  const start = docs.find((doc) => doc.routePath === "/get-started")
  return (
    <div className="mx-auto w-full max-w-3xl lg:mx-0">
      <p className="text-sm font-medium text-muted-foreground">Sixb</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">Sixb Documentation</h1>
      <p className="mt-5 text-lg leading-relaxed text-muted-foreground">{start?.summary}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <a href="/get-started" onClick={intercept(navigate, "/get-started")}>
            Get started
          </a>
        </Button>
      </div>
      {groups.map((group) => (
        <section key={group.title} className="mt-14">
          <h2 className="text-lg font-semibold">{group.title}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {group.items.map((doc) => (
              <a
                key={doc.routePath}
                href={doc.routePath}
                onClick={intercept(navigate, doc.routePath)}
                className="group flex flex-col gap-1.5 rounded-xl border border-border p-5 transition-colors hover:bg-accent/40"
              >
                <span className="flex items-center justify-between font-medium text-foreground">
                  {doc.title}
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="line-clamp-2 text-sm text-muted-foreground">{doc.summary}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
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
  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search docs"
      description="Search the documentation"
    >
      <CommandInput placeholder="Search documentation..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.items.map((doc) => (
              <CommandItem
                key={doc.routePath}
                value={`${doc.title} ${doc.summary} ${doc.headings.map((heading) => heading.text).join(" ")}`}
                onSelect={() => navigate(doc.routePath)}
              >
                <FileText />
                <span className="flex min-w-0 flex-col">
                  <span>{doc.title}</span>
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
