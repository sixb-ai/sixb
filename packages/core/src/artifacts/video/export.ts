import { createHash } from "node:crypto"
import type { FileRef } from "../../blob-storage/types"
import type { Queue, RenderQueueJob } from "../../queues"
import type {
  ArtifactStorage,
  ArtifactVersionRecord,
  ArtifactVideoRenderLack,
  ArtifactVideoRenderRecord,
} from "../../storage/artifacts/types"
import { parseArtifactAddress } from "../address"
import { HYPERFRAMES_VERSION } from "../frames/hyperframes"
import type { VideoOutline } from "../outline"
import { scenesOnScreen, videoFrameCount, videoSegmentFrames } from "./project"

// A video version exports to one MP4 made of segments kept apart from it, each under a key that
// hashes what it is made of: each scene's frames, from its start until the next scene starts,
// rendered alone, and the whole video's sound, mixed once. A version that changes one scene
// renders that scene's segment again and reuses every other, and the MP4 joins them without
// encoding them again. See README.md beside this file.

/**
 * What renders a video: the agent image's HyperFrames, the release the app plays. Every key names
 * it, so a sandbox that runs another refuses to render, rather than keep what it rendered under a
 * key it does not match.
 */
export const VIDEO_ENGINE = `hyperframes@${HYPERFRAMES_VERSION}`

/**
 * How every segment is encoded, so segments join without being encoded again: H.264 at one
 * quality, a keyframe on its first frame and every two seconds after, captured by two browsers at
 * once, which keeps a segment rendered again the same. Changing them renders every segment anew.
 */
export const VIDEO_SEGMENT_SETTINGS = { crf: 18, keyframeSeconds: 2, workers: 2 } as const

/**
 * How the render worker assembles an export: each attempt within `timeoutMs`, which holds fetching
 * its segments, joining them, and keeping the MP4, up to `attempts`, `backoffMs` apart. While
 * segments render, it looks again every `recheckMs`, and gives up `waitMs` after it was asked.
 */
export const VIDEO_EXPORT_JOB = {
  timeoutMs: 20 * 60_000,
  attempts: 3,
  backoffMs: 15_000,
  recheckMs: 5_000,
  waitMs: 12 * 60 * 60_000,
} as const

/** How many times the render worker tries a segment, and how long it waits between. */
export const VIDEO_SEGMENT_JOB = { attempts: 2, backoffMs: 30_000 } as const

/**
 * How long one segment may take. Rendering a heavy 1080p scene takes up to twelve times its length
 * in a small sandbox (2 vCPU): its frames get twenty seconds each second, in proportion to their
 * pixels, and five minutes to start. The sound is mixed in a few seconds of each minute.
 */
export function videoSegmentTimeoutMs(
  segment: VideoSegment,
  video: Pick<VideoOutline, "fps" | "width" | "height" | "durationMs">
): number {
  if (segment.kind === "sound") return 5 * 60_000 + video.durationMs
  const seconds = (segment.endFrame - segment.startFrame) / video.fps
  const pixels = Math.max(1, (video.width * video.height) / (1920 * 1080))
  return 5 * 60_000 + Math.ceil(seconds * pixels * 20_000)
}

/** What an `artifact:` address a video plays resolved to, as whoever asked reads it: none when not. */
export interface VideoMediaFile {
  readonly address: string
  readonly file?: FileRef
}

/**
 * A segment of a video's export: the frames of a scene, from the frame it starts on up to the one
 * the next scene starts on, rendered alone and silent; or the whole video's sound.
 */
export type VideoSegment =
  | {
      readonly kind: "scene"
      readonly scene: string
      /** The scene's name, as the player shows it, which is in no key. */
      readonly label?: string
      readonly startFrame: number
      readonly endFrame: number
    }
  | { readonly kind: "sound" }

/** What a video's export is made of: its segments, in the order they play, the sound last. */
export interface VideoExportPlan {
  readonly key: string
  /** How many frames the MP4 has. */
  readonly frames: number
  readonly segments: readonly (VideoSegment & { readonly key: string })[]
}

/** A video version, as an export reads it. */
export type VideoExportSource = Pick<ArtifactVersionRecord, "files" | "references"> & {
  readonly outline: VideoOutline
  readonly media: readonly VideoMediaFile[]
}

