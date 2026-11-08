import { useSidebar } from "@sixb/ui/components"
import { Ellipsis } from "lucide-react"
import { type CSSProperties, useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { places } from "../../_lib/navigation"
import { appScroller } from "./phone-dom"
import { normalizePath, type PhoneTab, tabFor } from "./phone-routes"

const TABS = places.filter((place) => place.tab)

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

  // A tab is named by its first screen.
  const select = (tab: PhoneTab) => {
    if (tab !== current) {
      navigate(lastPathByTab.get(tab) ?? tab)
      return
    }
    if (path !== tab) {
      lastPathByTab.delete(tab)
      navigate(tab)
      return
    }
    appScroller()?.scrollTo({ top: 0, behavior: "smooth" })
  }

  if (!isMobile) return null

  // More stands for the sheet while it is open, and for every screen without a tab of its own.
  const moreActive = current === "more" || openMobile
  const index = moreActive ? TABS.length : TABS.findIndex(({ href }) => href === current)

  return (
    <nav
      className="phone-tab-bar"
      aria-label="Primary"
      style={{ "--tab-index": index } as CSSProperties}
    >
      <span className="phone-tab-lens" aria-hidden="true" />
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = href === current && !openMobile
        return (
          <button
            key={href}
            type="button"
            onClick={() => select(href)}
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
