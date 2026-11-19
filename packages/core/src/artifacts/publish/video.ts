import { createHash } from "node:crypto"
import type { ArtifactFile } from "../../storage/artifacts/types"
import {
  VIDEO_ENTRY,
  type VideoComposition,
  type VideoScene,
  type VideoSourceSpan,
} from "../video/composition"
import { playTogether } from "../video/project"
import { frameKitDigest } from "./previews"

// A video renders scene by scene: each scene is a segment of the export, kept apart from the
// version by what it shows, its render key, so a version that changes one scene renders that scene
// again and reuses every other. See video/README.md.

const RENDER_KEY_FORMAT = "sixb-video-scene/1"

/** What a scene's host writes of its times and its name, which its key holds as resolved. */
const HOST_TIMES = ["data-start", "data-duration", "data-label"]

/** What stands where a scene's host was: a host moved past the root's own content still counts. */
const HOST_PLACE = "<!-- scene -->"

/**
 * Each scene's render key, by its id: a SHA-256 of what its frames are made of. That is
 *
 * - the frame's kit and runtime;
 * - `index.html` without its scene hosts, the root's own length, and the sounds it plays: the
 *   frame's size, the root's styles, and what it shows itself;
 * - the scene's host, and those of the scenes on screen with it, as one fades into the next: each
 *   with what it writes, its length, and its start from the scene's, in the order `index.html`
 *   lists them, which stacks them;
 * - its start in the video, only when the root plays or animates something of its own
 *   (`rootTimeline`): only then does what the scene shows depend on when it plays. A scene's own
 *   CSS animations and GSAP timeline run from its start, wherever it plays (measured: README);
 * - every other file of the version, with what it holds, but the other scenes' HTML, the videos
 *   neither the root, the scene, nor a scene on screen with it plays, and every sound.
 *
 * A segment is pictures alone: the export mixes the whole video's sound once, apart, so a sound is
 * in no key, and a soundtrack changed or moved renders no scene again.
 *
 * So trimming a scene renders it again, and the scenes it overlaps, but not the others unless the
 * root has a timeline of its own. Images, stylesheets, fonts, scripts, and nested compositions are
 * in every key, whatever loads them; only a recording a scene loads by script alone is missed.
 *
 * `loads` holds what each scene plays, by its id: its file, what it nests, and what they play, as
 * their HTML writes it.
 *
 * The key names no artifact: two artifacts that hold the same scene, such as a copy, share its
 * segment. A segment is the scene's frames and nothing else, rendered by the worker from these
 * files alone, so it is the same picture whoever holds it. An `artifact:` address a scene plays
 * is in its HTML as written: the export adds what it resolves to, to its segment's own key.
 */
export function sceneRenderKeys(input: {
  /** `index.html`'s text, which the composition's spans point into. */
  readonly index: string
  readonly composition: VideoComposition
  readonly files: readonly ArtifactFile[]
  /** What the root plays itself. */
  readonly rootLoads: ReadonlySet<string>
  /** Whether the root plays or animates something of its own, its linked files read. */
  readonly rootTimeline: boolean
  readonly loads: ReadonlyMap<string, ReadonlySet<string>>
}): ReadonlyMap<string, string> {
  const { index, composition, files, rootLoads, rootTimeline, loads } = input
  const { scenes } = composition

  // Its length and its poster's instant change no frame a scene renders, and a sound shows in
  // none: the root's `<audio>` elements are left out too. Each goes with the space before it, so a
  // root that writes one and a root that does not are the same text, and a soundtrack added,
  // moved, or trimmed with the video leaves it as it was.
  const { attributes } = composition.root
  const root = cut(index, [
    ...scenes.map((scene) => ({ ...scene.host.element, with: HOST_PLACE })),
    ...[
      ...(["data-duration", "data-poster"] as const).flatMap((name) => attributes[name] ?? []),
      ...composition.sounds,
    ].map((span) => ({ ...withSpaceBefore(index, span), with: "" })),
  ])

  const hostOf = (scene: VideoScene) => {
    const { element, attributes } = scene.host
    const times = HOST_TIMES.flatMap((name) => {
      const at = attributes[name]
      return at ? [{ start: at.start - element.start, end: at.end - element.start, with: "" }] : []
    })
    return cut(index.slice(element.start, element.end), times)
  }

  return new Map(
    scenes.map((scene) => {
      const beside = scenes
        .filter((other) => playTogether(scene, other))
        .sort((a, b) => a.host.element.start - b.host.element.start)

      const loaded = videoSceneFiles({
        files,
        composition,
        rootLoads,
        loads,
        scenes: beside.map((each) => each.id),
      })
        .filter(({ path }) => path !== VIDEO_ENTRY)
        .map((entry) => [entry.path, entry.file.digest] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

      const key = [
        RENDER_KEY_FORMAT,
        frameKitDigest("video"),
        scene.id,
        sha256(root),
        beside.map((each) => [hostOf(each), each.startMs - scene.startMs, each.durationMs]),
        rootTimeline ? scene.startMs : null,
        loaded,
      ]
      return [scene.id, sha256(JSON.stringify(key))] as const
    })
  )
}

/**
 * The files the frames of `scenes`, shown together, are made of: `index.html`, what the root and
 * those scenes play, and every other file of the version but the other scenes' HTML and the
 * videos nothing among them plays. A sound shows in no frame and is left out, unless `sounds`:
 * HyperFrames still loads every sound of what it renders.
 */
export function videoSceneFiles(input: {
  readonly files: readonly ArtifactFile[]
  readonly composition: Pick<VideoComposition, "scenes">
  readonly rootLoads: ReadonlySet<string>
  readonly loads: ReadonlyMap<string, ReadonlySet<string>>
  readonly scenes: readonly string[]
  readonly sounds?: boolean
}): ArtifactFile[] {
  const { files, composition, rootLoads, loads } = input
  const sceneFiles = new Set(composition.scenes.map((scene) => scene.src))
  const own = new Set([...rootLoads, ...input.scenes.flatMap((id) => [...(loads.get(id) ?? [])])])

  return files.filter(({ path, file }) => {
    const type = file.mediaType ?? ""
    if (path === VIDEO_ENTRY) return true
    if (type.startsWith("audio/") && !input.sounds) return false
    if (own.has(path)) return true
    return !sceneFiles.has(path) && !/^(video|audio)\//.test(type)
  })
}

/** The span, with the spaces and line breaks right before it. */
function withSpaceBefore(text: string, span: VideoSourceSpan): VideoSourceSpan {
  let start = span.start
  while (start > 0 && /\s/.test(text[start - 1] ?? "")) start--
  return { start, end: span.end }
}

/** The text with each span replaced by its `with`; the spans do not overlap. */
function cut(
  text: string,
  spans: readonly (VideoSourceSpan & { readonly with: string })[]
): string {
  let out = ""
  let kept = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(kept, span.start) + span.with
    kept = span.end
  }
  return out + text.slice(kept)
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
