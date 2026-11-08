import { useSidebar } from "@sixb/ui/components"
import { ChevronLeft } from "lucide-react"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router-dom"
import { useAppMessages } from "../../locale"
import { useBack } from "./back"
import { appScroller, isRootPath, normalizePath } from "./routes"

export interface PhoneTopBarProps {
  /** Controls at the trailing end, such as Search; a page's own actions join them. */
  readonly trailing?: ReactNode
  /** Whether the page's heading moves into the bar as it scrolls away. Off for a greeting. */
  readonly title?: boolean
  /** Sit above the page's own overlays, as over a full-screen conversation. */
  readonly raised?: boolean
}

/**
 * A phone's top bar, in the iOS 26 manner. It has no bar at all while the page is at rest: its
 * controls float as glass over the page, and once content scrolls beneath them a soft blurred edge
 * fades in. Pushed screens get a back button (`useBack`); the page's first heading moves into the
 * bar when it scrolls out of view, as large titles do.
 */
export function PhoneTopBar(props: PhoneTopBarProps) {
  // Mounted only on phones, so controls with shortcuts never double the sidebar's.
  const { isMobile } = useSidebar()
  return isMobile ? <TopBar {...props} /> : null
}

function TopBar({ trailing, title = true, raised = false }: PhoneTopBarProps) {
  const location = useLocation()
  const back = useBack()
  const messages = useAppMessages()
  const path = normalizePath(location.pathname)
  const heading = usePageHeading(path)
  const scrolled = useScrolled(path)
  const text = title ? (heading?.text ?? "") : ""

  return (
    <header
      className="phone-top-bar"
      data-scrolled={scrolled || undefined}
      data-raised={raised || undefined}
    >
      <div className="phone-top-bar-row">
        <div className="phone-top-bar-leading">
          {isRootPath(path) ? null : (
            <button
              type="button"
              onClick={back}
              aria-label={messages.phone.back}
              className="phone-back phone-glass"
            >
              <ChevronLeft aria-hidden="true" strokeWidth={2.2} />
            </button>
          )}
        </div>

        <div
          className="phone-top-bar-title"
          data-visible={(text !== "" && heading?.hidden) || undefined}
          aria-hidden="true"
        >
          {text}
        </div>

        <div className="phone-top-bar-trailing">
          <div ref={registerSlot} className="phone-bar-slot" />
          {trailing ? <div className="phone-bar-group phone-glass">{trailing}</div> : null}
        </div>
      </div>
    </header>
  )
}

let slot: HTMLElement | null = null
const listeners = new Set<() => void>()

function registerSlot(element: HTMLElement | null): void {
  if (element === slot) return
  slot = element
  for (const listener of listeners) listener()
}

/**
 * A page's own actions in the phone's top bar, beside its trailing controls, such as a record's
 * Edit. Renders nothing while the bar is not shown, so wider screens keep the page's own controls.
 */
export function PhoneBarActions({ children }: { readonly children: ReactNode }) {
  const target = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => slot,
    () => null
  )
  return target ? createPortal(children, target) : null
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
    const scroller = appScroller()
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
    const scroller = appScroller()
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

/** The heading's text, as the bar shows it. */
function headingText(heading: HTMLElement): string {
  return (heading.textContent ?? "").replace(/\s+/g, " ").trim()
}
