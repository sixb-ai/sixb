import type { VideoOutline, VideoOutlineScene } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useRef, useState } from "react"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import { SidePanel } from "../../side-panel"

// A video's chapters are its scenes, in the order they start. The chapter at an instant is the
// scene that started last by then: where one fades into the next, the next one has begun.

/** The scene playing at `seconds`; of two on screen at once, the one that started last. */
export function chapterAt(outline: VideoOutline, seconds: number): VideoOutlineScene | undefined {
  const ms = seconds * 1000
  return outline.scenes.filter((scene) => scene.startMs <= ms).at(-1) ?? outline.scenes[0]
}

/**
 * Where going to a scene lands, in seconds: its first frame. A scene may start between two frames,
 * and the runtime shows the frame at or before the instant it is sent to, which is still the
 * scene before: its first frame is the next one.
 */
export function chapterStart(scene: Pick<VideoOutlineScene, "startMs">, fps: number): number {
  return Math.ceil((scene.startMs * fps) / 1000) / fps
}

/** A scene as the reader reads it: its label, else its id. */
export function chapterName(scene: VideoOutlineScene): string {
  return scene.label ?? scene.id
}

/**
 * The chapters beside the stage, or in a sheet on a phone: each with its number, its start and
 * its name, the one playing marked. A click goes to its start.
 */
export function ChaptersPanel({
  outline,
  still,
  current,
  onSeek,
  onClose,
  inline = false,
}: {
  readonly outline: VideoOutline
  /** Where a scene's still is, a picture of its middle, which shows once snapshotted. */
  readonly still?: (scene: VideoOutlineScene) => string
  /** The scene playing, by its id. */
  readonly current: string | undefined
  readonly onSeek: (scene: VideoOutlineScene) => void
  readonly onClose: () => void
  /** Under a phone's video, filling the room left. */
  readonly inline?: boolean
}) {
  const messages = useArtifactMessages().video
  const marked = useRef<HTMLButtonElement | null>(null)

  // The chapter playing stays in view as the video moves on.
  useEffect(() => {
    if (current) marked.current?.scrollIntoView?.({ block: "nearest" })
  }, [current])

  return (
    <SidePanel
      label={messages.chapters}
      title={messages.chapters}
      count={outline.scenes.length}
      closeLabel={messages.closeChapters}
      onClose={onClose}
      inline={inline}
      data-video-panel=""
    >
      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto overscroll-contain p-2 pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {outline.scenes.map((scene, index) => {
          const playing = scene.id === current
          return (
            <li key={scene.id}>
              <button
                ref={playing ? marked : undefined}
                type="button"
                aria-current={playing ? "true" : undefined}
                onClick={() => onSeek(scene)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  // As the app's lists mark where the reader is: a quiet fill, no edge.
                  playing ? "bg-muted" : "hover:bg-muted/60"
                )}
              >
                <ChapterMark number={index + 1} playing={playing} still={still?.(scene)} />
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-sm font-medium text-foreground"
                    title={scene.id}
                  >
                    {chapterName(scene)}
                  </span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {messages.chapterTimes(
                      formatClock(scene.startMs / 1000),
                      messages.seconds(scene.durationMs / 1000)
                    )}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </SidePanel>
  )
}

/**
 * A chapter's number, on its still once it has loaded: a picture of the scene's middle, at the
 * video's shape, the number in its corner. Until then, or without one, the number alone, so a
 * still not snapshotted yet moves nothing.
 */
function ChapterMark({
  number,
  playing,
  still,
}: {
  readonly number: number
  readonly playing: boolean
  readonly still: string | undefined
}) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const badge = cn(
    "flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums transition-colors",
    playing
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-muted-foreground group-hover:text-foreground"
  )

  if (!still || loaded !== still) {
    return (
      <span aria-hidden="true" className={cn(badge, "size-6 text-[11px]")}>
        {number}
        {still ? (
          // Loaded out of sight, eagerly, as a hidden lazy image never loads: it takes the
          // badge's place once it has.
          <img src={still} alt="" onLoad={() => setLoaded(still)} className="hidden" />
        ) : null}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative aspect-video w-[4.5rem] shrink-0 overflow-hidden rounded-md bg-neutral-900 ring-1 ring-black/5 dark:ring-white/10",
        playing && "ring-2 ring-primary dark:ring-primary"
      )}
    >
      <img src={still} alt="" className="sixb-media-in size-full object-cover" />
      <span
        className={cn(badge, "absolute bottom-1 left-1 h-4 min-w-4 px-1 text-[10px] shadow-sm")}
      >
        {number}
      </span>
    </span>
  )
}
