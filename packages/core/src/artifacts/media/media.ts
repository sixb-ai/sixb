import { inferFileMediaType } from "../../blob-storage/media-type"
import type { FileRef } from "../../blob-storage/types"
import type { Queue, RenderQueueJob } from "../../queues"
import type {
  ArtifactFile,
  ArtifactMediaPart,
  ArtifactMediaPartName,
  ArtifactMediaParts,
  ArtifactMediaProbe,
  ArtifactMediaRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"

// What Sixb derives from a video or a sound of any artifact version, once: what it holds, a proxy,
// a poster, a filmstrip, its peaks, its cuts and its transcript, kept under the digest of its
// bytes. See README.md beside this file.

/**
 * How the render worker derives a media: up to `attempts` since it was last asked for, counted in
 * what is kept, `backoffMs` apart, each within the time {@link mediaJobBudget} gives the media,
 * never past `maxTimeoutMs`.
 */
export const MEDIA_JOB = {
  maxTimeoutMs: 2 * 60 * 60_000,
  attempts: 3,
  backoffMs: 30_000,
} as const

/** The longest media Sixb derives anything from but what it holds. */
export const MAX_MEDIA_DURATION_MS = 30 * 60_000

/** Before the probe: a sandbox opens, the original arrives in it, and ffprobe reads it. */
const PREPARE_MS = 15 * 60_000
/** The transcription model's call, outside the sandbox. */
const TRANSCRIBE_MS = 5 * 60_000
/** The pixels a second that `PROXY_SHARE` encodes in: 1080p at 30 frames a second. */
const PROXY_REFERENCE = 1920 * 1080 * 30
/** Of a 1080p30 media's length, how long its proxy may take, with FFmpeg's `veryfast` preset. */
const PROXY_SHARE = 0.4
/** Codecs that decode several times slower than H.264. */
const SLOW_CODECS = new Set(["hevc", "prores", "av1", "vp9"])

/** The time one attempt has: `timeoutMs` in all, of which the proxy and the sandbox's script. */
export interface MediaJobBudget {
  readonly timeoutMs: number
  /** The script, every part in turn: the proxy, then what media.cjs bounds by the length. */
  readonly deriveMs: number
  readonly proxyMs: number
  readonly transcribeMs: number
}

/**
 * The time a media takes to derive, by what it holds: its proxy by the pixels it decodes, every
 * other part by its length. Before it is probed, the most any media has.
 */
export function mediaJobBudget(probe: ArtifactMediaProbe | undefined): MediaJobBudget {
  if (!probe) {
    const deriveMs = MEDIA_JOB.maxTimeoutMs - PREPARE_MS - TRANSCRIBE_MS
    return {
      timeoutMs: MEDIA_JOB.maxTimeoutMs,
      deriveMs,
      proxyMs: deriveMs,
      transcribeMs: TRANSCRIBE_MS,
    }
  }

  const durationMs = Math.min(probe.durationMs, MAX_MEDIA_DURATION_MS)
  const { video } = probe
  const rate = video
    ? (video.width * video.height * Math.min(video.fps ?? 30, 60)) / PROXY_REFERENCE
    : 0
  const slow = video && SLOW_CODECS.has(video.codec) ? 2 : 1
  const proxyMs = Math.round(2 * 60_000 + durationMs * Math.max(0.2, PROXY_SHARE * rate) * slow)
  // As media.cjs bounds them: a poster in a few looks, then the filmstrip, cuts, peaks and sound.
  const restMs = 8 * 60_000 + durationMs * 1.1
  const deriveMs = Math.round(proxyMs + restMs)

  const timeoutMs = Math.min(MEDIA_JOB.maxTimeoutMs, PREPARE_MS + deriveMs + TRANSCRIBE_MS)
  return { timeoutMs, deriveMs, proxyMs, transcribeMs: TRANSCRIBE_MS }
}

/**
 * Whether what is pending of a media will not come: no write for longer than an attempt and its
 * backoff take, as the job asked for it was lost with its queue. Asked for again, its job counts
 * the attempts already made.
 */
export function isMediaLost(media: ArtifactMediaRecord, now: Date): boolean {
  if (!MEDIA_PARTS.some((name) => media.parts[name].status === "pending")) return false

  const { probe } = media.parts
  const { timeoutMs } = mediaJobBudget(probe.status === "ready" ? probe : undefined)
  return now.getTime() - media.updatedAt.getTime() > timeoutMs + MEDIA_JOB.backoffMs + 60_000
}

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

/** What reads and asks for what is derived of a project's media. */
export interface MediaContext {
  readonly storage: Pick<ArtifactStorage, "listMedia" | "putMedia">
  readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  /** The project has a transcription model now. */
  readonly transcribes: boolean
}

/**
 * Asks the render worker to derive each video and sound of a stored version that nothing has been
 * derived from yet, in one job per digest: a file published again, in this version or any other,
 * asks for nothing once its derivatives are kept. Until then, asking again takes the place of the
 * job still waiting, or waits for the one running, which then finds nothing left to derive. A
 * media kept is asked for again as {@link refreshArtifactMedia} says.
 *
 * The version exists by now and what is derived from it is not, so a request that fails is
 * reported, not thrown: the publish succeeded, and the file plays as it is.
 */
export async function requestArtifactMedia(
  context: MediaContext,
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
    for (const each of kept) {
      const file = media.get(each.digest)
      media.delete(each.digest)
      if (file) await refreshArtifactMedia(context, each, file)
    }
    await enqueueMedia(context.queue, version.projectId, [...media.values()])
  } catch (error) {
    console.error(
      `[Sixb] Could not ask for what is derived of the media in version ${version.version} of '${version.artifactId}'; they play as they are.`,
      error
    )
  }
}

