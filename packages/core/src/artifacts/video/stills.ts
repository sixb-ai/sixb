import { createHash } from "node:crypto"
import type { Queue, RenderQueueJob } from "../../queues"
import type { ArtifactStorage, ArtifactVersionRecord } from "../../storage/artifacts/types"
import type { VideoOutlineScene } from "../outline"
import { resolveVideoMedia, VIDEO_ENGINE } from "./export"

// Each scene of a video gets a still: a picture of its middle, which the player shows for its
// chapter and a card shows of the first scene as the video's poster. It is kept under the scene's
// render key, so a version that keeps a scene as it was keeps its still. Like a canvas's previews,
// stills are asked for when a version is published, once the video rests.

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

/**
 * Where a scene's still is kept: what the scene shows and what snapshots it. What an `artifact:`
 * address it plays resolves to is not in it: a still shows it as the version's publisher read it,
 * and a later change to that artifact keeps the still until the scene changes.
 */
export function videoStillKey(scene: Pick<VideoOutlineScene, "renderKey">): string {
  return createHash("sha256")
    .update(JSON.stringify([STILL_FORMAT, VIDEO_ENGINE, scene.renderKey]))
    .digest("hex")
}

/** The moment of the video a scene's still shows: the middle of the scene. */
export function videoStillAtMs(scene: Pick<VideoOutlineScene, "startMs" | "durationMs">): number {
  return scene.startMs + Math.floor(scene.durationMs / 2)
}

/** The scenes of a video version with no still kept, nor why it could not be made. */
export async function missingVideoStills(
  storage: Pick<ArtifactStorage, "listVideoRenders">,
  version: Pick<ArtifactVersionRecord, "projectId" | "outline">
): Promise<VideoOutlineScene[]> {
  if (version.outline.kind !== "video") return []

  const { scenes } = version.outline
  const kept = await storage.listVideoRenders({
    projectId: version.projectId,
    keys: scenes.map(videoStillKey),
  })
  const done = new Set(kept.map((record) => record.key))
  return scenes.filter((scene) => !done.has(videoStillKey(scene)))
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
