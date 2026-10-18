import type { DeckMode, FrameEmbed, FrameEvent } from "@sixb/core/internal/artifacts/frame-protocol"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronLeft, ChevronRight, Fullscreen, LayoutGrid, type LucideIcon, X } from "lucide-react"
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ArtifactFrame, type ArtifactFrameHandle } from "../../frame"
import { type ArtifactMessages, useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { ArtifactEmbed, useOpenArtifactAddress } from "../../references/references"
import { useArtifactThemeAttributes } from "../../theme"
import { ViewerNotice } from "../notice"
import { type DeckAction, deckKeyAction, slideFromPart } from "./navigation"

/**
 * A deck: the current slide on a stage, a filmstrip of every slide under it, and previous and
 * next, overview, and present, where the slide fills the page until Escape. Arrow keys move
 * through it whether focus is in the frame or on the viewer. `part` opens it at a slide (`4`).
 *
 * The deck runs its own scripts in its frame, so its slides and the links it may open are the
 * ones its version recorded at publish, whatever the frame says.
 */
export function SlidesRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages().slides
  const theme = useArtifactThemeAttributes(version)
  const openAddress = useOpenArtifactAddress()
  const frame = useRef<ArtifactFrameHandle | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const titles = version.outline.kind === "slides" ? version.outline.slides : []
  const total = titles.length
  const [slide, setSlide] = useState(() => slideFromPart(part, total))
  // The frame opens at the first slide shown; later moves go to it as requests.
  const [start] = useState(() => ({ slide }))
  const [mode, setMode] = useState<DeckMode>("slide")
  // How many times the frame has said it is ready. Each load opens at `start`, on a slide, so the
  // deck's place goes to it again: a deck can load itself again.
  const [loads, setLoads] = useState(0)
  const [embeds, setEmbeds] = useState<readonly FrameEmbed[]>([])
  const linked = useMemo(
    () => new Set(version.references.map((reference) => reference.address)),
    [version]
  )

  const apply = useCallback((action: DeckAction) => {
    if (action.type === "goto") setSlide(action.slide)
    else setMode(action.mode)
  }, [])

  // The frame follows the deck's state once it is ready.
  useEffect(() => {
    if (loads > 0) frame.current?.send("goto", { slide }).catch(() => {})
  }, [loads, slide])
  useEffect(() => {
    if (loads > 0) frame.current?.send("mode", { mode }).catch(() => {})
  }, [loads, mode])

  // Presenting lifts the stage into the page's top layer, above everything else on it, without
  // moving it in the document: a frame that moves loads again. A popover is not modal, so the
  // rest of the page is inert until the presentation ends.
  const presenting = mode === "present"
  useLayoutEffect(() => {
    const element = stage.current
    if (!presenting || !element) return
    element.setAttribute("popover", "manual")
    element.showPopover?.()
    const restore = inertAround(element)
    element.focus()
    return () => {
      restore()
      element.hidePopover?.()
      element.removeAttribute("popover")
    }
  }, [presenting])

  const onEvent = useCallback(
    (event: FrameEvent) => {
      switch (event.event) {
        case "ready":
          setLoads((count) => count + 1)
          return
        case "select":
          setSlide(Math.min(event.params.slide, Math.max(1, total)))
          setMode("slide")
          return
        case "key": {
          const action = deckKeyAction(event.params.key, { slide, total, mode })
          if (action) apply(action)
          return
        }
        case "open":
          // Only to what the deck links to as published, so a script in it cannot pick where.
          if (linked.has(event.params.address)) openAddress(event.params.address)
          return
        case "embeds":
          setEmbeds(event.params.embeds)
          return
      }
    },
    [slide, total, mode, apply, openAddress, linked]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // A button keeps its own keys; Escape still leaves the overview from the button that opened it.
    if (event.key !== "Escape" && (event.target as HTMLElement).closest("button")) return
    const action = deckKeyAction(event.key, { slide, total, mode })
    if (!action) return
    event.preventDefault()
    apply(action)
  }

  return (
    <div
      data-sixb-artifact=""
      // A dialog the deck is in leaves Escape to the deck while it is off its slide.
      data-deck-mode={mode}
      // The deck takes arrow keys from here as well as from inside the frame.
      role="group"
      aria-label={messages.deck(version.title)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-background text-foreground outline-none",
        theme.className
      )}
      style={theme.style}
    >
      <div
        ref={stage}
        tabIndex={-1}
        className={cn(
          "flex min-h-0 flex-1 bg-muted outline-none",
          presenting &&
            "fixed inset-0 z-50 m-0 size-full max-h-none max-w-none border-0 bg-black p-0"
        )}
      >
        <ArtifactFrame
          handle={frame}
          version={version}
          title={messages.deck(version.title)}
          start={start}
          onEvent={onEvent}
          className="flex-1"
          fallback={presenting ? null : <SlidePlaceholder />}
          failure={<ViewerNotice title={messages.loadFailed} />}
          overlay={<DeckEmbeds version={version} embeds={embeds} />}
        />
        {presenting ? (
          <button
            type="button"
            aria-label={messages.exitPresent}
            title={messages.exitPresent}
            onClick={() => setMode("slide")}
            className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-black/45 text-white/80 outline-none transition-colors hover:bg-black/65 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 [&_svg]:size-[18px]"
          >
            <X aria-hidden="true" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {total > 0 ? (
        <Filmstrip
          version={version}
          titles={titles}
          current={slide}
          messages={messages}
          onPick={setSlide}
          load={loads > 0}
          hidden={mode !== "slide"}
        />
      ) : null}
      <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
        <span className="flex items-center gap-1">
          <DeckButton
            icon={ChevronLeft}
            label={messages.previous}
            disabled={slide <= 1}
            onClick={() => apply({ type: "goto", slide: slide - 1 })}
          />
          <DeckButton
            icon={ChevronRight}
            label={messages.next}
            disabled={slide >= total}
            onClick={() => apply({ type: "goto", slide: slide + 1 })}
          />
          <span className="px-2 text-[13px] text-muted-foreground tabular-nums">
            <span className="sr-only">{messages.position(slide, Math.max(total, 1))}</span>
            <span aria-hidden="true">
              <strong className="font-semibold text-foreground">{slide}</strong> /{" "}
              {Math.max(total, 1)}
            </span>
          </span>
        </span>
        <span className="flex items-center gap-1">
          <DeckButton
            icon={LayoutGrid}
            label={messages.overview}
            showLabel
            pressed={mode === "overview"}
            onClick={() => setMode(mode === "overview" ? "slide" : "overview")}
          />
          <DeckButton
            icon={Fullscreen}
            label={messages.present}
            showLabel
            onClick={() => setMode("present")}
          />
        </span>
      </div>
    </div>
  )
}

/**
 * Makes the rest of the page inert, all but the element and the ancestors it sits in, and returns
 * what undoes it. What was inert already stays so.
 */
function inertAround(element: HTMLElement): () => void {
  const made: HTMLElement[] = []
  for (let node = element; node !== document.body; ) {
    const parent = node.parentElement
    if (!parent) break
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue
      sibling.inert = true
      made.push(sibling)
    }
    node = parent
  }
  return () => {
    for (const each of made) each.inert = false
  }
}

