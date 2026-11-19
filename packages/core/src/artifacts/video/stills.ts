import { createHash } from "node:crypto"
import type { Queue, RenderQueueJob } from "../../queues"
import type { ArtifactStorage, ArtifactVersionRecord } from "../../storage/artifacts/types"
import type { VideoOutline, VideoOutlineScene } from "../outline"
import { resolveVideoMedia, VIDEO_ENGINE } from "./export"

// Each scene of a video gets a still: a picture of its middle, which the player shows for its
// chapter. It is kept under the scene's render key, so a version that keeps a scene as it was keeps
// its still. The video's poster is the still at the instant its root's `data-poster` names, or the
// first scene's. Like a canvas's previews, stills are asked for when a version is published, once
// the video rests.

/**
 * How the render worker snapshots a version's stills: each attempt within `timeoutMs`, up to
 * `attempts`, `backoffMs` apart, `settleMs` after the last write that asked.
 */
export const VIDEO_STILLS_JOB = {
  timeoutMs: 10 * 60_000,
  attempts: 3,
  backoffMs: 30_000,
  settleMs: 15_000,
} as const

/** A still's width at most, in pixels: a card's poster, sharp on a screen of twice its density. */
export const VIDEO_STILL_WIDTH = 1280

const STILL_FORMAT = "sixb-video-still/1"
const POSTER_FORMAT = "sixb-video-poster/1"

/**
 * A picture of a video at one instant, kept under its key: a scene's middle, or the instant its
 * root's `data-poster` names. `scene` is the scene whose segment holds the instant, which every
 * scene on screen then overlaps, so the project that snapshots it keeps those.
 */
export interface VideoStill {
  readonly key: string
  readonly atMs: number
  readonly scene: string
}

/**
 * Where a scene's still is kept: what the scene shows and what snapshots it. What an `artifact:`
 * address it plays resolves to is not in it: a still shows it as the version's publisher read it,
 * and a later change to that artifact keeps the still until the scene changes.
 */
export function videoStillKey(scene: Pick<VideoOutlineScene, "renderKey">): string {
  return hash([STILL_FORMAT, VIDEO_ENGINE, scene.renderKey])
}

/** The moment of the video a scene's still shows: the middle of the scene. */
export function videoStillAtMs(scene: Pick<VideoOutlineScene, "startMs" | "durationMs">): number {
  return scene.startMs + Math.floor(scene.durationMs / 2)
}

/**
 * A video's stills: each scene's middle, then, when its root names one, its poster's instant,
 * kept under what the scene that holds that instant shows and where in it the instant falls.
 */
export function videoStills(outline: VideoOutline): VideoStill[] {
  const scenes = outline.scenes.map((scene) => ({
    key: videoStillKey(scene),
    atMs: videoStillAtMs(scene),
    scene: scene.id,
  }))
  const poster = posterStill(outline)
  return poster ? [...scenes, poster] : scenes
}

/**
 * The still a card and the player show before the video plays: the one at the instant its root's
 * `data-poster` names, else the first scene's.
 */
export function videoPoster(outline: VideoOutline): VideoStill | undefined {
  const [first] = videoStills(outline)
  return posterStill(outline) ?? first
}

function posterStill(outline: VideoOutline): VideoStill | undefined {
  const { posterMs } = outline
  if (posterMs === undefined) return undefined

  // The last scene to start by then, or the first: the one whose segment holds the instant.
  const scene =
    [...outline.scenes].reverse().find((each) => each.startMs <= posterMs) ?? outline.scenes[0]
  if (!scene) return undefined
  return {
    key: hash([POSTER_FORMAT, VIDEO_ENGINE, scene.renderKey, posterMs - scene.startMs]),
    atMs: posterMs,
    scene: scene.id,
  }
}

/**
 * The stills of a video version not kept yet. One that could not be made is asked for again, once
 * the video is published again: a still is cheap, and a failure may have been the sandbox's.
 */
export async function missingVideoStills(
  storage: Pick<ArtifactStorage, "listVideoRenders">,
  version: Pick<ArtifactVersionRecord, "projectId" | "outline">
): Promise<VideoStill[]> {
  if (version.outline.kind !== "video") return []

  const stills = videoStills(version.outline)
  const kept = await storage.listVideoRenders({
    projectId: version.projectId,
    keys: stills.map((still) => still.key),
  })
  const done = new Set(kept.flatMap((record) => ("failure" in record ? [] : [record.key])))
  return stills.filter((still) => !done.has(still.key))
}

/** One job per artifact, which each write that asks replaces. */
export function videoStillsJobId(artifactId: string): string {
  return `art_vstills_${artifactId}`
}

/**
 * Asks the render worker for the stills a stored video version misses, once the video rests,
 * `VIDEO_STILLS_JOB.settleMs` from now, in the artifact's one job: it takes the place of any asked
 * for an earlier write. The `artifact:` files it plays resolve as `read`, its publisher, reads
 * them. Nothing is asked when nothing is missing.
 *
 * The version exists by now and its stills are derived from it, so a request that fails is
 * reported, not thrown: the publish succeeded, and the player shows its scenes without pictures.
 */
export async function requestVideoStills(
  input: {
    readonly storage: Pick<ArtifactStorage, "listVideoRenders">
    readonly queue: Pick<Queue<RenderQueueJob>, "enqueue">
    readonly read: Parameters<typeof resolveVideoMedia>[1]
  },
  version: ArtifactVersionRecord
): Promise<void> {
  if (version.outline.kind !== "video") return

  try {
    if ((await missingVideoStills(input.storage, version)).length === 0) return

    await input.queue.enqueue({
      projectId: version.projectId,
      jobs: [
        {
          id: videoStillsJobId(version.artifactId),
          replace: true,
          type: "artifact.video.stills.requested",
          payload: {
            artifactId: version.artifactId,
            version: version.version,
            updatedAt: version.updatedAt.toISOString(),
            media: await resolveVideoMedia(version, input.read),
          },
          availableAt: new Date(Date.now() + VIDEO_STILLS_JOB.settleMs).toISOString(),
        },
      ],
    })
  } catch (error) {
    console.error(
      `[Sixb] Could not ask for the stills of version ${version.version} of '${version.artifactId}'; its scenes show without pictures.`,
      error
    )
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