const EXPORT_FORMAT = "sixb-video-export/1"
const SEGMENT_FORMAT = "sixb-video-segment/1"
const SOUND_FORMAT = "sixb-video-sound/1"

/**
 * What a video's export is made of, from its outline alone, so whoever asks finds what is kept
 * without reading a file. The first segment starts at frame 0, each next one on the frame its
 * scene starts on; a scene that starts with another renders within the other's segment.
 *
 * A segment's key holds its scene's render key, where it starts and how many frames it has from
 * there, the engine and the settings, and what the `artifact:` addresses played by the root and
 * the scenes on screen during it resolve to. The sound's holds every file and what every address resolves to. The
 * export's holds its segments' keys.
 */
export function videoExportPlan(source: VideoExportSource): VideoExportPlan {
  const { outline } = source
  const { fps } = outline
  const frames = videoFrameCount(outline.durationMs, fps)

  const cuts = videoSegmentFrames(outline)
  const scenes = outline.scenes.flatMap((scene) => {
    // Scenes that start on one frame render in the segment of the first.
    const cut = cuts.get(scene.id)
    if (cut?.scene !== scene.id) return []
    const { startFrame, endFrame } = cut

    // The scene's render key holds the scenes on screen during its segment, and so does this.
    const beside = scenesOnScreen(outline, cut)
    const key = hash([
      SEGMENT_FORMAT,
      VIDEO_ENGINE,
      VIDEO_SEGMENT_SETTINGS,
      scene.renderKey,
      Math.round(((startFrame * 1000) / fps - scene.startMs) * 1000) / 1000,
      endFrame - startFrame,
      resolved(source, ["", ...beside.map((each) => each.id)]),
    ])
    const label = scene.label ? { label: scene.label } : {}
    return [{ kind: "scene" as const, scene: scene.id, ...label, startFrame, endFrame, key }]
  })

  const sound = {
    kind: "sound" as const,
    key: hash([
      SOUND_FORMAT,
      VIDEO_ENGINE,
      fps,
      frames,
      sorted(source.files.map((entry) => [entry.path, entry.file.digest] as const)),
      resolved(source),
    ]),
  }

  const segments = [...scenes, sound]
  return { key: hash([EXPORT_FORMAT, segments.map((each) => each.key)]), frames, segments }
}

/** Where the render worker assembles an export: one job per export, by its key. */
export function videoExportJobId(key: string): string {
  return `art_vexp_${key}`
}

/**
 * Where a retry asks anew for an export's segments: apart from the export's own job, which a
 * segment that finishes takes the place of with the payload it was asked with.
 */
function videoExportRetryJobId(key: string): string {
  return `art_vexp_retry_${key}`
}

/** Where it renders a segment: one job per segment, by its key. */
export function videoSegmentJobId(key: string): string {
  return `art_vseg_${key}`
}

/** How far an export that is not kept yet has come. */
export interface VideoExportProgress {
  /** Its segments rendered, of all of them. */
  readonly ready: number
  readonly total: number
  /** Every segment is rendered, and the MP4 is being joined from them. */
  readonly assembling: boolean
}

/**
 * Where an export stands, from what is kept under its keys: the MP4, why it could not be made, or
 * how far it has come. A segment that failed fails the export: why is the segment's.
 */
export function videoExportStatus(
  plan: VideoExportPlan,
  kept: readonly ArtifactVideoRenderRecord[]
):
  | { readonly status: "ready"; readonly file: FileRef }
  | {
      readonly status: "failed"
      readonly reason: string
      /** What the project lacks, when the video is not why. */
      readonly lacks?: ArtifactVideoRenderLack
    }
  | { readonly status: "rendering"; readonly progress: VideoExportProgress } {
  const byKey = new Map(kept.map((record) => [record.key, record]))

  const done = byKey.get(plan.key)
  if (done && "failure" in done) return failed(done)
  if (done) return { status: "ready", file: done.file }

  for (const segment of plan.segments) {
    const record = byKey.get(segment.key)
    if (record && "failure" in record) return failed(record)
  }
  return { status: "rendering", progress: videoExportProgress(plan, kept) }
}

