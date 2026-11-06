import { useSidebar } from "@sixb/ui/components"
import { CalendarClock, ClipboardList, Ellipsis, Gauge, type LucideIcon, Sun } from "lucide-react"
import { type CSSProperties, useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { normalizePath, type PhoneTab, tabFor } from "./phone-routes"

const TABS = [
  { tab: "home", root: "/", label: "Home", Icon: Sun },
  { tab: "service-cases", root: "/service-cases", label: "Service cases", Icon: ClipboardList },
  { tab: "dispatch", root: "/dispatch", label: "Dispatch", Icon: CalendarClock },
  { tab: "equipment", root: "/equipment", label: "Equipment", Icon: Gauge },
] as const satisfies ReadonlyArray<{
  tab: PhoneTab
  root: string
  label: string
  Icon: LucideIcon
}>

// Each tab keeps the screen it was left on, as native tab bars do.
const lastPathByTab = new Map<PhoneTab, string>()

/**
 * The phone's tab bar: a floating glass capsule with the four places people go most and More for
 * everything else, and a lens that glides to the current tab. Switching tabs returns to where that
 * tab was left; tapping the current tab goes back to its first screen, and from there scrolls to
 * the top.
 */
export function PhoneTabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const path = normalizePath(location.pathname)
  const current = tabFor(path)

  useEffect(() => {
    lastPathByTab.set(current, location.pathname + location.search)
  }, [current, location.pathname, location.search])

  const select = (tab: PhoneTab, root: string) => {
    if (tab !== current) {
      navigate(lastPathByTab.get(tab) ?? root)
      return
    }
    if (path !== root) {
      lastPathByTab.delete(tab)
      navigate(root)
      return
    }
    document
      .querySelector<HTMLElement>("[data-app-scroll]")
      ?.scrollTo({ top: 0, behavior: "smooth" })
  }

  if (!isMobile) return null

  // More stands for the sheet while it is open, and for every screen without a tab of its own.
  const moreActive = current === "more" || openMobile
  const index = moreActive ? TABS.length : TABS.findIndex(({ tab }) => tab === current)

  return (
    <nav
      className="phone-tab-bar"
      aria-label="Primary"
      style={{ "--tab-index": index } as CSSProperties}
    >
      <span className="phone-tab-lens" aria-hidden="true" />
      {TABS.map(({ tab, root, label, Icon }) => {
        const active = tab === current && !openMobile
        return (
          <button
            key={tab}
            type="button"
            onClick={() => select(tab, root)}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className="phone-tab"
          >
            <Icon aria-hidden="true" strokeWidth={active ? 2.15 : 1.85} />
          </button>
        )
      })}
      <button
        type="button"
        onClick={() => setOpenMobile(!openMobile)}
        aria-label="More"
        aria-current={moreActive ? "page" : undefined}
        aria-haspopup="dialog"
        aria-expanded={openMobile}
        className="phone-tab"
      >
        <Ellipsis aria-hidden="true" strokeWidth={moreActive ? 2.15 : 1.85} />
      </button>
    </nav>
  )
}
