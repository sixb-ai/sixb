import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress, parseArtifactAddress } from "../../address"
import type { FRAME_CDN_ALLOWLIST } from "../../frames/assets"
import { ARTIFACT_LIMITS } from "../../limits"
import type { VideoOutline } from "../../outline"
import {
  composeVideo,
  cssMoves,
  missingScene,
  parseVideoRoot,
  parseVideoScene,
  VIDEO_ENTRY,
  type VideoComposition,
  type VideoMediaReference,
  type VideoSceneFile,
  videoFilePath,
} from "../../video/composition"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"
import { sceneRenderKeys } from "../video"
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

  const indexText = await read(index)
  const root = parseVideoRoot(indexText)
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

  // A nested composition's file is read as a scene file is: a <template> holding one. Each is read
  // once, however many scenes nest it.
  const nestedFiles = new Map<string, VideoSceneFile>()
  const parsed = async (file: ArtifactFile): Promise<VideoSceneFile> => {
    const known = scenes.get(file.path) ?? nestedFiles.get(file.path)
    if (known) return known

    const scene = parseVideoScene(await read(file), file.path)
    if ("error" in scene) throw invalidArtifact(scene.error)
    nestedFiles.set(file.path, scene.scene)
    return scene.scene
  }

  // What each composition file loads: itself, what it plays, and what it nests, all the way down.
  // Each is walked once per scene, `loaded` being that scene's: a composition two scenes nest
  // plays its `artifact:` addresses at both.
  const load = async (
    path: string,
    file: VideoSceneFile,
    at: string,
    nesting: readonly string[],
    loaded: Map<string, ReadonlySet<string>>
  ): Promise<ReadonlySet<string>> => {
    const known = loaded.get(path)
    if (known) return known

    const paths = new Set([
      path,
      ...played({ file: path, at, media: file.media, exists, references }),
    ])
    for (const { element, value } of file.compositions) {
      const nested = videoFilePath(VIDEO_ENTRY, value, exists)
      const nestedEntry = nested === undefined ? undefined : byPath.get(nested)
      const tag = `<${element} data-composition-src="${value.trim()}">`
      if (nested === undefined || !nestedEntry) {
        throw invalidArtifact(
          `${path}: ${tag} nests a composition that is not one of the video's files: name it by its path from the video's root, such as compositions/lower-third.html.`
        )
      }
      if (nested === path || nesting.includes(nested)) {
        throw invalidArtifact(
          `${path}: ${tag} nests '${nested}', which nests ${path} in turn: a composition never holds itself.`
        )
      }

      const nestedFile = await parsed(nestedEntry)
      for (const each of await load(nested, nestedFile, at, [...nesting, path], loaded)) {
        paths.add(each)
      }
    }

    loaded.set(path, paths)
    return paths
  }
  const rootLoads = played({
    file: VIDEO_ENTRY,
    at: "",
    media: composition.media,
    exists,
    references,
  })
  const loads = new Map<string, ReadonlySet<string>>()
  for (const scene of composition.scenes) {
    const file = scenes.get(scene.src)
    if (file) loads.set(scene.id, await load(scene.src, file, scene.id, [], new Map()))
  }

  const rootTimeline =
    composition.rootTimeline || (await linksMove(composition, byPath, read, exists))
  const keys = sceneRenderKeys({
    index: indexText,
    composition,
    files,
    rootLoads,
    rootTimeline,
    loads,
  })
  return {
    entry: VIDEO_ENTRY,
    outline: {
      kind: "video",
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationMs: composition.durationMs,
      ...(composition.posterMs === undefined ? {} : { posterMs: composition.posterMs }),
      scenes: composition.scenes.map((scene) => ({
        id: scene.id,
        ...(scene.label ? { label: scene.label } : {}),
        startMs: scene.startMs,
        durationMs: scene.durationMs,
        renderKey: keys.get(scene.id) ?? "",
      })),
    },
    references,
  }
}

/** The stylesheet hosts of `FRAME_CDN_ALLOWLIST` that serve fonts, whose CSS never moves. */
const FONT_HOSTS: readonly (typeof FRAME_CDN_ALLOWLIST)[number][] = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
]

/**
 * Whether what `index.html` links makes its root move as time passes: a stylesheet of the version
 * whose CSS animates, one from elsewhere than a font host, which cannot be read, or a script of the
 * version that registers a timeline. A library, a script that registers none, only loads. A file
 * too large to read counts.
 */
async function linksMove(
  composition: VideoComposition,
  byPath: ReadonlyMap<string, ArtifactFile>,
  read: (file: ArtifactFile) => Promise<string>,
  exists: (path: string) => boolean
): Promise<boolean> {
  const fileOf = (value: string) => {
    const path = videoFilePath(VIDEO_ENTRY, value, exists)
    return path === undefined ? undefined : byPath.get(path)
  }
  const readable = (file: ArtifactFile) => file.file.sizeBytes <= ARTIFACT_LIMITS.maxSceneBytes

  for (const { value } of composition.links.stylesheets) {
    const file = fileOf(value)
    if (!file) {
      if (!FONT_HOSTS.some((origin) => value.trim().startsWith(`${origin}/`))) return true
      continue
    }
    if (!readable(file) || cssMoves(await read(file))) return true
  }

  for (const { value } of composition.links.scripts) {
    const file = fileOf(value)
    if (file && (!readable(file) || /__timelines/.test(await read(file)))) return true
  }
  return false
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