/**
 * Every slide in a row, the current one marked and kept in view. Outside slide mode it is hidden,
 * not gone, so its frames do not load again when the reader comes back.
 */
function Filmstrip({
  version,
  titles,
  current,
  messages,
  onPick,
  load,
  hidden,
}: {
  readonly version: ArtifactVersion
  readonly titles: readonly { readonly title?: string }[]
  readonly current: number
  readonly messages: ArtifactMessages["slides"]
  readonly onPick: (slide: number) => void
  /** Whether the thumbnails may load: they wait for the slide on the stage, which comes first. */
  readonly load: boolean
  readonly hidden: boolean
}) {
  const strip = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (hidden) return
    strip.current
      ?.querySelector(`[data-slide="${current}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [current, hidden])
  return (
    <div
      ref={strip}
      hidden={hidden}
      className="shrink-0 overflow-x-auto border-t border-border/70 px-4 py-3.5"
    >
      <div className="mx-auto flex w-max gap-3.5">
        {titles.map((entry, index) => {
          const slide = index + 1
          const label = messages.slide(slide, entry.title)
          return (
            <button
              key={slide}
              type="button"
              data-slide={slide}
              aria-label={label}
              aria-current={slide === current ? "true" : undefined}
              onClick={() => onPick(slide)}
              className="group flex flex-col items-center gap-[7px] outline-none"
            >
              <span
                className={cn(
                  "relative block h-[63px] w-28 overflow-hidden rounded-md border bg-background transition-colors sm:h-[90px] sm:w-40",
                  slide === current
                    ? "border-foreground outline outline-2 outline-offset-2 outline-foreground"
                    : "border-border group-hover:border-foreground/30",
                  "group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2"
                )}
              >
                {/* The slide alone, filling a frame of its own that loads as the strip nears it. */}
                {load ? (
                  <ArtifactFrame
                    version={version}
                    title={label}
                    start={{ slide, fill: true }}
                    decorative
                    className="absolute inset-0"
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  "text-[11px] tabular-nums",
                  slide === current ? "font-semibold text-foreground" : "text-muted-foreground"
                )}
              >
                {slide}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The app's text, 13px, reads at about 20px on a slide drawn at 1.5 times the slide's scale. */
const EMBED_ZOOM = 1.5

/**
 * What the shown slide embeds from other artifacts, drawn where the deck put each box: laid out
 * at the box's size in slide pixels over 1.5, then scaled with the slide. Only what the version
 * records as an embed is drawn, so a deck shows nothing it did not publish with.
 */
function DeckEmbeds({
  version,
  embeds,
}: {
  readonly version: ArtifactVersion
  readonly embeds: readonly FrameEmbed[]
}) {
  const recorded = useMemo(
    () =>
      new Set(
        version.references
          .filter((reference) => reference.as === "embed")
          .map((reference) => reference.address)
      ),
    [version]
  )
  return embeds
    .filter((embed) => recorded.has(embed.address))
    .map((embed, index) => {
      const zoom = embed.scale * EMBED_ZOOM
      return (
        <div
          // A slide may embed one address twice.
          key={`${index}:${embed.address}`}
          data-sixb-deck-embed={embed.address}
          className="pointer-events-auto absolute"
          style={{
            left: embed.rect.x,
            top: embed.rect.y,
            width: embed.rect.width,
            height: embed.rect.height,
          }}
        >
          <div
            style={{
              width: embed.rect.width / zoom,
              height: embed.rect.height / zoom,
              transform: `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <ArtifactEmbed address={embed.address} caption="" fill />
          </div>
        </div>
      )
    })
}

/**
 * Where the slide will be while the frame loads: the frame centers a 16:9 slide with a margin of
 * up to 32px, and this draws the same box, so the slide fades in exactly over it.
 */
function SlidePlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 grid place-items-center [container-type:size]"
    >
      <div
        className="aspect-video rounded-[10px] bg-background ring-1 ring-border"
        style={{
          width: "min(100cqw - 2 * min(32px, 4cqw), (100cqh - 2 * min(32px, 4cqw)) * 16 / 9)",
        }}
      />
    </div>
  )
}

function DeckButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  pressed,
  showLabel = false,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly pressed?: boolean
  /** Shown beside the icon where there is room; the icon alone on a phone. */
  readonly showLabel?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={showLabel ? undefined : label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onClick={onClick}
      className={cn(
        "flex h-[34px] items-center justify-center gap-[7px] rounded-lg text-[13px] text-foreground/75 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground",
        showLabel ? "w-[34px] sm:w-auto sm:px-3" : "w-[34px]",
        showLabel ? "[&_svg]:size-4" : "[&_svg]:size-[18px]"
      )}
    >
      <Icon aria-hidden="true" strokeWidth={1.75} />
      {showLabel ? <span className="hidden sm:inline">{label}</span> : null}
    </button>
  )
}
