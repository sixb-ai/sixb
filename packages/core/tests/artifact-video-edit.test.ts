import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { applyBoardEditToText } from "../src/artifacts/live/board"
import {
  createArtifactDocument,
  documentFiles,
  LIVE_FILES,
  type LiveFiles,
  mergeIntoDocument,
} from "../src/artifacts/live/document"
import { readVideoComposition, type VideoComposition } from "../src/artifacts/video/composition"
import {
  applyVideoEdit,
  cutRange,
  duplicateScene,
  insertClip,
  keepClipRanges,
  moveScene,
  removeClip,
  removeMediaRanges,
  removeScene,
  setClipSound,
  setClipTiming,
  setSceneLabel,
  setSceneLength,
  setVideoText,
  splitClip,
  trimClip,
  type VideoEditResult,
  type VideoSources,
  videoTarget,
} from "../src/artifacts/video/edit"
import { readRootTimeline, readSceneTimeline } from "../src/artifacts/video/timeline"

// Editing a video changes the text of its files as little as it can, and leaves a video: each
// operation is checked by reading the files it leaves as publishing reads them.

/** A three-scene teaser: a title over a recording, a demo of it, an end card, over music. */
const INDEX = `<!doctype html>
<html>
<head><link rel="stylesheet" href="styles.css"></head>
<body>
  <div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="15" data-poster="12">
    <audio id="music" src="media/music.m4a" data-start="0" data-duration="15" data-volume="0.4" data-fade-out="2"></audio>
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3" data-label="Every job, one screen"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook - 0.5" data-duration="8" data-label="Dispatch in two taps"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4.5" data-label="End card"></div>
  </div>
</body>
</html>
`

const HOOK = `<template>
  <div data-composition-id="hook" data-width="1920" data-height="1080">
    <h1 class="title">Every job, one screen</h1>
  </div>
</template>
`

const DEMO = `<template>
  <div data-composition-id="demo" data-width="1920" data-height="1080">
    <video id="talk" src="media/talk.mp4" data-start="0" data-duration="5" data-media-start="2" data-has-audio="true" playsinline></video>
    <video id="screen" src="media/screen.mp4" data-start="5" data-duration="3" muted playsinline></video>
    <p class="caption" data-start="0.5" data-duration="1.5">Assign the nearest tech</p>
    <p class="caption" data-start="2.5" data-duration="2">in two taps</p>
    <p class="callout">Dispatch in two taps</p>
    <script>
      const demo = gsap.timeline({ paused: true })
      demo.from('[data-composition-id="demo"] .callout', { opacity: 0 }, 1)
      document.querySelector("#talk")
      window.__timelines = window.__timelines || {}
      window.__timelines["demo"] = demo
    </script>
  </div>
</template>
`

const OUTRO = `<template>
  <div data-composition-id="outro" data-width="1920" data-height="1080">
    <img src="media/logo.png" alt="Logo">
    <h2>Try it today</h2>
  </div>
</template>
`

const SOURCES: VideoSources = new Map<string, string | null>([
  ["index.html", INDEX],
  ["scenes/hook.html", HOOK],
  ["scenes/demo.html", DEMO],
  ["scenes/outro.html", OUTRO],
  ["styles.css", "h1 { font-size: 140px }"],
  ["media/music.m4a", null],
  ["media/talk.mp4", null],
  ["media/screen.mp4", null],
  ["media/logo.png", null],
  ["media/new.mp4", null],
])

/** The files an edit leaves, refused edits failing the test with their reason. */
function applied(result: VideoEditResult, sources: VideoSources = SOURCES) {
  if ("error" in result) throw new Error(result.error)
  return applyVideoEdit(sources, result.edit)
}

function composition(files: ReadonlyMap<string, string | null>): VideoComposition {
  const read = readVideoComposition(files.get("index.html") as string, (path) => {
    const text = files.get(path)
    return typeof text === "string" ? text : undefined
  })
  if ("error" in read) throw new Error(read.error)
  return read.composition
}

const times = (files: ReadonlyMap<string, string | null>) =>
  composition(files).scenes.map((scene) => [scene.id, scene.startMs, scene.durationMs])