/** Why a render kept failed, and what the project lacks when it says. */
function failed(record: Extract<ArtifactVideoRenderRecord, { failure: string }>) {
  const lacks = record.lacks ? { lacks: record.lacks } : {}
  return { status: "failed" as const, reason: record.failure, ...lacks }
}

/** How many of an export's segments are rendered: those that failed are not. */
export function videoExportProgress(
  plan: VideoExportPlan,
  kept: readonly ArtifactVideoRenderRecord[]
): VideoExportProgress {
  const rendered = new Set(kept.flatMap((record) => ("failure" in record ? [] : [record.key])))
  const ready = plan.segments.filter((segment) => rendered.has(segment.key)).length
  const total = plan.segments.length
  return { ready, total, assembling: ready === total }
}

/** Every key an export reads: its own, then its segments'. */
export function videoExportKeys(plan: VideoExportPlan): string[] {
  return [plan.key, ...plan.segments.map((segment) => segment.key)]
}

/**
 * Asks the render worker to assemble a video version's export, carrying what the version holds
 * now. Asking again while it is asked for asks nothing more; `retry` forgets why the export or its
 * segments could not be made, and asks again for each, in a job of its own: one in the export's
 * place could be taken by a segment that finishes meanwhile, which asks for nothing.
 */
export async function requestVideoExport(
  context: {
    readonly storage: Pick<ArtifactStorage, "clearVideoRenderFailures">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
  },
  version: Pick<ArtifactVersionRecord, "projectId" | "artifactId" | "version">,
  source: VideoExportSource,
  options: { readonly plan: VideoExportPlan; readonly retry?: boolean }
): Promise<void> {
  const { plan } = options
  if (options.retry) {
    await context.storage.clearVideoRenderFailures({
      projectId: version.projectId,
      keys: videoExportKeys(plan),
    })
  }

  await context.queue.enqueue({
    projectId: version.projectId,
    jobs: [
      {
        // One job per export: one asked for answers asking again. A retry, in its own, replaces
        // the retry before it.
        ...(options.retry
          ? { id: videoExportRetryJobId(plan.key), replace: true }
          : { id: videoExportJobId(plan.key) }),
        type: "artifact.video.export.requested",
        payload: {
          artifactId: version.artifactId,
          version: version.version,
          key: plan.key,
          outline: source.outline,
          files: source.files,
          references: source.references,
          media: source.media,
          askedAt: new Date().toISOString(),
          ...(options.retry ? { retry: true } : {}),
        },
      },
    ],
  })
}

/**
 * What each `artifact:` file a version plays resolves to, as `read` reads it: the version its
 * address pins, or the latest. One `read` cannot find, or that holds no such file, resolves to
 * none.
 */
export async function resolveVideoMedia(
  version: Pick<ArtifactVersionRecord, "references">,
  read: (
    artifactId: string,
    version: number | "latest"
  ) => Promise<Pick<ArtifactVersionRecord, "files"> | null>
): Promise<VideoMediaFile[]> {
  const addresses = [
    ...new Set(
      version.references.filter((each) => each.as === "embed").map((each) => each.address)
    ),
  ]

  const media: VideoMediaFile[] = []
  for (const address of addresses) {
    const parsed = parseArtifactAddress(address)
    if (!parsed?.path) continue

    const target = await read(parsed.artifactId, parsed.version ?? "latest").catch(() => null)
    const file = target?.files.find((each) => each.path === parsed.path)?.file
    media.push(file ? { address, file } : { address })
  }
  return media
}

/**
 * The files of `source` the addresses played at `at` resolve to, `""` naming the root, as
 * `[address, digest]` pairs; all of them without `at`.
 */
function resolved(
  source: Pick<VideoExportSource, "references" | "media">,
  at?: readonly string[]
): (readonly [string, string | null])[] {
  const played = new Set(
    source.references
      .filter((reference) => at === undefined || at.includes(reference.at))
      .map((reference) => reference.address)
  )
  return sorted(
    source.media
      .filter((each) => played.has(each.address))
      .map((each) => [each.address, each.file?.digest ?? null] as const)
  )
}

function sorted<T extends readonly [string, unknown]>(pairs: readonly T[]): T[] {
  return [...pairs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
