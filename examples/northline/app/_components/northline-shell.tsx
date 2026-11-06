import { SectionNav, UserMenu, useCurrentSection } from "@sixb/app"
import { events, objectQueryKeys, useInvalidateOnEvent, useObjectsCount } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  CalendarClock,
  ClipboardList,
  FileText,
  Gauge,
  Handshake,
  Network,
  Sun,
  UsersRound,
} from "lucide-react"
import type { ComponentType, PropsWithChildren } from "react"
import { Link, useLocation } from "react-router-dom"
import { Quote } from "../../ontology/quote"
import { ServiceCase } from "../../ontology/service-case"
import { threadPath, useRecentThreads } from "../_lib/agent-threads"
import { GlobalSearch } from "./global-search"
import { NorthlineWordmark } from "./northline-wordmark"
import { OperationsAssistant } from "./operations-assistant"

const openCases = objects(ServiceCase)
  .query()
  .where((serviceCase) =>
    serviceCase.and(serviceCase.p.status.neq("closed"), serviceCase.p.status.neq("cancelled"))
  )

const quotesWithCustomer = objects(Quote)
  .query()
  .where((quote) => quote.p.status.eq("sent"))

interface NavLink {
  readonly href: string
  readonly label: string
  readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>
  readonly count?: "openCases" | "quotesWithCustomer"
}

const groups: ReadonlyArray<{ readonly label?: string; readonly items: readonly NavLink[] }> = [
  {
    items: [
      { href: "/", label: "Home", icon: Sun },
      { href: "/service-cases", label: "Service cases", icon: ClipboardList, count: "openCases" },
      { href: "/dispatch", label: "Dispatch", icon: CalendarClock },
      { href: "/equipment", label: "Equipment", icon: Gauge },
      { href: "/technicians", label: "Technicians", icon: UsersRound },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/quotes", label: "Quotes", icon: FileText, count: "quotesWithCustomer" },
      { href: "/contracts", label: "Contracts", icon: Handshake },
      { href: "/customers", label: "Customers", icon: Network },
    ],
  },
]

// Sits in `AppShellProvider` from the root layout, which also covers the full-screen threads page.
export function NorthlineShell({ children }: PropsWithChildren) {
  const location = useLocation()
  const threadsPageActive = location.pathname === "/threads"
  const conversationActive = location.pathname.startsWith("/threads/")
  // Console and Settings pages bring their own margins, and some fill the height.
  const sectionActive = useCurrentSection() !== null
  useInvalidateOnEvent(events.objects(), () => [objectQueryKeys.all()], {
    debounceMs: 75,
    enabled: !threadsPageActive,
  })
  useInvalidateOnEvent(events.links(), () => [objectQueryKeys.all()], {
    debounceMs: 75,
    enabled: !threadsPageActive,
  })

  if (threadsPageActive) return children

  return (
    <>
      <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
        <SidebarHeader className="gap-4 px-3.5 pt-5 pb-2">
          <Link
            to="/"
            aria-label="Northline Operations home"
            className="flex h-9 items-center px-1.5"
          >
            <NorthlineWordmark className="mx-0 h-8" />
          </Link>
          <GlobalSearch />
        </SidebarHeader>
        <SidebarContent className="gap-6 px-3.5 pt-3 pb-4">
          {/* Inside the Console or Settings the sidebar lists that section's pages instead. */}
          <SectionNav
            fallback={
              <>
                <NorthlineNav />
                <RecentThreads />
              </>
            }
          />
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border px-3.5 py-3">
          <UserMenu />
        </SidebarFooter>
      </Sidebar>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <SidebarInset className="relative h-svh min-h-0 overflow-hidden bg-background">
          <SidebarTrigger className="absolute top-3 left-3 z-50 md:hidden" />
          <div className="min-h-0 flex-1 overflow-y-auto" data-app-scroll>
            <div
              className={
                conversationActive || sectionActive
                  ? "h-full w-full"
                  : "mx-auto w-full max-w-[1180px] px-5 pt-14 pb-16 sm:px-10 md:pt-10 lg:px-14"
              }
            >
              {children}
            </div>
          </div>
        </SidebarInset>
        <OperationsAssistant />
      </div>
    </>
  )
}

function NorthlineNav() {
  const { pathname } = useLocation()
  const openCaseCount = useObjectsCount(openCases)
  const quoteCount = useObjectsCount(quotesWithCustomer)
  const counts = { openCases: openCaseCount.data, quotesWithCustomer: quoteCount.data }

  return (
    <nav aria-label="Northline" className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label ?? "workspace"} className="flex flex-col gap-0.5">
          {group.label ? (
            <span className="px-3 pb-1.5 text-[12px] font-semibold text-muted-foreground">
              {group.label}
            </span>
          ) : null}
          {group.items.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
            const count = item.count ? counts[item.count] : undefined
            return (
              <Link
                key={item.href}
                to={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14.5px] font-medium text-foreground/80 transition-colors hover:bg-black/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:hover:bg-white/[0.06]",
                  active &&
                    "bg-sidebar-accent font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.07)] hover:bg-sidebar-accent"
                )}
              >
                <item.icon
                  className={cn("size-[18px]", active ? "text-primary" : "text-foreground/70")}
                  strokeWidth={active ? 2 : 1.7}
                />
                <span className="flex-1 truncate">{item.label}</span>
                {count ? (
                  <span className="text-[12px] font-medium text-muted-foreground tabular-nums">
                    {count}
                  </span>
                ) : null}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function RecentThreads() {
  const { pathname } = useLocation()
  const { threads } = useRecentThreads()
  if (threads.length === 0) return null

  return (
    <div className="flex min-h-0 flex-col gap-0.5">
      <div className="flex items-center justify-between px-3 pb-1.5">
        <span className="text-[12px] font-semibold text-muted-foreground">Recents</span>
        <Link to="/threads" className="text-[12px] font-medium text-primary hover:underline">
          View all
        </Link>
      </div>
      {threads.slice(0, 8).map((thread) => {
        const to = threadPath(thread.id)
        const active = pathname === to
        const title = thread.title?.trim() || "New conversation"
        return (
          <Link
            key={thread.id}
            to={to}
            title={title}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-2 rounded-[9px] px-3 text-[13.5px] text-foreground/75 transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]",
              active && "bg-sidebar-accent font-semibold text-foreground hover:bg-sidebar-accent"
            )}
          >
            <span className="flex-1 truncate">{title}</span>
            {thread.activeRunId ? (
              <span
                role="status"
                aria-label="Working"
                className="size-[7px] shrink-0 animate-pulse rounded-full bg-primary"
              />
            ) : null}
          </Link>
        )
      })}
    </div>
  )
}