/** How many characters an edit removes and inserts, in all. */
function size(result: VideoEditResult): number {
  if ("error" in result) throw new Error(result.error)
  return result.edit.reduce(
    (sum, file) =>
      "changes" in file
        ? sum +
          file.changes.reduce((each, change) => each + change.remove + change.insert.length, 0)
        : sum,
    0
  )
}

/** Each change of an edit, its text inserted, in file order. */
function inserted(result: VideoEditResult): string[] {
  if ("error" in result) throw new Error(result.error)
  return result.edit.flatMap((file) =>
    "changes" in file ? file.changes.map((change) => change.insert) : []
  )
}

const demoClips = (files: ReadonlyMap<string, string | null>) =>
  readSceneTimeline(files.get("scenes/demo.html") as string)?.clips ?? []

describe("reading a composition's clips", () => {
  test("a scene's clips, tracks and texts, as its file writes them", () => {
    const timeline = readSceneTimeline(DEMO)
    expect(
      timeline?.clips.map((clip) => [
        clip.ref,
        clip.kind,
        clip.track,
        clip.startMs,
        clip.durationMs,
      ])
    ).toEqual([
      ["talk", "video", "picture", 0, 5000],
      ["screen", "video", "picture", 5000, 3000],
      ["#2", "text", "text", 500, 1500],
      ["#3", "text", "text", 2500, 2000],
    ])
    expect(timeline?.clips[0]).toMatchObject({ mediaStartMs: 2000, silent: false })
    expect(timeline?.clips[1]).toMatchObject({ silent: true })
    expect(timeline?.clips[2]).toMatchObject({ caption: true, text: "Assign the nearest tech" })
    expect(timeline?.texts.map((text) => [text.ref, text.text, text.timed])).toEqual([
      ["p:0", "Assign the nearest tech", true],
      ["p:1", "in two taps", true],
      ["p:2", "Dispatch in two taps", false],
    ])
  })

  test("the root's own clips, without its scenes' hosts", () => {
    const timeline = readRootTimeline(INDEX)
    expect(
      timeline?.clips.map((clip) => [clip.ref, clip.track, clip.volume, clip.fadeOutMs])
    ).toEqual([["music", "sound", 0.4, 2000]])
  })

  test("a clip that starts after another starts when it ends", () => {
    const timeline = readSceneTimeline(
      '<template><div data-composition-id="a"><video id="one" src="a.mp4" data-start="1" data-duration="2"></video><video id="two" src="b.mp4" data-start="one + 0.5" data-duration="1"></video></div></template>'
    )
    expect(timeline?.clips.map((clip) => clip.startMs)).toEqual([1000, 3500])
  })
})

