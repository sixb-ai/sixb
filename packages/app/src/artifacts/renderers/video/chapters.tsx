import type { VideoOutline, VideoOutlineScene } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useRef } from "react"
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
  current,
  onSeek,
  onClose,
  inline = false,
}: {
  readonly outline: VideoOutline
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
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors",
                    playing
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground group-hover:text-foreground"
                  )}
                >
                  {index + 1}
                </span>
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
