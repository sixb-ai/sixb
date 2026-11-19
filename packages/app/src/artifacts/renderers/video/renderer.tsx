import { resolveArtifactAddress, type VideoOutline } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { Clapperboard } from "lucide-react"
import { useEffect, useRef } from "react"
import { useArtifactMessages } from "../../messages"
import { formatClock, MEDIA_FRAME } from "../../playback"
import type { ArtifactVersion } from "../../queries"

// A video, before it plays: its screen at the video's shape, and its scenes as chapters with their
// times. Opened at a scene or an instant, that scene is the one marked.

/** The most a screen takes of the window's height, so a portrait video leaves its scenes in view. */
const SCREEN_HEIGHT = "60vh"

export function VideoRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const current = useRef<HTMLLIElement | null>(null)
  const { outline } = version

  const marked = outline.kind === "video" ? markedScene(version, outline, part) : undefined
  useEffect(() => {
    if (marked) current.current?.scrollIntoView?.({ block: "nearest" })
  }, [marked])

  if (outline.kind !== "video") return null
  const ratio = outline.width / outline.height

  return (
    <div
      data-sixb-artifact=""
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-6 sm:px-8 sm:py-10">
        <div
          role="img"
          aria-label={messages.video.screen(version.title)}
          className={cn(
            "relative mx-auto flex flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-neutral-950 px-6 text-center",
            MEDIA_FRAME
          )}
          style={{ aspectRatio: `${ratio}`, width: `min(100%, calc(${SCREEN_HEIGHT} * ${ratio}))` }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(255_255_255/0.07),transparent_65%)]"
          />
          <Clapperboard className="size-7 stroke-[1.5] text-white/55" aria-hidden="true" />
          <p className="text-sm font-medium text-white/90">{messages.video.soon}</p>
          <p className="max-w-xs text-[13px] text-balance text-white/55">
            {messages.video.soonDetail}
          </p>

          <span className="absolute top-3 right-3 rounded-md bg-white/10 px-1.5 py-0.5 text-[11.5px] font-medium text-white/80 tabular-nums">
            {formatClock(outline.durationMs / 1000)}
          </span>
          <VideoScenesBar
            outline={outline}
            marked={marked}
            className="absolute inset-x-3 bottom-3"
          />
        </div>

        <section aria-label={messages.video.scenes} className="flex flex-col gap-2.5">
          <h2 className="flex items-baseline gap-1.5 text-sm font-medium text-foreground">
            {messages.video.scenes}
            <span className="text-muted-foreground tabular-nums">{outline.scenes.length}</span>
          </h2>
          <ol className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-card">
            {outline.scenes.map((scene, index) => {
              const isMarked = scene.id === marked
              return (
                <li
                  key={scene.id}
                  ref={isMarked ? current : undefined}
                  aria-current={isMarked ? "true" : undefined}
                  className={cn(
                    "flex items-center gap-3 px-3.5 py-2.5 text-sm",
                    isMarked && "bg-muted/70"
                  )}
                >
                  <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span className="w-11 shrink-0 text-xs font-medium text-foreground/80 tabular-nums">
                    {formatClock(scene.startMs / 1000)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground" title={scene.id}>
                    {scene.label ?? scene.id}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {messages.video.seconds(scene.durationMs / 1000)}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      </div>
    </div>
  )
}

/**
 * A video's scenes as one bar along its length, each as long as it plays, the marked one brighter.
 * Drawn on the video's dark screen.
 */
export function VideoScenesBar({
  outline,
  marked,
  className,
}: {
  readonly outline: VideoOutline
  readonly marked?: string
  readonly className?: string
}) {
  const length = outline.durationMs || 1
  return (
    <span aria-hidden="true" className={cn("block h-1", className)}>
      <span className="relative block size-full">
        {outline.scenes.map((scene) => (
          <span
            key={scene.id}
            className={cn(
              "absolute inset-y-0 rounded-full border-x border-neutral-950",
              scene.id === marked ? "bg-white/80" : "bg-white/25"
            )}
            style={{
              left: `${(scene.startMs / length) * 100}%`,
              width: `${(scene.durationMs / length) * 100}%`,
            }}
          />
        ))}
      </span>
    </span>
  )
}

/**
 * The scene an address's part marks: the scene it names, or the one playing at its instant; of
 * two that overlap there, the one that started last.
 */
function markedScene(
  version: ArtifactVersion,
  outline: VideoOutline,
  part: string | undefined
): string | undefined {
  if (part === undefined) return undefined

  const resolved = resolveArtifactAddress(
    { artifactId: version.artifactId, part },
    { kind: "video", outline, files: version.files }
  )
  if (!("part" in resolved)) return undefined

  const found = resolved.part
  if (found.type === "scene") return found.id
  if (found.type !== "time") return undefined

  return outline.scenes
    .filter((scene) => scene.startMs <= found.ms && found.ms < scene.startMs + scene.durationMs)
    .at(-1)?.id
}