describe("editing scenes", () => {
  // Guard proof: leave the root's data-duration as written while an operation moves scenes
  // (openRoot in edit.ts). A longer scene then ends past it, and every step after reads no video.
  test("a scene made longer moves what follows, and the video's length and soundtrack follow", () => {
    const result = setSceneLength(SOURCES, "demo", 10_000)
    const files = applied(result)

    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["demo", 2500, 10_000],
      ["outro", 12_500, 4500],
    ])
    expect(composition(files).durationMs).toBe(17_000)
    expect(readRootTimeline(files.get("index.html") as string)?.clips[0]?.durationMs).toBe(17_000)

    // Three attributes written again: the scene's length, the video's, the soundtrack's.
    expect(inserted(result)).toEqual([
      ' data-duration="17"',
      ' data-duration="17"',
      ' data-duration="10"',
    ])
  })

  // Guard proof: write the root's data-duration, then its data-poster, in two steps in fitRoot:
  // between them the poster lies past the end, and the edit is refused.
  test("a shorter video keeps its poster within it", () => {
    const files = applied(setSceneLength(SOURCES, "demo", 1000))
    const shown = composition(files)
    expect(shown.durationMs).toBe(8000)
    expect(shown.posterMs).toBeLessThan(8000)
  })

  test("a scene is named in its chapter, and an empty name removes it", () => {
    const named = applied(setSceneLabel(SOURCES, "outro", 'See "Northline"'))
    expect(composition(named).scenes[2]?.label).toBe('See "Northline"')
    expect(named.get("index.html")).toContain('data-label="See &quot;Northline&quot;"')

    const unnamed = applied(setSceneLabel(SOURCES, "outro", "  "))
    expect(composition(unnamed).scenes[2]?.label).toBeUndefined()
  })

  test("a scene moved first starts at 0, and each scene that follows another starts after it", () => {
    const result = moveScene(SOURCES, "outro", 0)
    const files = applied(result)

    expect(times(files)).toEqual([
      ["outro", 0, 4500],
      ["hook", 4500, 3000],
      ["demo", 7000, 8000],
    ])
    // The demo keeps its crossfade into the scene before it.
    expect(files.get("index.html")).toContain('data-start="hook - 0.5"')
    // Its host moved in index.html, the play order, and nothing else did.
    const index = files.get("index.html") as string
    expect(index.indexOf('id="outro"')).toBeLessThan(index.indexOf('id="hook"'))
    expect(composition(files).durationMs).toBe(15_000)
  })

  // Guard proof: read the moved host's new place after removing it from index.html, in
  // moveScene. The outro, which starts after the demo, then names no scene, and this is refused.
  test("a scene others follow moves first, and they follow the scene now before them", () => {
    const files = applied(moveScene(SOURCES, "demo", 0))
    expect(times(files)).toEqual([
      ["demo", 0, 8000],
      ["hook", 8000, 3000],
      ["outro", 11_000, 4500],
    ])
  })

  test("moving a scene to its place changes nothing", () => {
    const result = moveScene(SOURCES, "demo", 1)
    expect(result).toEqual({ edit: [] })
  })

  test("a duplicated scene plays after its original, under its own id, file and recordings", () => {
    const result = duplicateScene(SOURCES, "demo")
    const files = applied(result)

    expect("scene" in result && result.scene).toBe("demo-2")
    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["demo", 2500, 8000],
      ["demo-2", 10_500, 8000],
      ["outro", 18_500, 4500],
    ])

    const copy = files.get("scenes/demo-2.html") as string
    expect(copy).toContain('data-composition-id="demo-2"')
    expect(copy).toContain('window.__timelines["demo-2"]')
    expect(copy).toContain('id="talk-2"')
    expect(copy).toContain('querySelector("#talk-2")')
    expect(composition(files).durationMs).toBe(23_000)
  })

  test("a removed scene's followers start where it started, and its file goes", () => {
    const result = removeScene(SOURCES, "demo")
    const files = applied(result)

    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["outro", 2500, 4500],
    ])
    expect(files.has("scenes/demo.html")).toBe(false)
    expect(composition(files).durationMs).toBe(7000)
  })

  test("the last scene is kept", () => {
    const two = applied(removeScene(SOURCES, "demo"))
    const one = applied(removeScene(two, "outro"), two)
    expect(removeScene(one, "hook")).toEqual({ error: "A video keeps at least one scene." })
  })

  test("an edit that leaves no video is refused, naming why", () => {
    const result = setSceneLength(SOURCES, "demo", 700_000)
    expect(result).toEqual({ error: "A video lasts at most 600 s." })
  })
})

describe("scenes at a number of seconds", () => {
  /** The teaser with every scene placed by seconds, one after the other. */
  const placed = new Map(SOURCES)
  placed.set(
    "index.html",
    INDEX.replace('data-start="hook - 0.5"', 'data-start="2.5"').replace(
      'data-start="demo"',
      'data-start="10.5"'
    )
  )

  // Guard proof: in moveScene, return early for every scene whose predecessor is the same; the
  // outro keeps its 10.5 s and a gap opens where the hook was.
  test("moving one moves the scenes after it, each keeping its gap", () => {
    const files = applied(moveScene(placed, "hook", 2), placed)
    expect(times(files)).toEqual([
      ["demo", 0, 8000],
      ["outro", 8000, 4500],
      ["hook", 12_500, 3000],
    ])
    expect(composition(files).durationMs).toBe(15_500)
  })

  // Guard proof: drop the branch for scenes at a number of seconds in duplicateScene; the copy
  // then plays over the demo, and the video keeps its length.
  test("a copy pushes the scenes after it by its length, each keeping its overlap", () => {
    const files = applied(duplicateScene(placed, "hook"), placed)
    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["hook-2", 3000, 3000],
      ["demo", 5500, 8000],
      ["outro", 13_500, 4500],
    ])
    expect(composition(files).durationMs).toBe(18_000)
  })
})

