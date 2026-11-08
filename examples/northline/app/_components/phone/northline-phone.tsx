import {
  PhoneMoreGroup,
  PhoneMoreRow,
  PhoneMoreSheet,
  PhoneTabBar,
  PhoneTopBar,
  setAgentSurfaceMode,
} from "@sixb/app"
import { Sidebar, useSidebar } from "@sixb/ui/components"
import { MessageSquareText, MessagesSquare } from "lucide-react"
import type { ComponentProps } from "react"
import { useLocation } from "react-router-dom"
import { threadPath, threadTitle, useRecentThreads } from "../../_lib/agent-threads"
import { places } from "../../_lib/navigation"
import { GlobalSearch } from "../global-search"

const RECENT_THREADS = 4

// The sidebar's groups, as the More sheet lists what the tab bar leaves to it.
const nav = [
  { group: "Operations", items: places.filter((place) => place.section === "operations") },
  { group: "Business", items: places.filter((place) => place.section === "business") },
]

const tabs = places.filter((place) => place.tab)

/**
 * The sidebar from 768px up. On a phone the framework's More sheet takes its place, with the
 * latest conversations after Northline's places, and anything that opens the sidebar opens it.
 */
export function SidebarOrMoreSheet(props: ComponentProps<typeof Sidebar>) {
  const { isMobile } = useSidebar()
  if (!isMobile) return <Sidebar {...props} />
  return (
    <PhoneMoreSheet nav={nav}>
      <RecentThreads />
    </PhoneMoreSheet>
  )
}

/** Home, Service cases, Dispatch and Equipment, then More. */
export function NorthlineTabBar() {
  return <PhoneTabBar items={tabs} />
}

/**
 * Search and Chat on every screen. Home's greeting is not a title, and a conversation, which covers
 * the page, keeps only the back button and names itself in its own header.
 */
export function NorthlineTopBar() {
  const { pathname } = useLocation()
  const home = pathname === "/"
  const conversation = pathname.startsWith("/threads/")
  // Neither mounts the dock: Home is a chat of its own, and Threads starts new ones on Home.
  const dockless = home || pathname === "/threads"

  if (conversation) return <PhoneTopBar title={false} raised />
  return (
    <PhoneTopBar
      title={!home}
      trailing={
        <>
          <GlobalSearch placement="toolbar" />
          {dockless ? null : (
            <button
              type="button"
              onClick={() => setAgentSurfaceMode("dock")}
              aria-label="Chat about this page"
              className="phone-bar-text"
            >
              <MessageSquareText className="size-[17px]" strokeWidth={2} aria-hidden="true" />
              <span>Chat</span>
            </button>
          )}
        </>
      }
    />
  )
}

function RecentThreads() {
  const { pathname } = useLocation()
  const { threads, loading } = useRecentThreads()
  if (loading || threads.length === 0) return null

  return (
    <PhoneMoreGroup label="Recents">
      {threads.slice(0, RECENT_THREADS).map((thread) => {
        const to = threadPath(thread.id)
        return (
          <PhoneMoreRow
            key={thread.id}
            to={to}
            label={threadTitle(thread)}
            current={pathname === to}
            trailing={
              thread.activeRunId ? (
                <span role="status" aria-label="Working" className="nl-working-dot" />
              ) : null
            }
          />
        )
      })}
      <PhoneMoreRow
        to="/threads"
        label="All threads"
        icon={MessagesSquare}
        current={pathname === "/threads"}
      />
    </PhoneMoreGroup>
  )
}
