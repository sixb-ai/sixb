import { resolveArtifactAddress, type VideoOutline } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import type { ArtifactVersion } from "../../queries"
import { chapterStart } from "./chapters"
import { VideoPlayer } from "./player"

// A video, played in the app: its player opens at the scene or the instant an address names, or
// at its start.

export function VideoRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const { outline } = version
  if (outline.kind !== "video") return null

  return <VideoPlayer version={version} outline={outline} start={startOf(version, outline, part)} />
}

/**
 * A video's scenes as one bar along its length, each as long as it plays, as its card shows it.
 * Drawn on the video's dark screen, in solid greys: where one scene fades into the next, the later
 * one lies over the earlier rather than adding up to a brighter mark.
 */
export function VideoScenesBar({
  outline,
  className,
}: {
  readonly outline: VideoOutline
  readonly className?: string
}) {
  const length = outline.durationMs || 1
  return (
    <span aria-hidden="true" className={cn("block h-1", className)}>
      <span className="relative block size-full">
        {outline.scenes.map((scene) => (
          <span
            key={scene.id}
            className="absolute inset-y-0 rounded-full border-x border-neutral-950 bg-neutral-600"
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
 * Where an address's part opens the video, in seconds: the first frame of the scene it names, or
 * the instant it names; its start for any other.
 */
export function startOf(
  version: ArtifactVersion,
  outline: VideoOutline,
  part: string | undefined
): number {
  if (part === undefined) return 0

  const resolved = resolveArtifactAddress(
    { artifactId: version.artifactId, part },
    { kind: "video", outline, files: version.files }
  )
  if (!("part" in resolved)) return 0

  const found = resolved.part
  if (found.type === "scene") return chapterStart(found, outline.fps)
  if (found.type === "time") return found.ms / 1000
  return 0
}