describe("editing clips", () => {
  test("trimming a clip's end with ripple pulls in what follows and the scene's end", () => {
    const result = trimClip(SOURCES, "scenes/demo.html", "talk", "end", 4000, { ripple: true })
    const files = applied(result)

    expect(demoClips(files).map((clip) => [clip.ref, clip.startMs, clip.durationMs])).toEqual([
      ["talk", 0, 4000],
      ["screen", 4000, 3000],
      ["#2", 500, 1500],
      ["#3", 2500, 2000],
    ])
    expect(times(files)[1]).toEqual(["demo", 2500, 7000])
    expect(times(files)[2]).toEqual(["outro", 9500, 4500])
  })

  test("trimming a clip's start goes as far into its file, and with ripple keeps its place", () => {
    const files = applied(
      trimClip(SOURCES, "scenes/demo.html", "talk", "start", 1000, { ripple: true })
    )
    expect(demoClips(files)[0]).toMatchObject({ startMs: 0, durationMs: 4000, mediaStartMs: 3000 })
    expect(demoClips(files)[1]).toMatchObject({ startMs: 4000 })

    const kept = applied(trimClip(SOURCES, "scenes/demo.html", "talk", "start", 1000))
    expect(demoClips(kept)[0]).toMatchObject({
      startMs: 1000,
      durationMs: 4000,
      mediaStartMs: 3000,
    })
    expect(times(kept)[1]).toEqual(["demo", 2500, 8000])
  })

  // Guard proof: bound `moved` by the file's start alone in trimClip; the clip at 0 is written
  // to start at -2 s, which the reader clamps, and its footage plays 2 s late.
  test("a clip's start never goes before its file's, nor before its composition's", () => {
    const pulled = applied(
      trimClip(SOURCES, "scenes/demo.html", "talk", "start", -5000, { ripple: true })
    )
    expect(demoClips(pulled)[0]).toMatchObject({ startMs: 0, mediaStartMs: 0, durationMs: 7000 })

    const held = applied(trimClip(SOURCES, "scenes/demo.html", "talk", "start", -5000))
    expect(demoClips(held)[0]).toMatchObject({ startMs: 0, mediaStartMs: 2000, durationMs: 5000 })
    expect(held.get("scenes/demo.html")).not.toContain('data-start="-')
  })

  test("splitting a clip makes a copy that plays on from where the first stops", () => {
    const result = splitClip(SOURCES, "scenes/demo.html", "talk", 2000)
    const files = applied(result)

    expect("clip" in result && result.clip).toBe("talk-2")
    expect(
      demoClips(files)
        .slice(0, 2)
        .map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.mediaStartMs])
    ).toEqual([
      ["talk", 0, 2000, 2000],
      ["talk-2", 2000, 3000, 4000],
    ])
    // One number written again, one element added.
    expect(size(result)).toBeLessThan(220)
  })

  test("a split too close to an edge is refused", () => {
    const result = splitClip(SOURCES, "scenes/demo.html", "talk", 50)
    expect("error" in result).toBe(true)
  })

  test("removing a clip with ripple closes the gap", () => {
    const files = applied(removeClip(SOURCES, "scenes/demo.html", "talk", { ripple: true }))

    expect(demoClips(files).map((clip) => [clip.ref, clip.startMs, clip.durationMs])).toEqual([
      ["screen", 0, 3000],
    ])
    expect(times(files)[1]).toEqual(["demo", 2500, 3000])
  })

  test("removing a clip without ripple leaves its place empty", () => {
    const files = applied(removeClip(SOURCES, "scenes/demo.html", "screen"))
    expect(demoClips(files).map((clip) => clip.ref)).toEqual(["talk", "#1", "#2"])
    expect(times(files)[1]).toEqual(["demo", 2500, 8000])
    expect(files.get("scenes/demo.html")).not.toContain("screen.mp4")
  })

  test("a clip's timing and sound are written in place", () => {
    const timed = applied(
      setClipTiming(SOURCES, "scenes/demo.html", "screen", { startMs: 4500, durationMs: 2000 })
    )
    expect(demoClips(timed)[1]).toMatchObject({ startMs: 4500, durationMs: 2000 })

    const sound = setClipSound(SOURCES, "index.html", "music", { volume: 0.2, fadeInMs: 500 })
    const files = applied(sound)
    expect(readRootTimeline(files.get("index.html") as string)?.clips[0]).toMatchObject({
      volume: 0.2,
      fadeInMs: 500,
      fadeOutMs: 2000,
    })
    expect(inserted(sound)).toEqual([' data-volume="0.2"', ' data-fade-in="0.5"'])
  })

  test("a fade of 0 is no fade", () => {
    const files = applied(setClipSound(SOURCES, "index.html", "music", { fadeOutMs: 0 }))
    expect(files.get("index.html")).not.toContain("data-fade-out")
  })

  test("a title's words are typed over, escaped", () => {
    const result = setVideoText(SOURCES, "scenes/hook.html", "h1:0", "Jobs & crews\nin one place")
    const files = applied(result)
    expect(files.get("scenes/hook.html")).toContain(
      '<h1 class="title">Jobs &amp; crews<br>in one place</h1>'
    )
    expect(readSceneTimeline(files.get("scenes/hook.html") as string)?.texts[0]?.text).toBe(
      "Jobs & crews in one place"
    )
  })

  test("an imported recording joins its scene over the footage, and the scene grows to hold it", () => {
    const result = insertClip(SOURCES, "scenes/outro.html", {
      kind: "video",
      src: "media/new.mp4",
      startMs: 1000,
      durationMs: 6000,
    })
    const files = applied(result)

    expect("clip" in result && result.clip).toBe("new")
    const clips = readSceneTimeline(files.get("scenes/outro.html") as string)?.clips ?? []
    expect(clips.map((clip) => [clip.ref, clip.kind, clip.startMs, clip.durationMs])).toEqual([
      ["new", "video", 1000, 6000],
    ])
    expect(times(files)[2]).toEqual(["outro", 10_500, 7000])
  })

  test("a file that is not the video's is refused", () => {
    const result = insertClip(SOURCES, "scenes/outro.html", {
      kind: "image",
      src: "media/missing.png",
      startMs: 0,
      durationMs: 1000,
    })
    expect("error" in result && result.error).toContain("media/missing.png")
  })
})

