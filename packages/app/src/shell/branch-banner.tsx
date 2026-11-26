import { getProjectInfoOptions } from "@sixb/client/hooks"
import { defineMessages, type MessageTree, type Translation, useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, ChevronDown, ChevronUp, Database, GitFork, RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useFormat } from "../pages/section-ui"
import { useSessionAccess } from "../session"

const en = {
  label: "Branch",
  region: (name: string) => `Branch ${name}`,
  dataFrom: (age: string) => `Production data from ${age}`,
  dataJustNow: "Production data from just now",
  /** The bar on a phone, read aloud before the age its icon stands beside: "Data 2 h ago". */
  dataShort: "Data",
  refresh: "Refresh…",
  refreshLabel: (name: string) => `Refresh ${name} from production`,
  back: "Back to production",
  hide: "Hide the branch bar",
  show: (name: string) => `Show the bar of branch ${name}`,
} satisfies MessageTree

const fr: Translation<typeof en> = {
  label: "Branche",
  region: (name: string) => `Branche ${name}`,
  dataFrom: (age: string) => `Données de production copiées ${age}`,
  dataJustNow: "Données de production copiées à l’instant",
  dataShort: "Données",
  refresh: "Actualiser…",
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

// One color in both themes, a dark slate: a branch never reads as production, and the bar sits
// apart from a dark page as well as a light one.
const BAR_COLORS = "bg-slate-800 text-slate-50 dark:bg-slate-700"

/**
 * The thin bar on top of every page of a branch's app, so nobody mistakes it for production: the
 * branch, how old its copy of production's data is, and, on a branch production runs, a way back
 * to production and, for those who may, to refresh it there. The framework draws it; the
 * project's code has no say. In production, and in a plain `sixb dev`, it draws nothing.
 */
export function BranchBanner() {
  const { data: project } = useQuery({
    ...getProjectInfoOptions(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return project?.branch ? <SignedInBranchBar branch={project.branch} /> : null
}

/**
 * The bar for the person signed in: Refresh only for those who may. Only a branch reads the
 * session for it, so an app with no branch, or with auth off, asks nothing more.
 */
function SignedInBranchBar({ branch }: { readonly branch: BannerBranch }) {
  const access = useSessionAccess()
  return <BranchBar branch={branch} canRefresh={access?.branches === true} />
}

/** The bar itself, for a branch given by hand. */
export function BranchBar({
  branch,
  canRefresh,
}: {
  readonly branch: BannerBranch
  /** Whether this person may refresh the branch in production: can.manage(project.source). */
  readonly canRefresh: boolean
}) {
  const messages = useBannerMessages()
  const format = useFormat()
  const short = useShortAge()
  const bar = useRef<HTMLElement>(null)
  const strip = useRef<HTMLButtonElement>(null)
  const [collapsed, setCollapsed] = useState(() => readCollapsed(branch.name))
  // The age reads "2 minutes ago": say it again each minute.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  // It takes its height from the screen a filling layout uses, before the first paint, and
  // follows it: the bar is taller on a phone, where its buttons are finger-sized. Folded, a phone
  // keeps a strip that takes its own; a wide screen's tab, over the page, takes none.
  useLayoutEffect(() => {
    const element = collapsed ? strip.current : bar.current
    if (!element) return
    const root = document.documentElement
    const measure = () => root.style.setProperty("--app-top-inset", `${element.offsetHeight}px`)
    measure()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      root.style.removeProperty("--app-top-inset")
    }
  }, [collapsed])

  const toggle = (next: boolean) => {
    setCollapsed(next)
    writeCollapsed(branch.name, next)
  }

  const fresh = branch.dataTakenAt && Date.now() - Date.parse(branch.dataTakenAt) < 60_000
  const age = branch.dataTakenAt
    ? fresh
      ? messages.dataJustNow
      : messages.dataFrom(format.relative(branch.dataTakenAt))
    : null
  const production = branch.productionUrl
  const refreshUrl =
    production && canRefresh
      ? `${production}/console/branches?${new URLSearchParams({ branch: branch.name, refresh: "1" })}`
      : null

  // Folded on a phone, a slim strip naming the branch stays above the page, which starts below it:
  // a phone has no room the page doesn't use. On a wide screen, a hairline in the bar's color with
  // a tab naming the branch, at the end of the document: over every page, full-screen ones
  // included, and under the dialogs opened after them.
  if (collapsed) {
    const show = messages.show(branch.name)
    return (
      <>
        <button
          ref={strip}
          type="button"
          onClick={() => toggle(false)}
          aria-label={show}
          className={cn(
            "box-content flex h-7 w-full shrink-0 items-center justify-center gap-1.5 px-4 pt-[env(safe-area-inset-top,0px)] text-[0.6875rem] outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-inset sm:hidden",
            BAR_COLORS
          )}
        >
          <GitFork aria-hidden className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-mono">{branch.name}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
        </button>
        {createPortal(
          <div className="max-sm:hidden">
            <div
              aria-hidden
              className={cn("pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5", BAR_COLORS)}
            />
            <button
              type="button"
              onClick={() => toggle(false)}
              aria-label={show}
              title={branch.name}
              className={cn(
                "fixed top-0 left-1/2 z-50 flex h-6 max-w-[min(16rem,70vw)] -translate-x-1/2 items-center gap-1.5 rounded-b-lg px-2.5 text-[0.6875rem] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                BAR_COLORS
              )}
            >
              <GitFork aria-hidden className="size-3 shrink-0 opacity-70" />
              <span className="min-w-0 truncate font-mono">{branch.name}</span>
              <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
            </button>
          </div>,
          document.body
        )}
      </>
    )
  }

  return (
    <aside
      ref={bar}
      aria-label={messages.region(branch.name)}
      className={cn(
        // Under an installed app's status bar it takes the safe area: pages below it don't.
        "relative z-50 box-content flex h-11 w-full shrink-0 items-center gap-2 pt-[env(safe-area-inset-top,0px)] pl-3 text-[0.75rem] sm:h-8 sm:px-4",
        BAR_COLORS
      )}
    >
      <GitFork aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="sr-only">{messages.label}</span>
      <span className="min-w-0 truncate font-mono font-medium" title={branch.name}>
        {branch.name}
      </span>
      {/* The name comes first: a phone says the age beside an icon, from 400 px wide. */}
      {age ? (
        <>
          <span aria-hidden className="shrink-0 opacity-40 max-[399px]:hidden">
            ·
          </span>
          <span className="hidden min-w-0 truncate opacity-75 sm:inline">{age}</span>
          <span
            title={age}
            // Set close: at this size the system font's own tracking opens "il y a" apart.
            className="flex shrink-0 items-center gap-1 tracking-tight whitespace-nowrap opacity-75 max-[399px]:hidden sm:hidden"
          >
            <Database aria-hidden className="size-3" />
            <span className="sr-only">{`${messages.dataShort} `}</span>
            {short(branch.dataTakenAt as string)}
          </span>
        </>
      ) : null}
      <span className="flex-1" />
      {/* A phone's finger-sized actions sit side by side; their icons keep them apart. */}
      <span className="flex shrink-0 items-center sm:gap-2">
        {refreshUrl ? (
          <BarAction href={refreshUrl} label={messages.refreshLabel(branch.name)} newTab>
            <RefreshCw aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">{messages.refresh}</span>
          </BarAction>
        ) : null}
        {production ? (
          <BarAction href={production} label={messages.back}>
            <ArrowUpRight aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">{messages.back}</span>
          </BarAction>
        ) : null}
        <BarAction label={messages.hide} onClick={() => toggle(true)}>
          <ChevronUp aria-hidden className="size-3.5" />
        </BarAction>
      </span>
    </aside>
  )
}

/**
 * One of the bar's actions: 24 px tall on a wide screen, a 44 px square on a phone, where its
 * label is left out and only its icon shows.
 */
function BarAction({
  href,
  label,
  newTab = false,
  onClick,
  children,
}: {
  readonly href?: string
  readonly label: string
  readonly newTab?: boolean
  readonly onClick?: () => void
  readonly children: ReactNode
}) {
  const className =
    "flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-md opacity-80 transition-opacity outline-none hover:bg-white/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 sm:size-auto sm:h-6 sm:min-w-6 sm:px-2"
  return href ? (
    <a
      href={href}
      aria-label={label}
      title={label}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={className}
    >
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={className}>
      {children}
    </button>
  )
}

/** "2 h ago", "il y a 2 h": an age that fits a phone's bar. */
function useShortAge(): (timestamp: string) => string {
  const locale = useLocale()
  return (timestamp) => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 60_000))
    const [value, unit] =
      minutes < 60
        ? [Math.max(1, minutes), "min"]
        : minutes < 48 * 60
          ? [Math.round(minutes / 60), "h"]
          : [Math.round(minutes / (24 * 60)), locale.startsWith("fr") ? "j" : "d"]
    return locale.startsWith("fr") ? `il y a ${value} ${unit}` : `${value} ${unit} ago`
  }
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
