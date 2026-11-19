import { createHash } from "node:crypto"
import type { ArtifactFile } from "../../storage/artifacts/types"
import { frameKitDigest } from "./previews"

// A video renders scene by scene: each scene is a segment of the export, kept apart from the
// version by what it shows, its render key, so a version that changes one scene renders that scene
// again and reuses every other.

const RENDER_KEY_FORMAT = "sixb-video-scene/1"

/**
 * What a scene renders to, as a SHA-256: its id and file, the frame's kit and runtime, and every
 * file it could load, with what each holds. That is `index.html`, where its place, its length and
 * the frame's size are written, the files the root and the scene play, and the files no scene
 * plays, such as stylesheets and fonts, but not the other scenes' own: their HTML, and the files
 * only they play.
 *
 * The key names no artifact: two artifacts that hold the same scene, such as a copy, share its
 * segment. A segment is the scene's frames and nothing else, rendered by the worker from these
 * files alone, so it is the same picture whoever holds it. An `artifact:` address a scene plays
 * is in its HTML as written: what it resolves to is read when the scene renders.
 */
export function sceneRenderKey(input: {
  readonly scene: { readonly id: string; readonly src: string }
  readonly files: readonly ArtifactFile[]
  /** The files only other scenes load: their HTML, and what they alone play. */
  readonly others: ReadonlySet<string>
}): string {
  const { scene, files, others } = input

  const loaded = files
    .filter((entry) => entry.path === scene.src || !others.has(entry.path))
    .map((entry) => [entry.path, entry.file.digest] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  return createHash("sha256")
    .update(JSON.stringify([RENDER_KEY_FORMAT, frameKitDigest(), scene.id, scene.src, loaded]))
    .digest("hex")
}