describe("cutting by the transcript", () => {
  test("kept stretches become clips back to back, and what followed moves back", () => {
    // talk plays its file from 2 s to 7 s; keep 2–3.5 and 5–7: 1.5 s is cut at 1.5 s in the scene.
    const result = keepClipRanges(SOURCES, "scenes/demo.html", "talk", [
      { startMs: 2000, endMs: 3500 },
      { startMs: 5000, endMs: 7000 },
    ])
    const files = applied(result)

    expect(
      demoClips(files).map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.mediaStartMs])
    ).toEqual([
      ["talk", 0, 1500, 2000],
      ["talk-2", 1500, 2000, 5000],
      ["screen", 3500, 3000, 0],
      // The first caption ends inside the cut, the second loses its head to it.
      ["#3", 500, 1000, 0],
      ["#4", 1500, 1500, 0],
    ])
    expect(times(files)[1]).toEqual(["demo", 2500, 6500])
  })

  test("a caption inside a cut goes with it", () => {
    const files = applied(
      keepClipRanges(SOURCES, "scenes/demo.html", "talk", [
        { startMs: 2000, endMs: 2400 },
        { startMs: 4200, endMs: 7000 },
      ])
    )
    expect(demoClips(files).filter((clip) => clip.caption)).toHaveLength(1)
  })

  test("a range cut through a scene splits the recordings it crosses, and closes the gap", () => {
    // 1–2 s of the demo: talk is split around it, the first caption loses its middle.
    const files = applied(cutRange(SOURCES, "scenes/demo.html", { startMs: 1000, endMs: 2000 }))

    expect(
      demoClips(files).map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.mediaStartMs])
    ).toEqual([
      ["talk", 0, 1000, 2000],
      ["talk-2", 1000, 3000, 4000],
      ["screen", 4000, 3000, 0],
      ["#3", 500, 500, 0],
      ["#4", 1500, 2000, 0],
    ])
    expect(times(files)[1]).toEqual(["demo", 2500, 7000])
  })

  test("a recording's stretch is cut wherever a clip plays it", () => {
    const split = applied(splitClip(SOURCES, "scenes/demo.html", "talk", 2000))
    // talk plays 2–4 s of its file, talk-2 4–7 s: cut 3.5–4.5 s, half in each.
    const files = applied(
      removeMediaRanges(split, "scenes/demo.html", "media/talk.mp4", [
        { startMs: 3500, endMs: 4500 },
      ]),
      split
    )
    expect(
      demoClips(files)
        .slice(0, 3)
        .map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.mediaStartMs])
    ).toEqual([
      ["talk", 0, 1500, 2000],
      ["talk-2", 1500, 2500, 4500],
      ["screen", 4000, 3000, 0],
    ])
  })

  test("keeping nothing is refused", () => {
    const result = keepClipRanges(SOURCES, "scenes/demo.html", "talk", [])
    expect("error" in result && result.error).toContain("remove it instead")
  })
})

