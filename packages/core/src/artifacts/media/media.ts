import { inferFileMediaType } from "../../blob-storage/media-type"
import type { FileRef } from "../../blob-storage/types"
import type { Queue, RenderQueueJob } from "../../queues"
import type {
  ArtifactFile,
  ArtifactMediaPart,
  ArtifactMediaPartName,
  ArtifactMediaParts,
  ArtifactMediaRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"

// What Sixb derives from a video or a sound of any artifact version, once: what it holds, a proxy,
// a poster, a filmstrip, its peaks, its cuts and its transcript, kept under the digest of its
// bytes. See README.md beside this file.

/**
 * How the render worker derives a media: each attempt within `timeoutMs`, up to `attempts`,
 * `backoffMs` apart. Each step inside it is bounded by the media's own length, so `timeoutMs`
 * holds the longest media, {@link MAX_MEDIA_DURATION_MS}, fetched, encoded and read back.
 */
export const MEDIA_JOB = {
  timeoutMs: 90 * 60_000,
  attempts: 3,
  backoffMs: 30_000,
} as const

/** The longest media Sixb derives anything from but what it holds. */
export const MAX_MEDIA_DURATION_MS = 30 * 60_000

/** Every part, in the order the worker makes them. */
export const MEDIA_PARTS: readonly ArtifactMediaPartName[] = [
  "probe",
  "proxy",
  "poster",
  "filmstrip",
  "waveform",
  "cuts",
  "transcript",
]

/** A video or a sound, by its type, or by its name for a file stored without one. */
export function isMediaFile(file: ArtifactFile): boolean {
  const type = file.file.mediaType ?? inferFileMediaType(file.path)
  return type.startsWith("video/") || type.startsWith("audio/")
}

/** One job per media, by its bytes. */
export function mediaJobId(digest: string): string {
  return `art_media_${digest.replace(/^sha256:/, "")}`
}

/** Every part, none made yet: each pending, or saying why it will not come, as `part` says. */
export function unmadeMediaParts(
  part: (name: ArtifactMediaPartName) => ArtifactMediaPart<never>
): ArtifactMediaParts {
  return {
    probe: part("probe"),
    proxy: part("proxy"),
    poster: part("poster"),
    filmstrip: part("filmstrip"),
    waveform: part("waveform"),
    cuts: part("cuts"),
    transcript: part("transcript"),
  }
}

/** Each part as `map` makes it of what is kept. */
export function mapMediaParts(
  parts: ArtifactMediaParts,
  map: <T extends object>(part: ArtifactMediaPart<T>) => ArtifactMediaPart<T>
): ArtifactMediaParts {
  return {
    probe: map(parts.probe),
    proxy: map(parts.proxy),
    poster: map(parts.poster),
    filmstrip: map(parts.filmstrip),
    waveform: map(parts.waveform),
    cuts: map(parts.cuts),
    transcript: map(parts.transcript),
  }
}

/**
 * Asks the render worker to derive each video and sound of a stored version that nothing has been
 * derived from yet, in one job per digest: a file published again, in this version or any other,
 * asks for nothing once its derivatives are kept. Until then, asking again takes the place of the
 * job still waiting, or waits for the one running, which then finds nothing left to derive; a job
 * lost with its queue is asked for again.
 *
 * The version exists by now and what is derived from it is not, so a request that fails is
 * reported, not thrown: the publish succeeded, and the file plays as it is.
 */
export async function requestArtifactMedia(
  context: {
    readonly storage: Pick<ArtifactStorage, "listMedia">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  },
  version: Pick<ArtifactVersionRecord, "projectId" | "artifactId" | "version" | "files">
): Promise<void> {
  const media = new Map<string, FileRef>()
  for (const file of version.files) {
    if (isMediaFile(file)) media.set(file.file.digest, file.file)
  }
  if (media.size === 0) return

  try {
    const kept = await context.storage.listMedia({
      projectId: version.projectId,
      digests: [...media.keys()],
    })
    for (const { digest } of kept) media.delete(digest)
    await enqueueMedia(context.queue, version.projectId, [...media.values()])
  } catch (error) {
    console.error(
      `[Sixb] Could not ask for what is derived of the media in version ${version.version} of '${version.artifactId}'; they play as they are.`,
      error
    )
  }
}

/**
 * Asks again for what failed of a media: each failed part is pending again, and the render worker
 * derives what is pending, as it does after an attempt cut short. What is ready or unavailable
 * stays. Returns the parts as they stand now: as they were when nothing failed or is pending.
 */
export async function retryArtifactMedia(
  context: {
    readonly storage: Pick<ArtifactStorage, "putMedia">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  },
  media: ArtifactMediaRecord,
  file: FileRef
): Promise<ArtifactMediaParts> {
  const parts = mapMediaParts(media.parts, (part) =>
    part.status === "failed" ? { status: "pending" } : part
  )
  if (MEDIA_PARTS.every((name) => parts[name].status !== "pending")) return media.parts

  await context.storage.putMedia({ ...media, parts, updatedAt: new Date() })
  await enqueueMedia(context.queue, media.projectId, [file])
  return parts
}

/**
 * One job per media, enqueued with `replace`: asking while a job waits takes its place, asking
 * while one runs waits behind it.
 */
async function enqueueMedia(
  queue: Pick<Queue<RenderQueueJob>, "enqueue">,
  projectId: string,
  files: readonly FileRef[]
): Promise<void> {
  if (files.length === 0) return

  await queue.enqueue({
    projectId,
    jobs: files.map((file) => ({
      id: mediaJobId(file.digest),
      replace: true,
      type: "artifact.media.requested" as const,
      payload: { file },
    })),
  })
}
