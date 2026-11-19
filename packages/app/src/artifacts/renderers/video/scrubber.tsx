import type { VideoOutline } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import { chapterAt, chapterName } from "./chapters"

// The playhead's track: the video's length cut into its chapters, what has played filled in, the
// comments marked at their instants, and the time and chapter under the pointer. Dragging shows
// each frame it passes; letting go lands there.

/** A comment's mark on the track. */
export interface TrackMark {
  readonly id: string
  readonly seconds: number
  readonly label: string
  readonly active: boolean
}

export function Scrubber({
  outline,
  time,
  duration,
  marks,
  onScrubStart,
  onScrub,
  onCommit,
  onMark,
}: {
  readonly outline: VideoOutline
  readonly time: number
  readonly duration: number
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

  return (
    <div className="group/track relative">
      {hover !== null ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-2.5 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-white shadow-lg ring-1 ring-white/10 backdrop-blur-md"
          style={{ left: `clamp(3rem, ${(hover / length) * 100}%, calc(100% - 3rem))` }}
        >
          <span className="tabular-nums">{formatClock(hover)}</span>
          {preview && outline.scenes.length > 1 ? (
            <span className="text-white/70"> · {chapterName(preview)}</span>
          ) : null}
        </div>
      ) : null}

      {marks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          aria-label={mark.label}
          title={mark.label}
          data-track-mark={mark.id}
          onClick={() => onMark(mark.id)}
          className={cn(
            "absolute bottom-full z-10 mb-0.5 size-2.5 -translate-x-1/2 rounded-full rounded-bl-[2px] ring-2 ring-black/40 outline-none transition-transform focus-visible:ring-white motion-safe:hover:scale-125",
            // As the pins on the video: white, the open one in the selection blue.
            mark.active ? "bg-[#0a84ff]" : "bg-white"
          )}
          style={{ left: `${(Math.min(mark.seconds, length) / length) * 100}%` }}
        />
      ))}

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
            "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.4)] transition-transform duration-150 motion-reduce:transition-none",
            dragging
              ? "scale-110"
              : "scale-0 group-focus-within/track:scale-100 group-hover/track:scale-100 [@media(pointer:coarse)]:scale-100"
          )}
          style={{ left: `${(shown / length) * 100}%` }}
        />
      </div>
    </div>
  )
}