describe("a clip that follows another", () => {
  /** The demo with its first caption shown when the talk ends, a second later. */
  const chained = new Map(SOURCES)
  chained.set(
    "scenes/demo.html",
    DEMO.replace(
      '<p class="caption" data-start="2.5" data-duration="2">in two taps</p>',
      '<p id="after" class="caption" data-start="talk + 1" data-duration="1">in two taps</p>'
    )
  )
  const after = (files: ReadonlyMap<string, string | null>) =>
    demoClips(files).find((clip) => clip.ref === "after")

  test("reads where the clip it follows ends", () => {
    expect(after(chained)?.startMs).toBe(6000)
  })

  // Guard proof: drop the followInstead call in splitClip; the caption then follows the first
  // part and shows at 3 s.
  test("follows the last part of a split", () => {
    const files = applied(splitClip(chained, "scenes/demo.html", "talk", 2000), chained)
    expect(after(files)?.startMs).toBe(6000)
    expect(files.get("scenes/demo.html")).toContain('data-start="talk-2 + 1"')
  })

  // Guard proof: drop the freezeFollowers call in removeClip; the caption then follows nothing
  // and shows at 0 s.
  test("keeps its time when the clip goes, and a ripple moves it as any other", () => {
    const left = applied(removeClip(chained, "scenes/demo.html", "talk"), chained)
    expect(after(left)?.startMs).toBe(6000)

    const closed = applied(
      removeClip(chained, "scenes/demo.html", "talk", { ripple: true }),
      chained
    )
    expect(after(closed)?.startMs).toBe(1000)
  })

  // Guard proof: drop the freezeFollowers call in rippleRemove; the caption then follows the
  // first part of the cut talk and shows at 2 s.
  test("moves back by what a cut takes before it", () => {
    const files = applied(
      cutRange(chained, "scenes/demo.html", { startMs: 1000, endMs: 2000 }),
      chained
    )
    expect(after(files)?.startMs).toBe(5000)
  })
})

