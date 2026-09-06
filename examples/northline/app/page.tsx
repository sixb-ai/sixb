import { AgentPanel, isAppAgentNavigation, setAgentSurfaceMode } from "@sixb/app/agents"
import { CalendarClock, ClipboardList, Gauge, Network } from "lucide-react"
import type { ComponentType, SVGProps } from "react"
import { useEffect } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

const ASSISTANT_ID = "operations-assistant"

const shortcuts = [
  {
    href: "/equipment",
    label: "Equipment",
    description: "Asset health and telemetry",
    icon: Gauge,
  },
  {
    href: "/service-cases",
    label: "Service cases",
    description: "Issues needing attention",
    icon: ClipboardList,
  },
  {
    href: "/dispatch",
    label: "Dispatch",
    description: "Today’s field work",
    icon: CalendarClock,
  },
  {
    href: "/customers",
    label: "Customers",
    description: "Accounts and facilities",
    icon: Network,
  },
] as const

export default function NorthlineHomePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const agentContinuation = isAppAgentNavigation(location.state)

  useEffect(() => {
    setAgentSurfaceMode(ASSISTANT_ID, agentContinuation ? "dock" : "collapsed")
  }, [agentContinuation])

  const changeThread = (nextThreadId: string | null) => {
    if (!nextThreadId) return
    navigate(`/chat/${encodeURIComponent(nextThreadId)}`)
  }

  return (
    <section className="h-full min-h-[34rem]">
      {agentContinuation ? (
        <HomeContinuationCanvas />
      ) : (
        <AgentPanel
          agentId={ASSISTANT_ID}
          threadId={null}
          onThreadChange={changeThread}
          centerEmptyState
          hideHeaderOnEmpty
          emptyStateThreadHistoryLabel="Recent conversations"
          emptyStateHeader={<NorthlineHomeBrand />}
          emptyStateFooter={<HomeShortcuts />}
          composerPlaceholder="Ask Northline about today’s work"
          className="h-full bg-transparent"
        />
      )}
    </section>
  )
}

function HomeContinuationCanvas() {
  return (
    <div className="flex h-full items-center justify-center px-4 pb-[8vh]">
      <div className="w-full max-w-3xl">
        <NorthlineHomeBrand />
        <div className="mt-7">
          <HomeShortcuts />
        </div>
      </div>
    </div>
  )
}

function NorthlineHomeBrand() {
  return (
    <div className="text-center">
      <img
        src="/brand/northline-wordmark.svg"
        alt="Northline Mechanical"
        className="mx-auto h-16 w-auto sm:h-20 dark:hidden"
      />
      <img
        src="/brand/northline-wordmark-light.svg"
        alt="Northline Mechanical"
        className="mx-auto hidden h-16 w-auto sm:h-20 dark:block"
      />
    </div>
  )
}

function HomeShortcuts() {
  return (
    <nav
      className="mx-auto grid max-w-2xl gap-2 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="Shortcuts"
    >
      {shortcuts.map((shortcut) => (
        <Shortcut key={shortcut.href} {...shortcut} />
      ))}
    </nav>
  )
}

function Shortcut({
  href,
  label,
  description,
  icon: Icon,
}: {
  href: string
  label: string
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}) {
  return (
    <Link
      to={href}
      className="group flex min-h-20 items-center gap-3 rounded-xl border border-border/75 bg-card/70 px-3.5 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
        <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-sm font-medium text-foreground">{label}</strong>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </Link>
  )
}
