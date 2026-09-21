"use client"

import { Pause, Play, X } from "lucide-react"
import { type RefObject, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

const steps = [
  {
    file: "connectors/google-ads.ts",
    title: "Connect a source",
    text: "This connector gives your project access to Google Ads.",
    from: "export const ads",
    to: "googleAds({",
  },
  {
    file: "datasets/campaigns.ts",
    title: "Define the rows",
    text: "A dataset describes the imported rows stored in your data lake.",
    from: "export const rawCampaigns",
    to: 'primaryKey: "id"',
  },
  {
    file: "syncs/campaigns.ts",
    title: "Bring the data in",
    text: "Read campaigns from the connector and send them into the raw dataset.",
    from: "for await",
    to: ".intoDataset",
  },
  {
    file: "pipelines/campaigns.ts",
    title: "Clean and shape",
    text: "Run separate steps to select active campaigns and clean their names.",
    from: "export const prepareCampaigns",
    to: ".then(cleanNames)",
  },
  {
    file: "ontology/campaign.ts",
    title: "Define your shared model",
    text: "The ontology describes a campaign’s properties and its link to an account.",
    from: "export const Campaign",
    to: "properties: [",
  },
  {
    file: "projections/campaigns.ts",
    title: "Map rows to objects",
    text: "Map cleaned dataset columns to the properties of campaign objects.",
    from: ".fromDataset",
    to: 'status: "status"',
  },
  {
    file: "app/page.tsx",
    title: "Build on your data",
    text: "Your React app queries those typed objects. Keep exploring the other files at your own pace.",
    from: "const query",
    to: "useObjectsQuery(query)",
  },
]

export function useCodeGuide(
  root: RefObject<HTMLElement | null>,
  select: (path: string) => void,
  enabled: boolean,
  filesOpen: boolean,
  openFiles: () => void
) {
  const navigation = useRef<HTMLElement>(null)
  const bubble = useRef<HTMLElement>(null)
  const positioned = useRef<string | null>(null)
  const [index, setIndex] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(0)
  const nextStep = steps[index === null ? 0 : index + 1]
  const step = index === null ? undefined : steps[index]

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)")
    const update = () => {
      setMobile(media.matches)
      if (media.matches) setPaused(true)
      setHovered(false)
    }
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  function stop() {
    setIndex(null)
    setDismissed(true)
  }
  function go(next: number) {
    if (next < 0) return
    if (next >= steps.length) {
      stop()
      return
    }
    if (index === null && mobile) setPaused(true)
    select(steps[next]!.file)
    setIndex(next)
    setProgress(0)
    if (mobile) root.current?.scrollIntoView({ block: "start", behavior: "instant" })
  }

  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.35 }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    if (!step || paused || hovered || !visible || filesOpen) return
    let previous = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const elapsed = now - previous
      previous = now
      if (!document.hidden) setProgress((value) => Math.min(1, value + elapsed / 11000))
    }, 50)
    return () => clearInterval(timer)
  }, [step, paused, hovered, visible, filesOpen])

  // Advance from an effect so selection never changes during a state updater.
  useEffect(() => {
    if (progress >= 1 && index !== null) go(index + 1)
  })

  useEffect(() => {
    for (const line of root.current?.querySelectorAll(".guide-line") ?? [])
      line.classList.remove("guide-line")
    if (!step) {
      positioned.current = null
      return
    }
    const element = root.current
    const lines = Array.from(
      element?.querySelectorAll<HTMLElement>(".project-code-scroll .line") ?? []
    )
    const start = lines.findIndex((line) => line.textContent?.includes(step.from))
    const end = lines.findIndex(
      (line, position) => position >= start && line.textContent?.includes(step.to)
    )
    const active = lines.slice(start, Math.max(start, end) + 1)
    for (const line of active) line.classList.add("guide-line")
    if (positioned.current === step.file) return
    positioned.current = step.file
    const scroller = element?.querySelector(".project-code-scroll")
    const first = active[0]
    if (scroller && first)
      scroller.scrollTop +=
        first.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
    const button = element?.querySelector<HTMLElement>(
      `.project-desktop-files [aria-label="${nextStep?.file ?? step.file}"]`
    )
    let parent = button?.parentElement
    while (parent && parent !== element) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
      parent = parent.parentElement
    }
    const nav = button?.closest("nav")
    if (button && nav)
      nav.scrollTop += button.getBoundingClientRect().top - nav.getBoundingClientRect().top - 80
    return () => {
      for (const line of active) line.classList.remove("guide-line")
    }
  })

  useEffect(() => {
    if (!filesOpen || !nextStep) return
    const timer = setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[role="dialog"] [aria-label="${nextStep.file}"]`
      )
      target?.scrollIntoView({ block: "center" })
    }, 100)
    return () => clearTimeout(timer)
  }, [filesOpen, nextStep])

  // Position the portal against actual visible elements, including after scrolling.
  useEffect(() => {
    function place() {
      const card = bubble.current
      const editor = root.current
      if (!editor) return
      const cue = navigation.current
      if (cue && nextStep) {
        const mobile = window.innerWidth <= 640
        const target =
          mobile && !filesOpen
            ? editor.querySelector<HTMLElement>(".project-mobile-files")
            : (mobile
                ? document.querySelector('[role="dialog"]')
                : editor
              )?.querySelector<HTMLElement>(`[aria-label="${nextStep.file}"]`)
        if (target) {
          const rect = target.getBoundingClientRect()
          const nav = target.closest("nav")?.getBoundingClientRect()
          const inView =
            rect.height > 0 &&
            rect.top >= Math.max(60, nav?.top ?? 60) &&
            rect.bottom <= Math.min(window.innerHeight, nav?.bottom ?? window.innerHeight)
          const left = rect.left - cue.offsetWidth - 12
          const fitsLeft = left >= 8
          cue.style.left = `${fitsLeft ? left : Math.max(8, rect.left - 16)}px`
          cue.style.top = `${fitsLeft ? rect.top + (rect.height - cue.offsetHeight) / 2 : rect.top - cue.offsetHeight - 8}px`
          cue.dataset.side = fitsLeft ? "right" : "bottom"
          cue.style.setProperty(
            "--guide-arrow",
            fitsLeft ? `${cue.offsetHeight / 2 - 4}px` : "20px"
          )
          cue.style.visibility = inView ? "visible" : "hidden"
        } else cue.style.visibility = "hidden"
      }
      if (!card) return
      if (filesOpen) {
        card.style.visibility = "hidden"
        return
      }
      const mobile = window.innerWidth <= 640
      const target = step
        ? editor.querySelector<HTMLElement>(".guide-line")
        : editor.querySelector<HTMLElement>(
            mobile
              ? ".project-breadcrumb"
              : '.project-desktop-files [aria-label="connectors/google-ads.ts"]'
          )
      const boundary = step
        ? editor.querySelector(".project-code-scroll")
        : editor.querySelector(mobile ? ".project-source-title" : ".project-desktop-files")
      if (!target || !boundary) {
        card.style.visibility = "hidden"
        return
      }
      const rect = target.getBoundingClientRect()
      const bounds = boundary.getBoundingClientRect()
      const top = Math.max(rect.top, bounds.top)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      if (bottom <= top || top < 60 || bottom > window.innerHeight) {
        card.style.visibility = "hidden"
        return
      }
      const width = card.offsetWidth
      const height = card.offsetHeight
      const editorRect = editor.getBoundingClientRect()
      const right = step ? editorRect.right + 14 : rect.right + 14
      let x: number
      let y: number
      let side: string
      if (right + width < window.innerWidth - 12) {
        x = right
        y = Math.max(64, Math.min(top - 12, window.innerHeight - height - 12))
        side = "left"
      } else {
        x = Math.max(12, Math.min(rect.left + (step ? 30 : 0), window.innerWidth - width - 12))
        const last = step
          ? Array.from(editor.querySelectorAll(".guide-line")).at(-1)?.getBoundingClientRect()
          : rect
        const after = Math.min(last?.bottom ?? bottom, bounds.bottom) + 14
        y = after + height < window.innerHeight - 12 ? after : top - height - 14
        y = Math.max(64, y)
        side = y < top ? "bottom" : "top"
      }
      card.style.left = `${x}px`
      card.style.top = `${y}px`
      card.dataset.side = side
      card.style.setProperty(
        "--guide-arrow",
        `${side === "left" ? Math.max(14, top - y + 10) : Math.max(14, Math.min(width - 20, rect.left + 40 - x))}px`
      )
      card.style.visibility = "visible"
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  })

  return {
    step,
    dismissed,
    stop,
    start: () => go(0),
    selectFile: (path: string) => {
      if (enabled && !dismissed && path === nextStep?.file) go(index === null ? 0 : index + 1)
      else {
        stop()
        select(path)
      }
    },
    interaction: () => {
      if (step) setPaused(true)
    },
    mobileHeader:
      enabled && !dismissed ? (
        <div className="project-mobile-guide">
          {step ? (
            <section aria-label="Code walkthrough">
              <div className="project-mobile-guide-heading">
                <strong>
                  {index! + 1} / {steps.length} · {step.title}
                </strong>
                <button type="button" aria-label="Close guide" onClick={stop}>
                  <X size={15} />
                </button>
              </div>
              <p aria-live="polite">{step.text}</p>
              <div
                className="project-mobile-guide-progress"
                aria-label={`Step ${index! + 1} of ${steps.length}`}
              >
                {steps.map((entry, position) => (
                  <span
                    key={entry.file}
                    data-complete={position < index!}
                    data-current={position === index}
                  >
                    <i
                      style={{
                        transform: `scaleX(${position < index! ? 1 : position === index ? (paused ? 1 : progress) : 0})`,
                      }}
                    />
                  </span>
                ))}
              </div>
            </section>
          ) : (
            <div className="project-mobile-guide-invitation">
              <button type="button" onClick={() => go(0)}>
                Start here <span aria-hidden="true">→</span>
              </button>
              <span>From connector to app</span>
              <button type="button" aria-label="Dismiss guide" onClick={stop}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      ) : null,
    mobileFooter:
      enabled && !dismissed && step ? (
        <nav
          className="project-mobile-guide project-mobile-guide-footer"
          aria-label="Walkthrough controls"
        >
          <div className="project-mobile-guide-buttons">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => go(index! - 1)}
              aria-label="Previous step"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => setPaused(!paused)}
              aria-label={paused ? "Play guide" : "Pause guide"}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
              {paused ? "Auto-play" : "Pause"}
            </button>
          </div>
          <button
            type="button"
            className="project-mobile-guide-next"
            onClick={() => go(index! + 1)}
          >
            <span>
              {nextStep ? "Next" : "Finish"}
              {nextStep && <small>{nextStep.file}</small>}
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </nav>
      ) : null,
    panel:
      enabled && visible && !dismissed && !mobile
        ? createPortal(
            <>
              {step && (
                <aside
                  ref={bubble}
                  className="project-guide project-guide-floating"
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  onFocusCapture={(event) => {
                    if (event.target.matches(":focus-visible")) setHovered(true)
                  }}
                  onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false)
                  }}
                  aria-label="Code walkthrough"
                >
                  <div className="project-guide-heading">
                    <span>
                      {index! + 1} / {steps.length} · {step.title}
                    </span>
                    <button type="button" aria-label="Close guide" onClick={stop}>
                      <X size={13} />
                    </button>
                  </div>
                  <p aria-live="polite">{step.text}</p>
                  <div className="project-guide-controls">
                    <button
                      type="button"
                      onClick={() => setPaused(!paused)}
                      aria-label={paused ? "Resume guide" : "Pause guide"}
                    >
                      {paused ? <Play size={12} /> : <Pause size={12} />}
                      {paused ? "Resume" : "Pause"}
                    </button>
                    {index === steps.length - 1 && (
                      <button type="button" onClick={stop}>
                        Finish
                      </button>
                    )}
                  </div>
                  <div className="project-guide-track" aria-hidden="true">
                    <span style={{ transform: `scaleX(${progress})` }} />
                  </div>
                </aside>
              )}
              {nextStep && (
                <aside
                  ref={navigation}
                  className="project-guide-invitation project-guide-floating"
                  aria-label={step ? "Next file in walkthrough" : "Start the code walkthrough"}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (window.innerWidth <= 640 && !filesOpen) {
                        openFiles()
                        return
                      }
                      go(index === null ? 0 : index + 1)
                    }}
                  >
                    {step ? "Next" : "Start here"} <span aria-hidden="true">→</span>
                  </button>
                  <button type="button" aria-label="Dismiss guide" onClick={stop}>
                    <X size={12} />
                  </button>
                </aside>
              )}
            </>,
            document.body
          )
        : null,
  }
}