describe("an element without an id, named by its place", () => {
  const caption = (files: ReadonlyMap<string, string | null>, words: string) =>
    demoClips(files).find((clip) => clip.text === words)

  /** The demo as the Agent leaves it once it adds a caption before the others. */
  const withAgentCaption = (sources: VideoSources, words = "Meet the dispatcher") => {
    const files = new Map(sources)
    files.set(
      "scenes/demo.html",
      (sources.get("scenes/demo.html") as string).replace(
        '    <p class="caption" data-start="0.5"',
        `    <p class="caption" data-start="0.1" data-duration="0.3">${words}</p>\n    <p class="caption" data-start="0.5"`
      )
    )
    return files
  }

  // Guard proof: return the element at the target's place in resolveTarget, whatever it holds;
  // the trim then lands on "Assign the nearest tech", which took that place.
  test("is found where the Agent's insertion moved it", () => {
    const chosen = caption(SOURCES, "in two taps")
    if (!chosen) throw new Error("No caption.")
    const target = videoTarget(chosen)
    expect(target).toMatchObject({ ref: "#3", tag: "p", words: "in two taps" })

    const moved = withAgentCaption(SOURCES)
    const files = applied(
      setClipTiming(moved, "scenes/demo.html", target, { durationMs: 1000 }),
      moved
    )
    expect(caption(files, "in two taps")?.durationMs).toBe(1000)
    expect(caption(files, "Assign the nearest tech")?.durationMs).toBe(1500)
    expect(caption(files, "Meet the dispatcher")?.durationMs).toBe(300)
  })

  test("is refused when it is gone, or when two are now alike, rather than edit another", () => {
    const chosen = caption(SOURCES, "in two taps")
    if (!chosen) throw new Error("No caption.")
    const target = videoTarget(chosen)

    const gone = new Map(SOURCES)
    gone.set(
      "scenes/demo.html",
      DEMO.replace('<p class="caption" data-start="2.5" data-duration="2">in two taps</p>', "")
    )
    const removed = removeClip(gone, "scenes/demo.html", target)
    expect("error" in removed && removed.error).toContain("changed or was removed")

    const twice = withAgentCaption(SOURCES, "in two taps")
    const alike = removeClip(twice, "scenes/demo.html", target)
    expect("error" in alike && alike.error).toContain("2 clips like the one you chose")
  })

  test("a text typed over is found the same way", () => {
    const text = readSceneTimeline(DEMO)?.texts.find((each) => each.text === "in two taps")
    if (!text) throw new Error("No text.")
    const moved = withAgentCaption(SOURCES)
    const files = applied(
      setVideoText(moved, "scenes/demo.html", videoTarget(text), "in two quick taps"),
      moved
    )
    expect(caption(files, "in two quick taps")).toBeDefined()
    expect(caption(files, "Meet the dispatcher")).toBeDefined()
    expect(caption(files, "Assign the nearest tech")).toBeDefined()
  })
})

describe("minimal changes", () => {
  test("a length is its attribute written again, in place", () => {
    const result = setClipTiming(SOURCES, "scenes/demo.html", "screen", { durationMs: 2500 })
    if ("error" in result) throw new Error(result.error)
    const written = ' data-duration="3"'
    expect(result.edit).toEqual([
      {
        path: "scenes/demo.html",
        changes: [
          { index: DEMO.indexOf(written), remove: written.length, insert: ' data-duration="2.5"' },
        ],
      },
    ])
  })

  test("a scene moved moves its host's line whole, and rewrites only the starts that change", () => {
    const result = moveScene(SOURCES, "outro", 0)
    if ("error" in result) throw new Error(result.error)
    const [index] = result.edit
    const changes = index && "changes" in index ? index.changes : []
    const outroLine = INDEX.split("\n").find((line) => line.includes('id="outro"')) ?? ""

    // The outro's line comes first, with the hook's start, "0", now "outro"; its old line goes.
    expect(changes).toHaveLength(2)
    expect(changes[0]?.insert).toContain('data-composition-src="scenes/outro.html"')
    expect(changes[0]?.insert.endsWith('data-start="outro')).toBe(true)
    expect(changes[1]).toMatchObject({ remove: outroLine.length + 1, insert: "" })
  })

  test("an edit undone by its inverse leaves the files as they were", () => {
    const longer = applied(setSceneLength(SOURCES, "hook", 5000))
    const back = applied(setSceneLength(longer, "hook", 3000), longer)
    expect(back.get("index.html")).toBe(INDEX)
  })
})

