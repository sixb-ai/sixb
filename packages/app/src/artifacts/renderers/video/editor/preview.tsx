import { type FrameEvent, type VideoOutline, videoPosterMs } from "@sixb/core/artifacts"
import { Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { CloudOff, Play, RotateCcw } from "lucide-react"
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { ArtifactFrame, type ArtifactFrameHandle } from "../../../frame"
import { useArtifactMessages } from "../../../messages"
import type { ArtifactVersion } from "../../../queries"
import { type Playback, usePlayback } from "../playback"
import { useSize } from "../player"

// The editor's picture: the video as its latest save holds it, played by HyperFrames' runtime in
// its frame, as the player plays it. Each save is a new revision, which a second frame loads
// behind the first, where the reader left the playhead: once it has drawn that instant, it takes
// the first one's place, so the picture never goes blank. Until a change is saved, the timeline
// is ahead of the picture, and the picture says it is catching up.

/** How long a new frame that went to the playhead has to draw it before it shows. */
const SETTLE_MS = 150

/** How long it is waited for at most, when its fonts and pictures never say they loaded. */
const SETTLE_MAX_MS = 1_500

/**
 * How tall the picture is at most on a phone, where the chapters to edit follow it: under half the
 * screen, so a tall video leaves them in sight. A wide one is shorter than this anyway.
 */
export const COMPACT_PREVIEW_MAX_HEIGHT = "45svh"

/**
 * Plays the version in a frame the caller places with {@link PreviewScreen}: the playback is the
 * editor's, which its timeline and keys drive. It opens at `start`, in seconds, when the address
 * names an instant; at the video's poster otherwise.
 */
export function usePreview(version: ArtifactVersion, outline: VideoOutline, start = 0) {
  const frame = useRef<ArtifactFrameHandle | null>(null)
  const window_ = useRef(() => frame.current?.window() ?? null).current
  const playback = usePlayback({
    frame: window_,
    key: String(version.revision),
    fps: outline.fps,
    duration: outline.durationMs / 1000,
  })

  // A frame loaded again, for a new save, shows where the reader was, paused.
  const resumeAt = useRef(start)
  const reloading = useRef(false)
  // Where the reader is, until a new frame loads: its first reports are its own start, not theirs.
  if (playback.phase !== "ready") reloading.current = true
  else if (!reloading.current) resumeAt.current = playback.time
  const resumed = useRef<number | null>(null)
  useEffect(() => {
    if (playback.phase !== "ready" || resumed.current === version.revision) return
    // Until the new frame has loaded, "ready" is the last frame's.
    if (!reloading.current) return
    reloading.current = false
    const first = resumed.current === null
    resumed.current = version.revision
    // The first load shows the video's poster, as the player opens on it, unless the playhead is
    // somewhere already: the picture then shows the instant it says.
    if (first && resumeAt.current === 0) playback.cue(videoPosterMs(outline) / 1000)
    else playback.seek(Math.min(resumeAt.current, playback.duration))
  }, [playback.phase, playback.seek, playback.cue, playback.duration, version.revision, outline])

  // While a frame loads, the playhead stays where the reader is: the frame's first reports are its
  // own start, and a seek it was not listening for yet is made once it is.
  const seek = useCallback(
    (seconds: number, mode?: Parameters<typeof playback.seek>[1]) => {
      if (reloading.current) resumeAt.current = Math.max(0, seconds)
      playback.seek(seconds, mode)
    },
    [playback.seek]
  )
  const shownPlayback: Playback = {
    ...playback,
    seek,
    ...(reloading.current ? { time: resumeAt.current } : {}),
  }

  // The version the reader sees: the last one shown, until the new one has drawn the playhead.
  const [shown, setShown] = useState(version)
  useEffect(() => {
    if (shown.revision === version.revision) return
    if (playback.phase === "failed") {
      setShown(version)
      return
    }
    if (playback.phase !== "ready" || resumed.current !== version.revision) return
    const timer = setTimeout(() => setShown(version), playback.loaded ? SETTLE_MS : SETTLE_MAX_MS)
    return () => clearTimeout(timer)
  }, [shown.revision, version, playback.phase, playback.loaded])

  /** The version still on screen while a newer one loads behind it, if one does. */
  const cover = shown.revision === version.revision ? null : shown
  return { frame, playback: shownPlayback, cover }
}

export function PreviewScreen({
  version,
  outline,
  frame,
  cover,
  playback,
  updating,
  offline = false,
  compact = false,
  onPick,
  onFrameEvent,
  children,
}: {
  readonly version: ArtifactVersion
  readonly outline: VideoOutline
  readonly frame: RefObject<ArtifactFrameHandle | null>
  /** The version still shown over the one loading behind it, as {@link usePreview} says. */
  readonly cover: ArtifactVersion | null
  readonly playback: Playback
  /** The timeline holds changes the picture does not show yet. */
  readonly updating: boolean
  /** The connection is lost: the picture shows the last save until the reader reconnects. */
  readonly offline?: boolean
  readonly compact?: boolean
  /**
   * A click on the paused picture, at a point in fractions of it: the editor looks for words
   * there to type over. Without it, or while it plays, a click plays or pauses.
   */
  readonly onPick?: (point: { readonly x: number; readonly y: number }) => void
  readonly onFrameEvent?: (event: FrameEvent) => void
  /** What lies over the picture: a title being typed into. */
  readonly children?: ReactNode
}) {
  const messages = useArtifactMessages()
  const box = useRef<HTMLDivElement | null>(null)
  const size = useSize(box)
  const scale = Math.min(size.width / outline.width, size.height / outline.height) || 0
  const shown = { width: outline.width * scale, height: outline.height * scale }
  const offset = { left: (size.width - shown.width) / 2, top: (size.height - shown.height) / 2 }

  const [failed, setFailed] = useState<number | null>(null)
  const loading = playback.phase !== "ready" && failed !== version.revision
  // Over the last picture, a new one loads unseen.
  const showLoading = useDelayed(loading && !cover, 400)
  const shownCover = failed === version.revision ? null : cover

  return (
    <div
      ref={box}
      data-video-preview=""
      className={cn(
        "relative isolate min-h-0 overflow-hidden",
        // On a phone, a picture held under its height lies on the app's ground, not in black bars.
        compact ? "aspect-video w-full shrink-0 bg-muted/60" : "size-full rounded-xl bg-neutral-950"
      )}
      style={
        compact
          ? {
              aspectRatio: String(outline.width / outline.height),
              maxHeight: COMPACT_PREVIEW_MAX_HEIGHT,
            }
          : undefined
      }
    >
      <div
        className="absolute bg-neutral-950"
        style={{
          width: outline.width,
          height: outline.height,
          left: offset.left,
          top: offset.top,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          visibility: scale > 0 ? undefined : "hidden",
        }}
      >
        {/*
          The new version's frame loads after the one still shown, which stays where it is: a frame
          moved in the page loads again. The one shown lies over it until it takes its place.
        */}
        {[...(shownCover ? [shownCover] : []), version].map((each) =>
          each.revision === version.revision ? (
            <ArtifactFrame
              key={each.revision}
              version={each}
              title={each.title}
              handle={frame}
              sound
              className="absolute inset-0 size-full"
              onEvent={(event) => {
                if (event.event === "failed") setFailed(each.revision)
                onFrameEvent?.(event)
              }}
              onFailure={() => setFailed(each.revision)}
            />
          ) : (
            <ArtifactFrame
              key={each.revision}
              version={each}
              title={each.title}
              sound
              className="absolute inset-0 z-[1] size-full"
            />
          )
        )}
      </div>

      {/* The app's layer: the picture takes no click of its own. */}
      <div
        className="absolute"
        style={{ ...shown, ...offset }}
        onPointerUp={(event) => {
          if (
            event.button !== 0 ||
            event.defaultPrevented ||
            event.target !== event.currentTarget
          ) {
            return
          }
          if (onPick && !playback.playing) {
            const area = event.currentTarget.getBoundingClientRect()
            onPick({
              x: (event.clientX - area.left) / area.width,
              y: (event.clientY - area.top) / area.height,
            })
            return
          }
          playback.toggle()
        }}
      >
        {children}
      </div>

      {showLoading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-6 text-white/70" />
        </div>
      ) : null}

      {failed === version.revision ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950 px-6 text-center"
        >
          <p className="m-0 text-sm font-medium text-white">{messages.video.failed}</p>
          <p className="m-0 max-w-xs text-[13px] text-white/60">{messages.video.failedDetail}</p>
        </div>
      ) : null}

      {!loading && !playback.playing && playback.ended ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="grid size-12 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-md">
            <RotateCcw className="size-5" aria-hidden="true" />
          </span>
        </div>
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none absolute top-3 left-3 z-10 m-0 flex h-7 items-center gap-1.5 rounded-full bg-black/60 px-2.5 text-xs font-medium text-white/90 ring-1 ring-white/15 backdrop-blur-md transition-opacity duration-300 motion-reduce:transition-none",
          updating || cover ? "opacity-100" : "opacity-0"
        )}
      >
        {offline && updating ? (
          <>
            <CloudOff className="size-3.5 text-white/80" aria-hidden="true" />
            {messages.videoEditor.offlinePicture}
          </>
        ) : updating || cover ? (
          <>
            <Spinner className="size-3 text-white/80" />
            {messages.videoEditor.updating}
          </>
        ) : null}
      </p>
    </div>
  )
}

/** The large play mark a paused preview shows on a phone, where there is no keyboard. */
export function PlayMark({ onPlay }: { readonly onPlay: () => void }) {
  const messages = useArtifactMessages().video
  return (
    <button
      type="button"
      aria-label={messages.play}
      onPointerUp={(event) => {
        event.preventDefault()
        onPlay()
      }}
      className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-md outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      <Play className="ml-0.5 size-6 fill-current" aria-hidden="true" />
    </button>
  )
}

/** `value`, once it has held for `ms`; false at once. */
function useDelayed(value: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!value) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return shown
}
