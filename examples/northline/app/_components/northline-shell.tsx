import { SectionNav, UserMenu, useCurrentSection } from "@sixb/app"
import { events, objectQueryKeys, useInvalidateOnEvent, useObjectsCount } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { SidebarContent, SidebarFooter, SidebarHeader, SidebarInset } from "@sixb/ui/components"
import type { PropsWithChildren } from "react"
import { Link, useLocation } from "react-router-dom"
import { Quote } from "../../ontology/quote"
import { threadPath, threadTitle, useRecentThreads } from "../_lib/agent-threads"
import { places } from "../_lib/navigation"
import { openServiceCases } from "../_lib/service-cases"
import { GlobalSearch } from "./global-search"
import { NorthlineMark } from "./northline-mark"
import { OperationsAssistant } from "./operations-assistant"
import { NorthlineTabBar, NorthlineTopBar, SidebarOrMoreSheet } from "./phone/northline-phone"

const quotesWithCustomer = objects(Quote)
  .query()
  .where((quote) => quote.p.status.eq("sent"))

const groups = [
  { items: places.filter((place) => place.section === "operations") },
  { label: "Business", items: places.filter((place) => place.section === "business") },
]

// Sits in `AppShellProvider` from the root layout.
export function NorthlineShell({ children }: PropsWithChildren) {
  const location = useLocation()
  const conversationActive = location.pathname.startsWith("/threads/")
  const sectionActive = useCurrentSection() !== null
  // The threads list, Console and Settings pages bring their own margins, and some fill the height.
  const ownLayout = conversationActive || location.pathname === "/threads" || sectionActive
  useInvalidateOnEvent(events.objects(), () => [objectQueryKeys.all()], { debounceMs: 75 })
  useInvalidateOnEvent(events.links(), () => [objectQueryKeys.all()], { debounceMs: 75 })

  return (
    <>
      <SidebarOrMoreSheet collapsible="offcanvas" className="nl-sidebar">
        <SidebarHeader className="nl-sidebar-header">
          <Link to="/" aria-label="Northline Operations home" className="nl-sidebar-brand">
            <NorthlineMark className="mx-0 size-[26px]" />
            <span className="nl-sidebar-brand-name">Northline</span>
          </Link>
          <GlobalSearch />
        </SidebarHeader>
        <SidebarContent className="nl-sidebar-content">
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
        <SidebarFooter className="nl-sidebar-footer">
          <UserMenu />
        </SidebarFooter>
      </SidebarOrMoreSheet>
      {/* Below 768 px: a top bar and a tab bar over the page; a conversation's composer takes
          the tab bar's place. */}
      <div
        className="phone-shell relative flex min-h-0 min-w-0 flex-1"
        data-tab-bar={conversationActive ? "hidden" : undefined}
      >
        <SidebarInset className="relative h-svh min-h-0 overflow-hidden bg-background">
          <NorthlineTopBar />
          <div className="min-h-0 flex-1 overflow-y-auto" data-app-scroll>
            <div
              className={
                ownLayout
                  ? "h-full w-full"
                  : "mx-auto w-full max-w-[1180px] px-5 pt-2 pb-6 sm:px-10 md:pt-10 md:pb-16 lg:px-14"
              }
            >
              {children}
            </div>
          </div>
          {conversationActive ? null : <NorthlineTabBar />}
        </SidebarInset>
        <OperationsAssistant />
      </div>
    </>
  )
}

function NorthlineNav() {
  const { pathname } = useLocation()
  const openCaseCount = useObjectsCount(openServiceCases)
  const quoteCount = useObjectsCount(quotesWithCustomer)
  const counts = { openCases: openCaseCount.data, quotesWithCustomer: quoteCount.data }

  return (
    <nav aria-label="Northline">
      {groups.map((group) => (
        <section
          key={group.label ?? "workspace"}
          className={group.label ? "nl-sidebar-section" : undefined}
        >
          {group.label ? <h2 className="nl-sidebar-label">{group.label}</h2> : null}
          <ul className="nl-sidebar-list">
            {group.items.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
              const count = item.count ? counts[item.count] : undefined
              return (
                <li key={item.href}>
                  <Link
                    to={item.href}
                    aria-current={active ? "page" : undefined}
                    className="nl-sidebar-row"
                  >
                    <item.icon />
                    <span className="truncate">{item.label}</span>
                    {count ? <span className="nl-sidebar-count">{count}</span> : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </nav>
  )
}

function RecentThreads() {
  const { pathname } = useLocation()
  const { threads } = useRecentThreads()
  if (threads.length === 0) return null

  return (
    <section className="nl-sidebar-section">
      <div className="nl-sidebar-label">
        <h2>Recents</h2>
        <Link to="/threads" className="nl-sidebar-label-action">
          View all
        </Link>
      </div>
      <ul className="nl-sidebar-list">
        {threads.slice(0, 12).map((thread) => {
          const to = threadPath(thread.id)
          const title = threadTitle(thread)
          return (
            <li key={thread.id}>
              <Link
                to={to}
                title={title}
                aria-current={pathname === to ? "page" : undefined}
                className="nl-sidebar-row nl-sidebar-chat"
              >
                <span className="truncate">{title}</span>
                {thread.activeRunId ? (
                  <span role="status" aria-label="Working" className="nl-working-dot" />
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
