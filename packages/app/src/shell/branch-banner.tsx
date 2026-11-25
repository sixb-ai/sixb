import { getProjectInfoOptions } from "@sixb/client/hooks"
import { defineMessages, type MessageTree, type Translation } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpLeft, ChevronDown, ChevronUp, GitFork, RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react"
import { useFormat } from "../pages/section-ui"

const en = {
  label: "Branch",
  region: (name: string) => `Branch ${name}`,
  dataFrom: (age: string) => `production data from ${age}`,
  dataJustNow: "production data from just now",
  refresh: "Refresh",
  refreshLabel: (name: string) => `Refresh ${name} from production`,
  back: "Back to production",
  hide: "Hide the branch bar",
  show: (name: string) => `Show the bar of branch ${name}`,
} satisfies MessageTree

const fr: Translation<typeof en> = {
  label: "Branche",
  region: (name: string) => `Branche ${name}`,
  dataFrom: (age: string) => `données de production copiées ${age}`,
  dataJustNow: "données de production copiées à l’instant",
  refresh: "Actualiser",
  refreshLabel: (name: string) => `Actualiser ${name} depuis la production`,
  back: "Retour à la production",
  hide: "Masquer la barre de la branche",
  show: (name: string) => `Afficher la barre de la branche ${name}`,
}

const useBannerMessages = defineMessages<typeof en>({ en, fr }).useMessages

/** The branch an app runs as, as `GET /api/project` says: absent in production. */
export interface BannerBranch {
  readonly name: string
  readonly dataTakenAt: string | null
  /** Production's app, on a branch production runs that knows it. */
  readonly productionUrl: string | null
}

const COLLAPSED_KEY = "sixb:branch-bar-collapsed"

/** The bar's height, which a layout that fills the screen leaves free: `--app-top-inset`. */
const BAR_HEIGHT = "2rem"

/**
 * The thin bar on top of every page of a branch's app, so nobody mistakes it for production: the
 * branch, how old its copy of production's data is, and, on a branch production runs, a way to
 * refresh it and back to production. The framework draws it; the project's code has no say. In
 * production, and in a plain `sixb dev`, it draws nothing.
 */
export function BranchBanner() {
  const { data: project } = useQuery({
    ...getProjectInfoOptions(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return project?.branch ? <BranchBar branch={project.branch} /> : null
}

/** The bar itself, for a branch given by hand. */
export function BranchBar({ branch }: { readonly branch: BannerBranch }) {
  const messages = useBannerMessages()
  const format = useFormat()
  const [collapsed, setCollapsed] = useState(() => readCollapsed(branch.name))
  // The age reads "2 minutes ago": say it again each minute.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  // Shown, it takes its height from the screen a filling layout uses, before the first paint.
  useLayoutEffect(() => {
    if (collapsed) return
    const root = document.documentElement
    root.style.setProperty("--app-top-inset", BAR_HEIGHT)
    return () => {
      root.style.removeProperty("--app-top-inset")
    }
  }, [collapsed])

  const toggle = (next: boolean) => {
    setCollapsed(next)
    writeCollapsed(branch.name, next)
  }

  const age = branch.dataTakenAt
    ? Date.now() - Date.parse(branch.dataTakenAt) < 60_000
      ? messages.dataJustNow
      : messages.dataFrom(format.relative(branch.dataTakenAt))
    : null
  const production = branch.productionUrl
  const refreshUrl = production
    ? `${production}/console/branches?${new URLSearchParams({ branch: branch.name, refresh: "1" })}`
    : null

  // Folded, a hairline in the bar's color stays on top of the page, and a tab to unfold it.
  if (collapsed) {
    return (
      <>
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 bg-foreground"
        />
        <button
          type="button"
          onClick={() => toggle(false)}
          aria-label={messages.show(branch.name)}
          title={branch.name}
          className="fixed top-0 left-1/2 z-50 flex h-5 -translate-x-1/2 items-center gap-1 rounded-b-md bg-foreground px-2 text-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <GitFork aria-hidden className="size-3" />
          <ChevronDown aria-hidden className="size-3 opacity-70" />
        </button>
      </>
    )
  }

  return (
    <aside
      aria-label={messages.region(branch.name)}
      className="relative z-50 flex h-8 w-full shrink-0 items-center gap-2 bg-foreground px-3 text-[0.75rem] text-background sm:px-4"
    >
      <GitFork aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="sr-only">{messages.label}</span>
      <span className="min-w-0 truncate font-mono font-medium">{branch.name}</span>
      {age ? (
        <>
          <span aria-hidden className="shrink-0 opacity-40">
            ·
          </span>
          <span className="hidden min-w-0 truncate opacity-70 sm:inline">{age}</span>
          <span className="min-w-0 truncate opacity-70 sm:hidden">
            {branch.dataTakenAt ? format.relative(branch.dataTakenAt) : null}
          </span>
        </>
      ) : null}
      <span className="flex-1" />
      {refreshUrl ? (
        <BarLink href={refreshUrl} label={messages.refreshLabel(branch.name)} newTab>
          <RefreshCw aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">{messages.refresh}</span>
        </BarLink>
      ) : null}
      {production ? (
        <BarLink href={production} label={messages.back}>
          <ArrowUpLeft aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">{messages.back}</span>
        </BarLink>
      ) : null}
      <button
        type="button"
        onClick={() => toggle(true)}
        aria-label={messages.hide}
        title={messages.hide}
        className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-background/60"
      >
        <ChevronUp aria-hidden className="size-3.5" />
      </button>
    </aside>
  )
}

function BarLink({
  href,
  label,
  newTab = false,
  children,
}: {
  readonly href: string
  readonly label: string
  readonly newTab?: boolean
  readonly children: ReactNode
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 opacity-80 transition-opacity outline-none hover:bg-background/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-background/60 sm:px-2"
      )}
    >
      {children}
    </a>
  )
}

function readCollapsed(name: string): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === name
  } catch {
    return false
  }
}

function writeCollapsed(name: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, name)
    else window.localStorage.removeItem(COLLAPSED_KEY)
  } catch {
    // Private windows keep no preference: the bar shows again next time.
  }
}