describe("editing live", () => {
  const live = (sources: VideoSources): LiveFiles =>
    new Map(
      [...sources].map(([path, text]) => [
        path,
        text === null
          ? {
              file: {
                blobId: path,
                digest: `sha256:${path}`,
                sizeBytes: 1,
                mediaType: "video/mp4",
              } as never,
            }
          : { text },
      ])
    )

  /** Makes an edit to the document, as the app does, each file's changes to its `Y.Text`. */
  const editDocument = (doc: Y.Doc, result: VideoEditResult) => {
    if ("error" in result) throw new Error(result.error)
    for (const file of result.edit) {
      const text = doc.getMap<unknown>(LIVE_FILES).get(file.path)
      if (!("changes" in file) || !(text instanceof Y.Text)) throw new Error(file.path)
      applyBoardEditToText(text, file.changes)
    }
  }

  const sourcesOf = (doc: Y.Doc): VideoSources =>
    new Map(
      [...documentFiles(doc)].map(([path, file]) => [path, "text" in file ? file.text : null])
    )

  test("a person's trim and the Agent's write to the same scene host both stay", () => {
    const doc = createArtifactDocument("video", live(SOURCES))

    // The person makes the demo shorter, live.
    editDocument(doc, setSceneLength(sourcesOf(doc), "demo", 6000))

    // Meanwhile, the Agent renames it and retitles the hook, from the files before the trim.
    const agent = new Map(SOURCES)
    agent.set(
      "index.html",
      INDEX.replace('data-label="Dispatch in two taps"', 'data-label="Two taps"')
    )
    agent.set("scenes/hook.html", HOOK.replace("Every job, one screen", "One screen for every job"))
    mergeIntoDocument(doc, live(SOURCES), live(agent))

    const files = new Map([...sourcesOf(doc)])
    expect(times(files)[1]).toEqual(["demo", 2500, 6000])
    expect(composition(files).scenes[1]?.label).toBe("Two taps")
    expect(files.get("scenes/hook.html")).toContain("One screen for every job")
    expect(composition(files).durationMs).toBe(13_000)
  })

  // Guard proof: drop the attribute alternative from `tokens` in edit.ts; each peer then writes
  // only the digits, and the merged scene lasts "69" seconds. Drop the `laterCopies` loop in
  // setAttributes, and the next write leaves both copies.
  test("two people writing one value at once leave one of theirs, never a mix", () => {
    const one = createArtifactDocument("video", live(SOURCES))
    const two = new Y.Doc()
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    editDocument(one, setSceneLength(sourcesOf(one), "demo", 6000))
    editDocument(two, setSceneLength(sourcesOf(two), "demo", 9000))
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    const files = sourcesOf(one)
    expect(sourcesOf(two)).toEqual(files)
    expect([6000, 9000]).toContain(times(files)[1]?.[2] as number)

    // The next write keeps the value alone.
    const next = applied(setSceneLength(files, "demo", 7000), files)
    expect(times(next)[1]).toEqual(["demo", 2500, 7000])
    expect(
      next
        .get("index.html")
        ?.match(/id="demo"[^>]*/)?.[0]
        .match(/data-duration/g)
    ).toHaveLength(1)
  })

  // Guard proof: delete every path `next` lacks at once, as before, in mergeIntoDocument. The
  // merged end card then plays media/talk.mp4, which the version no longer holds.
  test("the Agent's write keeps a recording a person's concurrent clip still plays", () => {
    const doc = createArtifactDocument("video", live(SOURCES))

    // The person adds a clip of the demo's recording to the end card, live.
    editDocument(
      doc,
      insertClip(sourcesOf(doc), "scenes/outro.html", {
        kind: "video",
        src: "media/talk.mp4",
        startMs: 0,
        durationMs: 2000,
      })
    )

    // Meanwhile, the Agent removes the demo from the files before the clip, and its write leaves
    // out the recordings its copy no longer plays, as an update does.
    const agent = applied(removeScene(SOURCES, "demo"))
    agent.delete("media/talk.mp4")
    agent.delete("media/screen.mp4")
    mergeIntoDocument(doc, live(SOURCES), live(agent))

    const files = sourcesOf(doc)
    expect(files.get("scenes/outro.html")).toContain('src="media/talk.mp4"')
    expect(files.has("media/talk.mp4")).toBe(true)

    // What nothing plays any more goes, as the Agent wrote.
    expect(files.has("media/screen.mp4")).toBe(false)
    expect(files.has("scenes/demo.html")).toBe(false)
  })

  test("two people's edits to two scenes merge, and each is a step of its own", () => {
    const one = createArtifactDocument("video", live(SOURCES))
    const two = new Y.Doc()
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    editDocument(one, splitClip(sourcesOf(one), "scenes/demo.html", "talk", 2000))
    editDocument(two, setSceneLabel(sourcesOf(two), "outro", "Thanks"))
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    const files = sourcesOf(one)
    expect(sourcesOf(two)).toEqual(files)
    expect(demoClips(files).map((clip) => clip.ref)).toContain("talk-2")
    expect(composition(files).scenes[2]?.label).toBe("Thanks")
  })
})
