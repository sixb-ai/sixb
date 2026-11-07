import { useSidebar } from "@sixb/ui/components"
import { Ellipsis } from "lucide-react"
import { type CSSProperties, useEffect } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { isCurrentItem, type NavItem } from "../nav-items"
import { appScroller, normalizePath } from "./routes"

// Each tab keeps the screen it was left on, as native tab bars do; More is "".
const lastPathByTab = new Map<string, string>()

export interface PhoneTabBarProps {
  /** The places the bar holds, up to four; More, for everything else, follows them. */
  readonly items: readonly NavItem[]
}

/**
 * A phone's tab bar: a floating glass capsule with the places people go most and More for
 * everything else, and a lens that glides to the current tab. Switching tabs returns to where that
 * tab was left; tapping the current tab goes back to its first screen, and from there scrolls to
 * the top. More opens the sidebar, which a phone shows as the More sheet.
 */
export function PhoneTabBar({ items }: PhoneTabBarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const path = normalizePath(location.pathname)
  const tabs = items.slice(0, 4)
  const current = tabs.find((item) => isCurrentItem(path, item))?.href ?? ""

  useEffect(() => {
    lastPathByTab.set(current, location.pathname + location.search)
  }, [current, location.pathname, location.search])

  const select = (tab: string) => {
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
  const moreActive = current === "" || openMobile
  const index = moreActive ? tabs.length : tabs.findIndex(({ href }) => href === current)

  return (
    <nav
      className="phone-tab-bar"
      aria-label="Primary"
      style={{ "--tab-index": index, "--tab-count": tabs.length + 1 } as CSSProperties}
    >
      <span className="phone-tab-lens" aria-hidden="true" />
      {tabs.map(({ href, label, icon: Icon }) => {
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
            {Icon ? (
              <Icon className="phone-tab-icon" />
            ) : (
              <span className="phone-tab-text">{label}</span>
            )}
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
        <Ellipsis aria-hidden="true" />
      </button>
    </nav>
  )
}
