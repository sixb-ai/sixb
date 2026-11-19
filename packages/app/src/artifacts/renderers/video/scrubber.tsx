import type { VideoOutline } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import { chapterAt, chapterName } from "./chapters"

// The playhead's track: the video's length cut into its chapters, what has played filled in, the
// comments marked at their instants, and the time and chapter under the pointer. Dragging shows
// each frame it passes; letting go lands there. The playhead is the one knob on it; a comment is a
// small dot, never as large.

/** A comment's mark on the track. */
export interface TrackMark {
  readonly id: string
  readonly seconds: number
  readonly label: string
  /** The comment's first words, shown with its time while the pointer or the focus is on it. */
  readonly excerpt: string
  readonly active: boolean
}

export function Scrubber({
  outline,
  time,
  duration,
  playing,
  marks,
  onScrubStart,
  onScrub,
  onCommit,
  onMark,
}: {
  readonly outline: VideoOutline
  readonly time: number
  readonly duration: number
  /** While it plays, the playhead's knob shows only under the pointer or the focus. */
  readonly playing: boolean
  readonly marks: readonly TrackMark[]
  readonly onScrubStart: () => void
  readonly onScrub: (seconds: number) => void
  readonly onCommit: (seconds: number) => void
  readonly onMark: (id: string) => void
}) {
  const messages = useArtifactMessages().video
  const track = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pointed, setPointed] = useState<string | null>(null)
  const length = duration > 0 ? duration : 1

  const secondsAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    return Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * length
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
    onScrubStart()
    onScrub(secondsAt(event.clientX))
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const seconds = secondsAt(event.clientX)
    if (event.pointerType === "mouse" || dragging) setHover(seconds)
    if (dragging) onScrub(seconds)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    if (event.pointerType !== "mouse") setHover(null)
    onCommit(secondsAt(event.clientX))
  }

  // Each chapter's share of the track, from its start to the next one's.
  const starts = [...new Set(outline.scenes.map((scene) => scene.startMs / 1000))]
    .filter((start) => start < length)
    .sort((a, b) => a - b)
  if (starts[0] !== 0) starts.unshift(0)
  const segments = starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? length,
  }))

  const shown = Math.min(time, length)
  const chapter = chapterAt(outline, shown)
  const preview = hover === null ? null : chapterAt(outline, hover)
  const mark = marks.find((each) => each.id === pointed)

  // Over a comment's dot, its time and first words; elsewhere, the time and chapter there.
  const bubble = mark
    ? { at: mark.seconds, text: `“${mark.excerpt}”` }
    : hover !== null
      ? {
          at: hover,
          text: preview && outline.scenes.length > 1 ? chapterName(preview) : undefined,
        }
      : null

  return (
    <div className="group/track relative">
      {bubble ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-2.5 flex max-w-64 rounded-md bg-black/80 px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-white shadow-lg ring-1 ring-white/10 backdrop-blur-md"
          style={bubblePlace(bubble.at / length)}
        >
          <span className="shrink-0 tabular-nums">{formatClock(bubble.at)}</span>
          {bubble.text ? (
            <span className="min-w-0 truncate text-white/70">&nbsp;· {bubble.text}</span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={messages.position}
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={messages.positionText(
          formatClock(shown),
          formatClock(length),
          chapter && outline.scenes.length > 1 ? chapterName(chapter) : undefined
        )}
        data-video-scrubber=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (!dragging) setHover(null)
        }}
        className="relative flex h-5 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <div className="flex h-1 w-full gap-[3px] transition-[height] duration-150 group-hover/track:h-1.5 motion-reduce:transition-none">
          {segments.map((segment) => {
            const span = segment.end - segment.start
            const played = Math.min(Math.max((shown - segment.start) / span, 0), 1)
            return (
              <div
                key={segment.start}
                className="relative h-full overflow-hidden rounded-full bg-white/25"
                style={{ flexGrow: span, flexBasis: 0 }}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-white"
                  style={{ width: `${played * 100}%` }}
                />
              </div>
            )
          })}
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 z-20 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.4)] transition-transform duration-150 motion-reduce:transition-none",
            dragging
              ? "scale-110"
              : playing
                ? "scale-0 group-focus-within/track:scale-100 group-hover/track:scale-100 [@media(pointer:coarse)]:scale-100"
                : "scale-100"
          )}
          style={{ left: `${(shown / length) * 100}%` }}
        />
      </div>

      {/*
       * On the track, never over the picture, and under the playhead's knob. A finger scrubs
       * through them, as their dots are too small to aim at: on a phone, the comments' panel opens
       * each.
       */}
      {marks.map((each) => (
        <button
          key={each.id}
          type="button"
          aria-label={each.label}
          data-track-mark={each.id}
          onClick={() => onMark(each.id)}
          onPointerEnter={() => setPointed(each.id)}
          onPointerLeave={() => setPointed(null)}
          onFocus={() => setPointed(each.id)}
          onBlur={() => setPointed(null)}
          className="group/mark absolute top-1/2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none [@media(pointer:coarse)]:pointer-events-none"
          style={{ left: `${(Math.min(each.seconds, length) / length) * 100}%` }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full ring-1 ring-black/40 transition-transform group-hover/mark:scale-150 group-focus-visible/mark:scale-150 group-focus-visible/mark:ring-white motion-reduce:transition-none",
              // As the pins on the video: the open one in the selection blue, the others quieter.
              each.active ? "bg-[#0a84ff]" : "bg-white/75"
            )}
          />
        </button>
      ))}
    </div>
  )
}

/**
 * Where the bubble over the track goes for an instant `at` of the way along it: centred over it,
 * or held to the track's end near either, so it never leaves the player.
 */
function bubblePlace(at: number): CSSProperties {
  const along = Math.min(Math.max(at, 0), 1)
  if (along < 0.15) return { left: 0 }
  if (along > 0.85) return { right: 0 }
  return { left: `${along * 100}%`, transform: "translateX(-50%)" }
}
