import { setAgentSurfaceMode } from "@sixb/app"
import { useSidebar } from "@sixb/ui/components"
import { ChevronLeft, MessageSquareText } from "lucide-react"
import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { GlobalSearch } from "../global-search"
import {
  backLabel,
  fallbackTitle,
  isConversationPath,
  isRootPath,
  parentPath,
  screenPath,
} from "./phone-routes"

/**
 * The phone's top bar. It sits over the page and turns to frosted glass once content scrolls
 * beneath it. Pushed screens get a back button; the page's own heading moves into the bar when it
 * scrolls out of view, as large titles do on iOS. Over a conversation it is only the back button:
 * the conversation's header carries its own actions.
 */
export function PhoneTopBar() {
  // Mounted only on phones, so its search button's ⌘K shortcut never doubles the sidebar's.
  const { isMobile } = useSidebar()
  return isMobile ? <TopBar /> : null
}

function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const path = screenPath(location.pathname, location.search)
  const home = path === "/"
  // Neither mounts the dock: Home is a chat of its own, and Threads starts new ones on Home.
  const dockless = home || path === "/threads"
  const conversation = isConversationPath(path)
  const heading = usePageHeading(path)
  const scrolled = useScrolled(path)

  // Home's greeting is not a title, and a conversation names itself in its own header.
  const title = home || conversation ? "" : (heading?.text ?? fallbackTitle(path))
  const titleVisible = title !== "" && (heading ? heading.hidden : true)

  // Back follows history inside the app; opened directly, it climbs to the parent screen.
  const back = () => {
    if (location.key !== "default") navigate(-1)
    else navigate(parentPath(path), { replace: true })
  }

  return (
    <header
      className="phone-top-bar"
      data-scrolled={(scrolled && !conversation) || undefined}
      data-conversation={conversation || undefined}
    >
      <div className="phone-top-bar-row">
        <div className="phone-top-bar-leading">
          {isRootPath(path) ? null : (
            <button
              type="button"
              onClick={back}
              aria-label={`Back to ${backLabel(path)}`}
              className="phone-back phone-glass"
            >
              <ChevronLeft aria-hidden="true" strokeWidth={2.2} />
            </button>
          )}
        </div>

        <div
          className="phone-top-bar-title"
          data-visible={titleVisible || undefined}
          aria-hidden="true"
        >
          {title}
        </div>

        {conversation ? null : (
          <div className="phone-top-bar-trailing">
            <div className="phone-bar-group phone-glass">
              <GlobalSearch placement="toolbar" />
              {/* New chats start in Home's chat bar; elsewhere Chat opens the dock on this page. */}
              {dockless ? null : (
                <button
                  type="button"
                  onClick={() => setAgentSurfaceMode("dock")}
                  aria-label="Chat about this page"
                  className="phone-chat"
                >
                  <MessageSquareText className="size-[17px]" strokeWidth={2} aria-hidden="true" />
                  <span>Chat</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}

interface PageHeading {
  readonly text: string
  readonly hidden: boolean
}

/** The current page's first heading, and whether it has scrolled up under the bar. */
function usePageHeading(path: string): PageHeading | null {
  const [heading, setHeading] = useState<PageHeading | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: each screen brings its own heading.
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("[data-app-scroll]")
    const bar = document.querySelector<HTMLElement>(".phone-top-bar")
    if (!scroller) return

    let element: HTMLElement | null = null
    let observer: IntersectionObserver | null = null
    let hidden = false
    let frame = 0

    const publish = () => {
      const next = element ? { text: headingText(element), hidden } : null
      setHeading((current) =>
        current?.text === next?.text && current?.hidden === next?.hidden ? current : next
      )
    }

    const attach = () => {
      const found = scroller.querySelector<HTMLElement>("h1")
      if (found !== element) {
        observer?.disconnect()
        element = found
        hidden = false
        if (element) {
          const inset = bar?.offsetHeight ?? 0
          observer = new IntersectionObserver(
            ([entry]) => {
              hidden = !entry.isIntersecting && entry.boundingClientRect.top < inset
              publish()
            },
            { root: scroller, rootMargin: `-${inset}px 0px 0px 0px` }
          )
          observer.observe(element)
        }
      }
      publish()
    }

    attach()
    // Pages render their heading once their data arrives, and some rename it in place.
    const mutations = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(attach)
    })
    mutations.observe(scroller, { childList: true, subtree: true, characterData: true })

    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      observer?.disconnect()
    }
  }, [path])

  return heading
}

/** Whether anything in the page has scrolled, including panes that scroll on their own. */
function useScrolled(path: string): boolean {
  const [scrolled, setScrolled] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: each screen starts at its own offset.
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("[data-app-scroll]")
    if (!scroller) return
    setScrolled(scroller.scrollTop > 1)

    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      // Sideways strips such as tabs and boards do not lift the bar.
      if (target !== scroller && target.scrollHeight <= target.clientHeight) return
      setScrolled(target.scrollTop > 1)
    }
    scroller.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => scroller.removeEventListener("scroll", onScroll, { capture: true })
  }, [path])

  return scrolled
}

// Badges and status pills, buttons and icons inside a heading are not part of its name.
const NOT_TITLE =
  '[data-slot="badge"], [role="status"], .rounded-full, button, svg, .sr-only, [aria-hidden="true"]'

/** The heading's name for the bar: an explicit `data-bar-title`, else its text without extras. */
function headingText(heading: HTMLElement): string {
  if (heading.dataset.barTitle) return heading.dataset.barTitle
  const copy = heading.cloneNode(true)
  if (!(copy instanceof HTMLElement)) return clean(heading.textContent)
  for (const extra of copy.querySelectorAll(NOT_TITLE)) extra.remove()
  // A heading that is itself a control, such as a title that renames on tap, keeps its text.
  return clean(copy.textContent) || clean(heading.textContent)
}

function clean(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}
