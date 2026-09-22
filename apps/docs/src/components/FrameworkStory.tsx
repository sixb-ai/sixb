"use client"

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy } from "lucide-react"
import Link from "next/link"
import {
  type CSSProperties,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { walkthrough } from "../generated/walkthrough"
import { useClipboard } from "./useClipboard"
import "./frameworkStory.css"

type Chapter = (typeof walkthrough)[number]
export interface FrameworkStoryHandle {
  goTo: (id: Chapter["id"]) => void
}

function StoryCode({ chapter }: { chapter: Chapter }) {
  const [selected, setSelected] = useState(0)
  const file = chapter.files[selected] ?? chapter.files[0]
  const { status, copy } = useClipboard(file.code)

  return (
    <div className="story-code">
      <div className="story-code-toolbar">
        <div className="story-file-options" aria-label={`${chapter.label} examples`}>
          {chapter.files.map((entry, index) => (
            <button
              key={entry.label}
              type="button"
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="story-copy" aria-label="Copy code" onClick={copy}>
          {status === "copied" ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      <div className="story-code-filename">{file.path}</div>
      <div
        key={file.label}
        className="story-code-content"
        tabIndex={0}
        role="region"
        aria-label={`${chapter.label} code example`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: repository-authored code highlighted at build time
        dangerouslySetInnerHTML={{ __html: file.html }}
      />
      <div className="story-code-footnote">
        <span>{file.language === "bash" ? "Shell" : "TypeScript"}</span>
        <span role="status">
          {status === "error"
            ? "Select code to copy manually."
            : status === "copied"
              ? "Copied"
              : ""}
        </span>
      </div>
    </div>
  )
}

function StoryChapter({ chapter, index }: { chapter: Chapter; index: number }) {
  return (
    <div className="story-chapter">
      <div className="story-copy-block">
        <p className="story-eyebrow">
          <span>{String(index + 1).padStart(2, "0")}</span> {chapter.label}
        </p>
        <h2>{chapter.title}</h2>
        <p className="story-description">{chapter.description}</p>
        <Link href={chapter.href} className="story-doc-link">
          {chapter.linkLabel} <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <StoryCode chapter={chapter} />
    </div>
  )
}

export function FrameworkStory({ ref }: { ref?: Ref<FrameworkStoryHandle> }) {
  const root = useRef<HTMLElement>(null)
  const sticky = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const [{ active, outgoing, direction }, setScene] = useState({
    active: 0,
    outgoing: null as number | null,
    direction: "forward",
  })
  const chapter = walkthrough[active] ?? walkthrough[0]

  useEffect(() => {
    const media = matchMedia(
      "(min-width: 1100px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)"
    )
    const updateMode = () => setPinned(media.matches)
    updateMode()
    media.addEventListener("change", updateMode)
    return () => media.removeEventListener("change", updateMode)
  }, [])

  useEffect(() => {
    if (!pinned) return
    let frame = 0
    const update = () => {
      frame = 0
      const element = root.current
      const stage = sticky.current
      if (!element || !stage) return
      const bounds = element.getBoundingClientRect()
      const distance = Math.max(1, bounds.height - stage.getBoundingClientRect().height)
      const offset = Number.parseFloat(getComputedStyle(stage).top) || 0
      const progress = Math.max(0, Math.min(1, (offset - bounds.top) / distance))
      const index = Math.min(walkthrough.length - 1, Math.floor(progress * walkthrough.length))
      setScene((current) =>
        index === current.active
          ? current
          : {
              active: index,
              outgoing: current.active,
              direction: index > current.active ? "forward" : "backward",
            }
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(frame)
    }
  }, [pinned])

  useEffect(() => {
    if (outgoing === null) return
    const finish = () => setScene((current) => ({ ...current, outgoing: null }))
    if (!pinned) {
      finish()
      return
    }
    const timer = setTimeout(finish, 300)
    return () => clearTimeout(timer)
  }, [outgoing, pinned])

  function goToIndex(index: number) {
    const element = root.current
    if (!element) return
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!pinned) {
      element.querySelector(`#story-${walkthrough[index]?.id}`)?.scrollIntoView({
        behavior: reduced ? "instant" : "smooth",
        block: "start",
      })
      return
    }
    const stage = sticky.current
    if (!stage) return
    const distance = Math.max(1, element.offsetHeight - stage.getBoundingClientRect().height)
    const offset = Number.parseFloat(getComputedStyle(stage).top) || 0
    const top = window.scrollY + element.getBoundingClientRect().top - offset
    window.scrollTo({
      top: top + ((index + 0.15) * distance) / walkthrough.length,
      behavior: "smooth",
    })
  }

  useImperativeHandle(ref, () => ({
    goTo(id) {
      const index = walkthrough.findIndex((entry) => entry.id === id)
      goToIndex(index < 0 ? 0 : index)
    },
  }))

  return (
    <>
      <section
        id="explore-the-code"
        ref={root}
        className="framework-story"
        data-pinned={pinned}
        style={{ "--story-count": walkthrough.length } as CSSProperties}
        aria-label="From data to working software"
      >
        <div ref={sticky} className="story-sticky">
          <div className="story-heading">
            <p>From data to working software.</p>
            <span>One framework. Every layer.</span>
          </div>
          {pinned ? (
            <>
              <nav className="story-chapters" aria-label="Walkthrough chapters">
                {walkthrough.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => goToIndex(index)}
                    aria-current={active === index ? "step" : undefined}
                    aria-label={`${index + 1}. ${entry.label}`}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {entry.label}
                  </button>
                ))}
              </nav>
              <div className="story-stage" data-direction={direction}>
                {outgoing !== null && walkthrough[outgoing] && (
                  <div className="story-scene story-departing" aria-hidden="true" inert>
                    <StoryChapter chapter={walkthrough[outgoing]} index={outgoing} />
                  </div>
                )}
                <div className="story-scene" key={chapter.id}>
                  <StoryChapter chapter={chapter} index={active} />
                </div>
              </div>
              <div className="story-controls">
                <span>
                  <ArrowDown size={14} aria-hidden="true" /> Scroll to explore
                </span>
                <div>
                  <span className="sr-only" role="status">
                    {chapter.label}, chapter {active + 1} of {walkthrough.length}
                  </span>
                  <span aria-hidden="true">
                    {String(active + 1).padStart(2, "0")} /{" "}
                    {String(walkthrough.length).padStart(2, "0")}
                  </span>
                  <button
                    type="button"
                    aria-label="Previous chapter"
                    disabled={active === 0}
                    onClick={() => goToIndex(active - 1)}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label="Next chapter"
                    disabled={active === walkthrough.length - 1}
                    onClick={() => goToIndex(active + 1)}
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="story-sequential">
              {walkthrough.map((entry, index) => (
                <div id={`story-${entry.id}`} key={entry.id} className="story-static-chapter">
                  <StoryChapter chapter={entry} index={index} />
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      <section className="story-finish" aria-labelledby="story-finish-title">
        <div>
          <p className="story-eyebrow">See it come together</p>
          <h2 id="story-finish-title">Real code. A complete application.</h2>
          <p>
            Explore Northline, a working service operations app built with Sixb. Follow the data
            from connected systems to human decisions and automated actions.
          </p>
        </div>
        <div className="story-finish-links">
          <a
            href="https://github.com/sixb-ai/sixb/tree/main/examples/northline"
            target="_blank"
            rel="noopener noreferrer"
            className="framework-start"
          >
            Open example on GitHub <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <Link href="/get-started" className="story-doc-link">
            Build your own <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </>
  )
}
