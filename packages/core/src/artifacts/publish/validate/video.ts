import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../../address"
import { ARTIFACT_LIMITS } from "../../limits"
import type { VideoOutline } from "../../outline"
import {
  composeVideo,
  missingScene,
  parseVideoRoot,
  parseVideoScene,
  VIDEO_ENTRY,
  type VideoMediaReference,
  type VideoSceneFile,
  videoFilePath,
} from "../../video/composition"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { sceneRenderKey } from "../video"
import { refuseFrameAssetPaths } from "./html"

/**
 * Reads a video: `index.html`, its root composition, then each scene's `<template>` file, and
 * resolves when each scene starts. Every file a composition plays must be one of the version's,
 * or a file of another artifact by its `artifact:` address, returned to resolve at the scene that
 * plays it. Each scene is named by its render key.
 */
export async function validateVideo(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: VideoOutline
  readonly references: readonly FoundReference[]
}> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const index = byPath.get(VIDEO_ENTRY)
  if (!index) {
    throw invalidArtifact(
      `A video needs '${VIDEO_ENTRY}', its root composition, with a <template> file for each scene and the media they play beside it.`
    )
  }
  refuseFrameAssetPaths(files, "the video")
  refuseTooManyRecordings(files)

  const read = (file: ArtifactFile) =>
    readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxSceneBytes)

  const root = parseVideoRoot(await read(index))
  if ("error" in root) throw invalidArtifact(root.error)

  // One at a time, so the same version is always refused for the same scene.
  const scenes = new Map<string, VideoSceneFile>()
  for (const { id, src } of root.root.scenes) {
    const file = byPath.get(src)
    if (!file) throw invalidArtifact(missingScene(id, src))

    const scene = parseVideoScene(await read(file), src)
    if ("error" in scene) throw invalidArtifact(scene.error)
    scenes.set(src, scene.scene)
  }

  const composed = composeVideo(root.root, scenes)
  if ("error" in composed) throw invalidArtifact(composed.error)
  const { composition } = composed

  const references: FoundReference[] = []
  const exists = (path: string) => byPath.has(path)
  const playedBy = (file: string, at: string, media: readonly VideoMediaReference[]) =>
    played({ file, at, media, exists, references })

  const rootPlays = playedBy(VIDEO_ENTRY, "", composition.media)
  const scenePlays = new Map(
    composition.scenes.map((scene) => [scene.id, playedBy(scene.src, scene.id, scene.media)])
  )

  // What only other scenes load stays out of a scene's key: a scene's own HTML, and each file a
  // scene plays that neither this scene nor the root does.
  const sceneOwned = new Set([
    ...composition.scenes.map((scene) => scene.src),
    ...[...scenePlays.values()].flatMap((paths) => [...paths]),
  ])

  return {
    entry: VIDEO_ENTRY,
    outline: {
      kind: "video",
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationMs: composition.durationMs,
      scenes: composition.scenes.map((scene) => {
        const own = new Set([scene.src, ...rootPlays, ...(scenePlays.get(scene.id) ?? [])])
        const others = new Set([...sceneOwned].filter((path) => !own.has(path)))
        return {
          id: scene.id,
          ...(scene.label ? { label: scene.label } : {}),
          startMs: scene.startMs,
          durationMs: scene.durationMs,
          renderKey: sceneRenderKey({ scene, files, others }),
        }
      }),
    },
    references,
  }
}

/**
 * The version's files a composition's HTML plays and shows. An `artifact:` address is found for
 * resolving, at the scene that plays it; `data:` and `blob:` URLs hold their own bytes. Anything
 * else must be one of the version's files: a frame plays nothing from elsewhere, and an export
 * renders from the version alone.
 */
function played(input: {
  readonly file: string
  readonly at: string
  readonly media: readonly VideoMediaReference[]
  readonly exists: (path: string) => boolean
  readonly references: FoundReference[]
}): ReadonlySet<string> {
  const { file, at, media, exists, references } = input
  const paths = new Set<string>()

  for (const { element, attribute, value } of media) {
    const written = value.trim()
    const tag = `<${element} ${attribute}="${written}">`

    if (isArtifactAddress(written)) {
      if (!parseArtifactAddress(written)?.path) {
        throw invalidArtifact(
          `${file}: ${tag} names no file of that artifact: name one, such as artifact:art_k3m9q2x7tp/media/intro.mp4.`
        )
      }
      references.push({ address: written, as: "embed", at })
      continue
    }
    if (/^(data|blob):/i.test(written)) continue

    const path = videoFilePath(file, written, exists)
    if (path === undefined) {
      throw invalidArtifact(
        `${file}: ${tag} plays a file from outside the video, which neither the player nor an export can load: add it to the video, such as media/<name>, and name it by that path.`
      )
    }
    if (!exists(path)) {
      throw invalidArtifact(
        `${file}: ${tag} plays '${path}', which is not one of the video's files.`
      )
    }
    paths.add(path)
  }

  return paths
}

/** Each recording a version holds is probed and proxied for the player: a video has a few dozen. */
function refuseTooManyRecordings(files: readonly ArtifactFile[]): void {
  const recordings = files.filter(({ file }) => /^(video|audio)\//.test(file.mediaType ?? ""))
  if (recordings.length > ARTIFACT_LIMITS.maxVideoMediaFiles) {
    throw invalidArtifact(
      `A video holds at most ${ARTIFACT_LIMITS.maxVideoMediaFiles} video and sound files; this one has ${recordings.length}. Leave out the ones it no longer plays.`
    )
  }
}