/**
 * Asks again for what is kept of a media when it is due, and returns its parts as they stand:
 *
 * - a transcript that waited for a transcription model, once the project has one, is pending
 *   again, as a new ask whose attempts start over;
 * - what is pending of a media whose job was lost ({@link isMediaLost}) is asked for again as it
 *   stands, its attempts kept, so a media that keeps failing still stops.
 */
export async function refreshArtifactMedia(
  context: MediaContext,
  media: ArtifactMediaRecord,
  file: FileRef
): Promise<ArtifactMediaParts> {
  const { transcript } = media.parts
  if (
    context.transcribes &&
    transcript.status === "unavailable" &&
    transcript.lacks === "transcription_model"
  ) {
    const parts = { ...media.parts, transcript: { status: "pending" } as const }
    await context.storage.putMedia({ ...media, parts, attempts: 0, updatedAt: new Date() })
    await enqueueMedia(context.queue, media.projectId, [file])
    return parts
  }

  if (isMediaLost(media, new Date())) await enqueueMedia(context.queue, media.projectId, [file])
  return media.parts
}

/**
 * Asks again for what failed of a media, and for what the project lacked to make it: each is
 * pending again, as a new ask whose attempts start over, and the render worker derives what is
 * pending, as it does after an attempt cut short. What is ready, or unavailable for what the media
 * is, stays. Returns the parts as they stand now: as they were when nothing is to be asked for.
 */
export async function retryArtifactMedia(
  context: Pick<MediaContext, "storage" | "queue">,
  media: ArtifactMediaRecord,
  file: FileRef
): Promise<ArtifactMediaParts> {
  const parts = mapMediaParts(media.parts, (part) =>
    part.status === "failed" || (part.status === "unavailable" && part.lacks)
      ? { status: "pending" }
      : part
  )
  if (MEDIA_PARTS.every((name) => parts[name].status !== "pending")) return media.parts

  await context.storage.putMedia({ ...media, parts, attempts: 0, updatedAt: new Date() })
  await enqueueMedia(context.queue, media.projectId, [file])
  return parts
}

/**
 * The query a frame names a media's proxy by: the proxy's own digest, so the original's address
 * keeps serving the original. A page that loaded one keeps the bytes it loaded, and one opened once
 * the proxy is ready plays the proxy.
 */
export const MEDIA_PROXY_PARAM = "sixb-proxy"

/**
 * Where a frame loads `file`'s proxy once it is ready, as a reference relative to the frame's
 * root: its path, naming the proxy's bytes. `null` until then: the frame loads the original.
 */
export function mediaProxyReference(
  file: ArtifactFile,
  media: ArtifactMediaRecord | undefined
): string | null {
  const proxy = readyProxy(file, media)
  if (!proxy) return null
  return `${encodeURI(file.path)}?${MEDIA_PROXY_PARAM}=${proxyName(proxy)}`
}

/**
 * The proxy a frame's request for `file` names, by {@link MEDIA_PROXY_PARAM}: `undefined` when it
 * names none, so the frame serves the original; `null` when it names one that is not this media's
 * ready proxy, which the frame answers 404, never with other bytes under that address.
 */
export function requestedMediaProxy(
  file: ArtifactFile,
  media: ArtifactMediaRecord | undefined,
  search: URLSearchParams
): FileRef | null | undefined {
  const named = search.get(MEDIA_PROXY_PARAM)
  if (named === null) return undefined

  const proxy = readyProxy(file, media)
  return proxy && proxyName(proxy) === named ? proxy : null
}

function readyProxy(file: ArtifactFile, media: ArtifactMediaRecord | undefined): FileRef | null {
  if (!media || media.digest !== file.file.digest) return null
  const { proxy } = media.parts
  return proxy.status === "ready" ? proxy.file : null
}

/** A proxy's bytes, as an address names them: the first 16 hex digits of its digest. */
function proxyName(proxy: FileRef): string {
  return proxy.digest.replace(/^sha256:/, "").slice(0, 16)
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
