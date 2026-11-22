import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import * as Y from "yjs"
import { ARTIFACT_LIMITS } from "../src/artifacts/limits"
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
  moveClip,
  moveClips,
  moveScene,
  removeClip,
  removeClips,
  removeMediaRanges,
  removeScene,
  setClipSound,
  setClipTiming,
  setSceneLabel,
  setSceneLength,
  setVideoText,
  splitClip,
  splitClips,
  trimClip,
  type VideoCut,
  type VideoEditResult,
  type VideoPlaceResult,
  type VideoSources,
  videoTarget,
} from "../src/artifacts/video/edit"
import { readRootTimeline, readSceneTimeline, videoChains } from "../src/artifacts/video/timeline"

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
const hookClips = (files: ReadonlyMap<string, string | null>) =>
  readSceneTimeline(files.get("scenes/hook.html") as string)?.clips ?? []
const outroClips = (files: ReadonlyMap<string, string | null>) =>
  readSceneTimeline(files.get("scenes/outro.html") as string)?.clips ?? []

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

  // Guard proof: classify clips with `wordsOf` again in `clipKind`; the styled caption lands on
  // the picture track as an element, with no words.
  test("a caption that styles its words reads on the text track, and is not typed over", () => {
    const timeline = readSceneTimeline(
      '<template><div data-composition-id="a">' +
        '<p class="caption" data-start="0" data-duration="1"><span class="hot">Dispatch</span> crews<br><b>in</b> seconds</p>' +
        '<div class="card" data-start="1" data-duration="1"><img src="logo.png"> Fieldwise</div>' +
        "</div></template>"
    )

    expect(timeline?.clips.map((clip) => [clip.kind, clip.track, clip.text])).toEqual([
      ["text", "text", "Dispatch crews in seconds"],
      ["element", "picture", undefined],
    ])
    // Only the styled word itself, which holds text alone, is typed over.
    expect(timeline?.texts.map((text) => text.ref)).toEqual(["span:0"])
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

    // Four attributes written again: the video's length and its poster, which the end card it
    // shows takes with it, the soundtrack's length, and the scene's.
    expect(inserted(result)).toEqual([
      ' data-duration="17" data-poster="14"',
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
    expect(composition(files).durationMs).toBe(15_000)
  })

  // Guard proof: return before writing any layer in restack, in edit.ts. The demo then fades in
  // under the end card, which comes after it in index.html.
  test("a scene that fades in over a moved one stacks above it, and moving back undoes it", () => {
    const moved = applied(moveScene(SOURCES, "outro", 1))
    expect(times(moved)).toEqual([
      ["hook", 0, 3000],
      ["outro", 3000, 4500],
      ["demo", 7000, 8000],
    ])
    expect(moved.get("index.html")).toContain('data-start="outro - 0.5" data-duration="8"')
    expect(moved.get("index.html")?.match(/<div id="demo"[^>]*>/)?.[0]).toContain(
      'style="z-index: 1"'
    )

    const back = applied(moveScene(moved, "outro", 2), moved)
    expect(back.get("index.html")).toBe(INDEX)
  })

  // Guard proof: drop the root's own layers from restack. The captions bar, after the hosts in
  // index.html, then paints under the demo, which now has a layer.
  test("a root's captions stay over scenes it restacks, and lose their layer with the last", () => {
    const bar = '<p class="bar" data-start="0" data-duration="15">Fieldwise</p>'
    const captioned = new Map(SOURCES)
    captioned.set("index.html", INDEX.replace("  </div>\n</body>", `    ${bar}\n  </div>\n</body>`))

    const moved = applied(moveScene(captioned, "outro", 1), captioned)
    const index = moved.get("index.html") as string
    expect(index).toContain(
      'data-start="outro - 0.5" data-duration="8" data-label="Dispatch in two taps" style="z-index: 1"'
    )
    expect(index).toContain('<p class="bar" data-start="0" data-duration="15" style="z-index: 2">')

    const back = applied(moveScene(moved, "outro", 2), moved)
    expect(back.get("index.html")).toBe(captioned.get("index.html"))
  })

  // Guard proof: in moveScene, keep the start of every scene that starts after another. The hook
  // and the outro then both follow the demo, and play over each other.
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

describe("stacking scenes as they move", () => {
  /** Five 3 s scenes, each crossfading in over the one before for 0.5 s. */
  const ids = ["a", "b", "c", "d", "e"]
  const chain = new Map<string, string | null>([
    [
      "index.html",
      `<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="13">
${ids
  .map(
    (id, place) =>
      `  <div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${place === 0 ? "0" : `${ids[place - 1]} - 0.5`}" data-duration="3"></div>`
  )
  .join("\n")}
</div>
`,
    ],
    ...ids.map(
      (id) =>
        [
          `scenes/${id}.html`,
          `<template><div data-composition-id="${id}" data-width="1920" data-height="1080"></div></template>\n`,
        ] as const
    ),
  ])

  /** Each pair on screen together whose later scene paints under the earlier: by z-index, then line. */
  const misstacked = (files: ReadonlyMap<string, string | null>) => {
    const index = files.get("index.html") as string
    const scenes = composition(files).scenes
    const paint = (scene: (typeof scenes)[number]) => {
      const tag = index.slice(scene.host.tag.start, scene.host.tag.end)
      return [Number(/z-index:\s*(\d+)/.exec(tag)?.[1] ?? 0), scene.host.element.start] as const
    }
    return scenes.flatMap((early, place) =>
      scenes.slice(place + 1).flatMap((late) => {
        const overlap = late.startMs < early.startMs + early.durationMs
        const [ze, le] = paint(early)
        const [zl, ll] = paint(late)
        return overlap && (zl < ze || (zl === ze && ll < le))
          ? [`${late.id} under ${early.id}`]
          : []
      })
    )
  }

  // Guard proof: in restack, take the stack as it paints, with the moved scene beside its
  // neighbour, rather than play order. Moving d first, then a last, leaves b under d.
  test("after any moves, a scene that fades in over another paints above it", () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }

    for (let run = 0; run < 60; run += 1) {
      let files: ReadonlyMap<string, string | null> = chain
      for (let step = 0; step < 4; step += 1) {
        const scenes = composition(files).scenes
        const scene = scenes[Math.floor(random() * scenes.length)]?.id ?? "a"
        const result = moveScene(files, scene, Math.floor(random() * scenes.length))
        files = applied(result, files)
        expect({ run, step, misstacked: misstacked(files) }).toEqual({ run, step, misstacked: [] })
      }
    }

    const moved = applied(moveScene(chain, "d", 0), chain)
    expect(misstacked(applied(moveScene(moved, "a", 4), moved))).toEqual([])
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

describe("what the root plays during a scene", () => {
  /** The teaser narrated: a line of voice-over said over the demo, one over the end card. */
  const narrated = new Map(SOURCES)
  narrated.set(
    "index.html",
    INDEX.replace(
      '<div id="hook"',
      `<audio id="vo-demo" src="media/vo-demo.m4a" data-start="3" data-duration="2.5"></audio>
    <audio id="vo-outro" src="media/vo-outro.m4a" data-start="11" data-duration="2"></audio>
    <div id="hook"`
    )
  )
  narrated.set("media/vo-demo.m4a", null)
  narrated.set("media/vo-outro.m4a", null)

  const root = (files: ReadonlyMap<string, string | null>) =>
    (readRootTimeline(files.get("index.html") as string)?.clips ?? []).map((clip) => [
      clip.ref,
      clip.startMs,
      clip.durationMs,
    ])

  // Guard proof: give no clip of the root an owner in fitRoot (sceneOfClip returning undefined);
  // the voice-over keeps its seconds while the scenes it narrates move.
  test("a line of voice-over moves with the scene it is said over; the soundtrack stays", () => {
    const longer = applied(setSceneLength(narrated, "hook", 4000), narrated)
    expect(root(longer)).toEqual([
      ["music", 0, 16_000],
      ["vo-demo", 4000, 2500],
      ["vo-outro", 12_000, 2000],
    ])

    const moved = applied(moveScene(narrated, "outro", 0), narrated)
    expect(times(moved)[0]).toEqual(["outro", 0, 4500])
    expect(times(moved)[2]).toEqual(["demo", 7000, 8000])
    expect(root(moved)).toEqual([
      ["music", 0, 15_000],
      ["vo-demo", 7500, 2500],
      ["vo-outro", 500, 2000],
    ])
  })

  test("a removed scene's voice-over goes with it, and what follows keeps its place in its scene", () => {
    const files = applied(removeScene(narrated, "demo"), narrated)
    expect(root(files)).toEqual([
      ["music", 0, 7000],
      ["vo-outro", 3000, 2000],
    ])
  })

  // Guard proof: have posterAfter in edit.ts keep the poster's seconds unless they lie past the
  // end, as before; it then stays at 12 s, in the middle of the longer demo.
  test("the poster keeps its place in the scene it shows, and stays within it", () => {
    const longer = composition(applied(setSceneLength(SOURCES, "demo", 10_000)))
    expect(longer.posterMs).toBe(14_000)

    // The end card made shorter than the poster's place in it: its last frame.
    const shorter = composition(applied(setSceneLength(SOURCES, "outro", 1000)))
    expect(shorter.posterMs).toBe(10_500 + 1000 - 34)
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

  // Guard proof: drop the `LOOK_ID` check from uniqueName (edit.ts); the clip is then named by the
  // id a carried look's rules weigh as, and every look in its scene reaches it.
  test("no clip is named sixb-look, which carried looks keep for themselves", () => {
    const sources = new Map(SOURCES)
    sources.set("media/sixb-look.mp4", null)
    const result = insertClip(sources, "scenes/outro.html", {
      kind: "video",
      src: "media/sixb-look.mp4",
      startMs: 0,
      durationMs: 1000,
    })
    expect("clip" in result && result.clip).toBe("sixb-look-2")
  })
})

describe("editing several clips at once", () => {
  const caption = (words: string) => {
    const found = demoClips(SOURCES).find((clip) => clip.text === words)
    if (!found) throw new Error(`No caption "${words}".`)
    return videoTarget(found)
  }
  const music = (files: ReadonlyMap<string, string | null>) =>
    readRootTimeline(files.get("index.html") as string)?.clips[0]

  test("moves clips of a scene and of the video's own together, each in its file", () => {
    const result = moveClips(
      SOURCES,
      [
        { file: "scenes/demo.html", clip: "talk" },
        { file: "scenes/demo.html", clip: caption("in two taps") },
        { file: "index.html", clip: "music" },
      ],
      500
    )
    const files = applied(result)

    expect(demoClips(files).map((clip) => [clip.ref, clip.startMs])).toEqual([
      ["talk", 500],
      ["screen", 5000],
      ["#2", 500],
      ["#3", 3000],
    ])
    expect(music(files)?.startMs).toBe(500)
    expect("edit" in result && result.edit.map((file) => file.path).sort()).toEqual([
      "index.html",
      "scenes/demo.html",
    ])
  })

  // Guard proof: take `Math.round(deltaMs)` alone as the delta in moveFound (edit.ts); the
  // caption still lands at 0, and the screen at 1.5 s, half a second nearer it: the group is
  // pulled apart.
  test("moves the whole group less when one would go before the video's start", () => {
    const result = moveClips(
      SOURCES,
      [
        { file: "scenes/demo.html", clip: "screen" },
        { file: "scenes/demo.html", clip: caption("Assign the nearest tech") },
      ],
      -3500
    )
    const files = applied(result)

    // The caption, at 3 s in the video, goes back 3 s, to the hook's start; the screen as far.
    expect(hookClips(files).map((clip) => [clip.text, clip.startMs])).toEqual([
      ["Assign the nearest tech", 0],
    ])
    expect(demoClips(files).find((clip) => clip.ref === "screen")?.startMs).toBe(2000)
  })

  // Guard proof: never go on in the next scene in partsOf (edit.ts), `after` always undefined;
  // the screen then runs past the demo's end, which grows to hold it, as moveFound made it, and
  // the outro starts later.
  test("a move never changes a scene's length but the last's", () => {
    const one = applied(moveClip(SOURCES, "scenes/demo.html", "screen", 5500))
    expect(times(one)).toEqual(times(SOURCES))

    const group = applied(
      moveClips(
        SOURCES,
        [
          { file: "scenes/demo.html", clip: "screen" },
          { file: "scenes/demo.html", clip: caption("in two taps") },
        ],
        1000
      )
    )
    expect(times(group)).toEqual(times(SOURCES))
  })

  test("refuses the whole edit when one of the clips is gone", () => {
    const result = moveClips(
      SOURCES,
      [
        { file: "scenes/demo.html", clip: "screen" },
        { file: "scenes/demo.html", clip: "gone" },
      ],
      500
    )
    expect("error" in result && result.error).toContain("no clip 'gone'")
  })

  // Guard proof: call rippleRemove once per clip in removeClips, each with its own stretch;
  // the second cut then lands where the first already moved the rest, and the screen starts at
  // 2.5 s, not 1.5 s.
  test("removes clips in one edit, closing every gap they leave as one cut", () => {
    const group = [
      { file: "scenes/demo.html", clip: caption("Assign the nearest tech") },
      { file: "scenes/demo.html", clip: caption("in two taps") },
    ]

    const closed = applied(removeClips(SOURCES, group, { ripple: true }))
    expect(demoClips(closed).filter((clip) => clip.tag === "p")).toEqual([])
    expect(demoClips(closed).find((clip) => clip.ref === "screen")?.startMs).toBe(1500)
    expect(times(closed)[1]).toEqual(["demo", 2500, 4500])

    const left = applied(removeClips(SOURCES, group))
    expect(demoClips(left).map((clip) => [clip.ref, clip.startMs])).toEqual([
      ["talk", 0],
      ["screen", 5000],
    ])
    expect(times(left)[1]).toEqual(["demo", 2500, 8000])
  })

  // Guard proof: split the clips of a file from the first to the last in splitClips; once the
  // talk is split, the caption's place `#2` names nothing, and the whole edit is refused.
  test("splits clips in one edit, each at its own instant, and names each second part", () => {
    const result = splitClips(SOURCES, [
      { file: "scenes/demo.html", clip: "talk", atMs: 1000 },
      { file: "scenes/demo.html", clip: caption("Assign the nearest tech"), atMs: 1000 },
      { file: "index.html", clip: "music", atMs: 3500 },
    ])
    const files = applied(result)

    expect(
      demoClips(files).map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.text])
    ).toEqual([
      ["talk", 0, 1000, undefined],
      ["talk-2", 1000, 4000, undefined],
      ["screen", 5000, 3000, undefined],
      ["text", 500, 500, "Assign the nearest tech"],
      ["text-2", 1000, 1000, "Assign the nearest tech"],
      ["#5", 2500, 2000, "in two taps"],
    ])
    expect(
      readRootTimeline(files.get("index.html") as string)?.clips.map((clip) => [
        clip.ref,
        clip.startMs,
        clip.durationMs,
      ])
    ).toEqual([
      ["music", 0, 3500],
      ["music-2", 3500, 11_500],
    ])
    expect("clips" in result && result.clips).toEqual([
      { file: "scenes/demo.html", clip: "talk-2" },
      { file: "scenes/demo.html", clip: "text-2" },
      { file: "index.html", clip: "music-2" },
    ])
  })
})

describe("placing clips in the video", () => {
  const caption = (words: string) => {
    const found = demoClips(SOURCES).find((clip) => clip.text === words)
    if (!found) throw new Error(`No caption "${words}".`)
    return videoTarget(found)
  }
  const placed = (result: VideoPlaceResult) => ("edit" in result ? (result.clips ?? []) : [])
  const left = (result: VideoPlaceResult) => ("edit" in result ? (result.animationsLeft ?? []) : [])
  const timing = (clips: readonly { ref: string; startMs: number; durationMs?: number }[]) =>
    clips.map((clip) => [clip.ref, clip.startMs, clip.durationMs])

  /** The sources with some files written otherwise. */
  const with_ = (files: Record<string, string>) => {
    const sources = new Map(SOURCES)
    for (const [path, text] of Object.entries(files)) sources.set(path, text)
    return sources
  }

  // Guard proof: return [{ scene: own, … }] from partsOf in edit.ts, every part kept in its own
  // scene; the caption then stays in the demo at 9.5 s, past the outro's start, and at -1 s.
  test("a clip moved into another scene's time goes into that scene, later or earlier", () => {
    // "in two taps" plays from 5 s in the video: 7 s later is 1.5 s into the outro.
    const later = moveClips(
      SOURCES,
      [{ file: "scenes/demo.html", clip: caption("in two taps") }],
      7000
    )
    const files = applied(later)
    expect(demoClips(files).some((clip) => clip.text === "in two taps")).toBe(false)
    expect(timing(outroClips(files))).toEqual([["#0", 1500, 2000]])
    expect(placed(later)).toEqual([
      { file: "scenes/outro.html", clip: { ref: "#0", tag: "p", words: "in two taps" } },
    ])
    expect(times(files)).toEqual(times(SOURCES))

    // "Assign the nearest tech" plays from 3 s: 2 s sooner is the hook's, where only it plays.
    const sooner = applied(
      moveClip(SOURCES, "scenes/demo.html", caption("Assign the nearest tech"), -1500)
    )
    expect(timing(hookClips(sooner))).toEqual([["#0", 1000, 1500]])
    expect(hookClips(sooner)[0]?.text).toBe("Assign the nearest tech")
  })

  // Guard proof: start the next part at the next scene's own start in partsOf (edit.ts),
  // `at = after.startMs`; the hook's last half second then shows twice, in the hook and in the
  // demo, whose part starts at 0 and plays the file from 3.5 s.
  test("a clip past its scene's end goes on in the next scenes, playing on from where it stopped", () => {
    const sources = with_({
      "scenes/hook.html": HOOK.replace(
        '<h1 class="title">',
        '<video id="intro" src="../media/new.mp4" data-start="0" data-duration="3" data-media-start="1" muted></video>\n    <h1 class="title">'
      ),
    })

    // From the video's start to 14 s: the hook, the demo from where the hook ends, and the outro.
    const result = trimClip(sources, "scenes/hook.html", "intro", "end", 14_000)
    const files = applied(result, sources)
    const parts = (clips: readonly ReturnType<typeof hookClips>[number][]) =>
      clips
        .filter((clip) => clip.src?.endsWith("new.mp4"))
        .map((clip) => [clip.ref, clip.startMs, clip.durationMs, clip.mediaStartMs, clip.src])

    expect(parts(hookClips(files))).toEqual([["intro", 0, 3000, 1000, "../media/new.mp4"]])
    expect(parts(demoClips(files))).toEqual([["intro-2", 500, 7500, 4000, "../media/new.mp4"]])
    expect(parts(outroClips(files))).toEqual([["intro-3", 0, 3500, 11_500, "../media/new.mp4"]])
    expect(times(files)).toEqual(times(sources))
    expect(placed(result)).toEqual([{ file: "scenes/hook.html", clip: "intro" }])
  })

  // Guard proof: grow no scene in placeFound (edit.ts); the outro ends at 15 s, and the caption
  // moved past it is never seen.
  test("a clip past the last scene's end grows it, and the video with it", () => {
    const files = applied(
      moveClips(SOURCES, [{ file: "scenes/demo.html", clip: caption("in two taps") }], 11_000)
    )
    expect(timing(outroClips(files))).toEqual([["#0", 5500, 2000]])
    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["demo", 2500, 8000],
      ["outro", 10_500, 7500],
    ])
    // The soundtrack that ran to the video's end still does.
    expect(composition(files).durationMs).toBe(18_000)
    expect(readRootTimeline(files.get("index.html") as string)?.clips[0]?.durationMs).toBe(18_000)

    // An end pulled past it, in whole frame steps.
    const trimmed = applied(trimClip(SOURCES, "scenes/demo.html", "talk", "end", 12_960))
    expect(timing(outroClips(trimmed)).filter(([ref]) => ref === "talk-2")).toEqual([
      ["talk-2", 0, 4960],
    ])
    expect(times(trimmed)[2]).toEqual(["outro", 10_500, 5000])
  })

  // Guard proof: take the first scene that holds the start in partsOf (`.at(0)` in onTop); the
  // end card's title lands in the hook, under the demo that covers it there.
  test("in a crossfade, a clip goes into the scene on top there", () => {
    const sources = with_({
      "scenes/outro.html": OUTRO.replace(
        "<h2>Try it today</h2>",
        '<h2 data-start="0" data-duration="2">Try it today</h2>'
      ),
    })
    // 2.7 s is in the hook's last half second, which the demo fades in over.
    const files = applied(moveClip(sources, "scenes/outro.html", "#0", 2700 - 10_500), sources)
    expect(outroClips(files)).toEqual([])
    expect(demoClips(files).find((clip) => clip.tag === "h2")).toMatchObject({
      startMs: 200,
      durationMs: 2000,
    })

    // A clip whose own scene still holds its start stays in it, even there.
    const own = applied(
      moveClip(SOURCES, "scenes/demo.html", caption("Assign the nearest tech"), 200)
    )
    expect(demoClips(own).find((clip) => clip.text === "Assign the nearest tech")?.startMs).toBe(
      200
    )
  })

  // Guard proof: keep `was.id` whenever it has one in placeFound (edit.ts); the outro then has
  // two elements whose id is screen, which HyperFrames plays as one.
  test("a clip that lands where its id is taken takes another", () => {
    const sources = with_({
      "scenes/outro.html": OUTRO.replace("<h2>", '<h2 id="screen">'),
    })
    const result = moveClip(sources, "scenes/demo.html", "screen", 9000)
    const files = applied(result, sources)
    const ids = [...(files.get("scenes/outro.html") ?? "").matchAll(/\sid="([^"]*)"/g)].map(
      (match) => match[1]
    )
    expect(ids).toEqual(["screen-2", "screen"])
    expect(placed(result)).toEqual([{ file: "scenes/outro.html", clip: "screen-2" }])
  })

  // Guard proof: drop `src` from the attributes placeFound writes (edit.ts); the copy in the
  // end card, a file at the video's root, then plays `../media/new.mp4`, outside the video. Write
  // `data-media-start` whatever it is, and the clip gains a `data-media-start="0"` it never had.
  test("a recording that lands in a file of another folder plays the same file", () => {
    const sources = with_({
      "index.html": INDEX.replace("scenes/outro.html", "outro.html"),
      "outro.html": OUTRO,
      "scenes/hook.html": HOOK.replace(
        '<h1 class="title">',
        '<video id="intro" src="../media/new.mp4" data-start="0" data-duration="3" muted></video>\n    <h1 class="title">'
      ),
    })
    sources.delete("scenes/outro.html")
    const files = applied(moveClip(sources, "scenes/hook.html", "intro", 11_000), sources)
    expect(files.get("outro.html")).toContain(
      '<video id="intro" src="media/new.mp4" data-start="0.5" data-duration="3" muted></video>'
    )
    expect(composition(files).scenes[2]?.media.map((each) => each.value)).toContain("media/new.mp4")
  })

  // Guard proof: drop the freezeFollowers call from placeFound (edit.ts); the caption then
  // follows a talk its scene no longer holds, and shows at 0 s.
  test("what followed a clip that leaves keeps its time", () => {
    const sources = with_({
      "scenes/demo.html": DEMO.replace(
        '<p class="caption" data-start="2.5" data-duration="2">in two taps</p>',
        '<p id="after" class="caption" data-start="talk + 1" data-duration="1">in two taps</p>'
      ),
    })
    const files = applied(moveClip(sources, "scenes/demo.html", "talk", 9000), sources)
    expect(demoClips(files).find((clip) => clip.ref === "after")?.startMs).toBe(6000)
    expect(files.get("scenes/demo.html")).toContain('id="after" class="caption" data-start="6"')
  })

  // Guard proof: write each rule as the demo scoped it, rescoped to the outro, in writtenLook
  // (looks.ts), as carryLooks did; the outro's own caption then turns yellow, and its `rise`
  // gives way to the demo's. Name the keyframes as they were, `chosen = name`, and the outro's
  // slide fades instead. Leave a carried look where its clip left (no removeCarriedLook in
  // placeFound, edit.ts), and the outro keeps one for a caption it no longer holds. Hash the look
  // as it is written in lookKey (looks.ts), or read a carried rule's key as any selector in
  // stylesItself, and the caption reaches the hook by another key than it reached the outro.
  test("a clip takes its look along to reach it alone, and the scene it lands in keeps its own", () => {
    const demoStyle = `<style>
      @keyframes rise { from { opacity: 0 } to { opacity: 1 } }
      @keyframes spin { to { rotate: 1turn } }
      [data-composition-id="demo"] .caption { color: #ffd166; animation: rise 0.4s; }
      [data-composition-id="hook"] .caption { color: red; }
      .caption,
      .callout { font-weight: 700; }
      .caption:first-child { margin: 0; }
      .frame .caption { border-radius: 24px; }
      .caption.big { font-size: 80px; }
    </style>
    <script>`
    const outroStyle = `<style>
      @keyframes rise { from { transform: translateY(40px) } to { transform: none } }
      [data-composition-id="outro"] .caption { color: white; animation: rise 1s; }
    </style>`
    const sources = with_({
      "scenes/demo.html": DEMO.replace("<script>", demoStyle),
      "scenes/outro.html": OUTRO.replace(
        "<h2>Try it today</h2>",
        `<p class="caption" data-start="0" data-duration="2">Try it today</p>\n    ${outroStyle}`
      ),
      "styles.css":
        'h1 { font-size: 140px }\n[data-composition-id="demo"] .caption {\n  letter-spacing: -0.01em;\n}\n',
    })
    const there = applied(
      moveClips(sources, [{ file: "scenes/demo.html", clip: caption("in two taps") }], 7000),
      sources
    )
    const outro = there.get("scenes/outro.html") ?? ""
    // The look's key, from what it is: every clip carrying it reaches its one style.
    const key = /data-look="([^"]+)"/.exec(outro)?.[1] ?? "none"
    const reach = `:is([data-look="${key}"], #sixb-look)`
    expect(outro).toBe(`<template>
  <div data-composition-id="outro" data-width="1920" data-height="1080">
    <img src="media/logo.png" alt="Logo">
    <p class="caption" data-start="0" data-duration="2">Try it today</p>
    <p class="caption" data-start="1.5" data-duration="2" data-look="${key}">in two taps</p>
    ${outroStyle}
    <style data-look="${key}" data-from="demo">
      [data-composition-id="outro"] ${reach}.caption { letter-spacing: -0.01em; }
      [data-composition-id="outro"] ${reach}.caption { color: #ffd166; animation: rise-2 0.4s; }
      ${reach}.caption { font-weight: 700; }
      @keyframes rise-2 { from { opacity: 0 } to { opacity: 1 } }
    </style>
  </div>
</template>
`)

    // Home again, it leaves its look behind it, and the demo's own rules style it as before.
    const outroCaption = outroClips(there).find((clip) => clip.text === "in two taps")
    if (!outroCaption) throw new Error("The caption did not land in the outro.")
    const back = applied(
      moveClip(there, "scenes/outro.html", videoTarget(outroCaption), 5000 - 10_500),
      there
    )
    expect(back.get("scenes/outro.html")).toBe(sources.get("scenes/outro.html"))
    const styleOf = (text: string | null | undefined) =>
      /<style>[\s\S]*<\/style>/.exec(text ?? "")?.[0]
    expect(styleOf(back.get("scenes/demo.html"))).toBe(styleOf(sources.get("scenes/demo.html")))
    expect(back.get("scenes/demo.html")).not.toContain("data-look")

    // And there again: the same look, once.
    const home = demoClips(back).find((clip) => clip.text === "in two taps")
    if (!home) throw new Error("The caption did not come home.")
    const again = applied(moveClip(back, "scenes/demo.html", videoTarget(home), 2500 + 7000), back)
    expect(again.get("scenes/outro.html")).toBe(outro)

    // On to the hook: the look it carried goes with it, scoped anew, by the same key, and leaves
    // the outro.
    const there2 = outroClips(again).find((clip) => clip.text === "in two taps")
    if (!there2) throw new Error("The caption did not land in the outro again.")
    const onward = applied(
      moveClip(again, "scenes/outro.html", videoTarget(there2), 1000 - 10_500),
      again
    )
    expect(onward.get("scenes/outro.html")).toBe(sources.get("scenes/outro.html"))
    expect(onward.get("scenes/hook.html")).toContain(`<style data-look="${key}" data-from="demo">
      [data-composition-id="hook"] ${reach}.caption { letter-spacing: -0.01em; }
      [data-composition-id="hook"] ${reach}.caption { color: #ffd166; animation: rise-2 0.4s; }
      ${reach}.caption { font-weight: 700; }`)
  })

  // Guard proof: drop the `written` check from placeFound (edit.ts), and the outro holds the look
  // once for each caption. Count every `data-look` as a carrier in pruneLooks, and the look stays
  // once both have gone; prune none after a ripple in rippleRemove, and it stays past the cut.
  test("clips that look alike carry one look, until the last of them leaves", () => {
    const sources = with_({
      "scenes/demo.html": DEMO.replace(
        "<script>",
        `<style>
      [data-composition-id="demo"] .caption { color: #ffd166; }
    </style>
    <script>`
      ),
    })
    const looks = (text: string | null | undefined) =>
      text?.match(/<style data-look="/g)?.length ?? 0
    const inOutro = (files: ReadonlyMap<string, string | null>, words: string) => {
      const found = outroClips(files).find((clip) => clip.text === words)
      if (!found) throw new Error(`No "${words}" in the outro.`)
      return videoTarget(found)
    }
    const inDemo = (files: ReadonlyMap<string, string | null>, words: string) => {
      const found = demoClips(files).find((clip) => clip.text === words)
      if (!found) throw new Error(`No "${words}" in the demo.`)
      return videoTarget(found)
    }

    // Both captions, 8 s on, into the outro together: one look, which each reaches by its key.
    const both = applied(
      moveClips(
        sources,
        [
          { file: "scenes/demo.html", clip: caption("Assign the nearest tech") },
          { file: "scenes/demo.html", clip: caption("in two taps") },
        ],
        8000
      ),
      sources
    )
    const outro = both.get("scenes/outro.html") ?? ""
    const key = /<style data-look="([^"]+)"/.exec(outro)?.[1]
    expect(looks(outro)).toBe(1)
    expect(outro.match(new RegExp(`<p class="caption"[^>]* data-look="${key}"`, "g"))).toHaveLength(
      2
    )

    // One after the other, the second finds its look there already.
    const first = applied(
      moveClip(sources, "scenes/demo.html", inDemo(sources, "Assign the nearest tech"), 8500),
      sources
    )
    const second = applied(
      moveClip(first, "scenes/demo.html", inDemo(first, "in two taps"), 10_500),
      first
    )
    expect(second.get("scenes/outro.html")).toBe(outro)

    // One home again: the other keeps the look. Both: it goes, and the outro is as it was.
    const one = applied(
      moveClip(both, "scenes/outro.html", inOutro(both, "in two taps"), 5000 - 10_500),
      both
    )
    expect(looks(one.get("scenes/outro.html"))).toBe(1)
    expect(one.get("scenes/demo.html")).not.toContain("data-look")
    const none = applied(
      moveClip(one, "scenes/outro.html", inOutro(one, "Assign the nearest tech"), 3000 - 10_500),
      one
    )
    expect(none.get("scenes/outro.html")).toBe(OUTRO)

    // Removed, or cut out with what plays beside it, the last leaves no look either.
    const removed = applied(
      removeClip(one, "scenes/outro.html", inOutro(one, "Assign the nearest tech")),
      one
    )
    expect(removed.get("scenes/outro.html")).toBe(OUTRO)
    const cut = applied(cutRange(one, { startMs: 10_800, endMs: 12_700 }), one)
    expect(outroClips(cut).some((clip) => clip.text === "Assign the nearest tech")).toBe(false)
    expect(cut.get("scenes/outro.html")).not.toContain("data-look")
  })

  // Guard proof: leave the classes out of lookSignature (edit.ts), and the big caption takes the
  // other's look, worked out once for both; leave out the attributes the sheets read, and so does
  // the subtitle.
  test("clips that look otherwise carry looks of their own, moved together", () => {
    const lookOfEach = (marked: string, rule: string) => {
      const sources = with_({
        "scenes/demo.html": DEMO.replace(
          '<p class="caption" data-start="2.5"',
          `<p ${marked} data-start="2.5"`
        ).replace(
          "<script>",
          `<style>
      [data-composition-id="demo"] .caption { color: #ffd166; }
      ${rule}
    </style>
    <script>`
        ),
      })
      const files = applied(
        moveClips(
          sources,
          demoClips(sources)
            .filter((clip) => clip.tag === "p")
            .map((clip) => ({ file: "scenes/demo.html", clip: videoTarget(clip) })),
          8000
        ),
        sources
      )
      const outro = files.get("scenes/outro.html") ?? ""
      // Each caption, and the declarations of the look it carries.
      return ["Assign the nearest tech", "in two taps"].map((words) => {
        const key = new RegExp(`data-look="([^"]+)">${words}<`).exec(outro)?.[1]
        const style = new RegExp(`<style data-look="${key}"[^>]*>([\\s\\S]*?)</style>`).exec(outro)
        return (style?.[1] ?? "").match(/\{[^}]*\}/g)?.join(" ")
      })
    }

    expect(
      lookOfEach(
        'class="caption big"',
        '[data-composition-id="demo"] .caption.big { font-size: 80px; }'
      )
    ).toEqual(["{ color: #ffd166; }", "{ color: #ffd166; } { font-size: 80px; }"])
    expect(
      lookOfEach(
        'class="caption" data-role="sub"',
        '[data-composition-id="demo"] .caption[data-role="sub"] { letter-spacing: 3px; }'
      )
    ).toEqual(["{ color: #ffd166; }", "{ color: #ffd166; } { letter-spacing: 3px; }"])
  })

  // Guard proof: drop the size check from run (edit.ts); the move then writes an outro past what
  // publishing reads. Refuse any file over the limit, `after > before` aside, and a demo already
  // that large can no longer give its caption away.
  test("an edit that would grow an HTML file past what publishing reads is refused", () => {
    const limit = ARTIFACT_LIMITS.maxSceneBytes
    const padded = (text: string, bytes: number) =>
      text.replace("</div>\n</template>", `<!-- ${"x".repeat(bytes)} -->\n  </div>\n</template>`)
    const style = `<style>
      [data-composition-id="demo"] .caption { color: #ffd166; }
    </style>
    <script>`

    // The outro, a few bytes short of the limit: the caption and its look do not fit.
    const full = with_({
      "scenes/demo.html": DEMO.replace("<script>", style),
      "scenes/outro.html": padded(OUTRO, limit - OUTRO.length - 40),
    })
    const refused = moveClips(
      full,
      [{ file: "scenes/demo.html", clip: caption("in two taps") }],
      7000
    )
    expect("error" in refused && refused.error).toMatch(
      new RegExp(
        `^'scenes/outro\\.html' would be \\d+ bytes: each of a video's HTML files holds at most ${limit}\\.$`
      )
    )

    // A demo already past it may still give a caption away: it only shrinks.
    const large = with_({ "scenes/demo.html": padded(DEMO.replace("<script>", style), limit) })
    const given = moveClips(
      large,
      [{ file: "scenes/demo.html", clip: caption("in two taps") }],
      7000
    )
    expect("edit" in given).toBe(true)
  })

  // Guard proof: write every carried rule as `[scene] #id`, its compound dropped, in writtenLook
  // (looks.ts), and read the linked sheets last in lookSheets (edit.ts), as they did; the caption
  // then lands 40 px and white, where it was 60 px and yellow. Leave out `within`, and a rule of a
  // `@media` that does not hold pads it anyway.
  test("a clip looks the same where it lands, as the page computes its style", () => {
    const template = (id: string, inner: string) =>
      `<template>\n  <div data-composition-id="${id}" data-width="1920" data-height="1080">\n    ${inner}\n  </div>\n</template>\n`
    const linked =
      '[data-composition-id="demo"] .caption { color: white; padding-left: 4px }\n.caption { text-transform: uppercase }'
    const demo = template(
      "demo",
      `<p class="caption big" data-role="sub" data-start="1" data-duration="2">Hi</p>
    <style>
      [data-composition-id="demo"] .caption.big { font-size: 60px }
      [data-composition-id="demo"] .caption { font-size: 40px; color: yellow }
      .caption { font-weight: 300 !important }
      [data-composition-id="demo"] :is(.caption, .other) { margin-top: 7px }
      @media (min-width: 1px) { [data-composition-id="demo"] .caption[data-role="sub"] { letter-spacing: 3px } }
      @media (max-width: 1px) { [data-composition-id="demo"] .caption { padding-right: 9px } }
      [data-composition-id="demo"] .caption:hover { opacity: 0.5 }
    </style>`
    )
    const outro = template(
      "outro",
      `<p class="caption" data-start="0" data-duration="1">Own</p>
    <style>
      .caption { color: green; font-size: 10px; font-weight: 900 }
    </style>`
    )
    const sources = new Map<string, string | null>([
      ["index.html", INDEX],
      ["scenes/hook.html", template("hook", "")],
      ["scenes/demo.html", demo],
      ["scenes/outro.html", outro],
      ["styles.css", linked],
    ])
    const result = moveClip(sources, "scenes/demo.html", "#0", 8500)
    const files = applied(result, sources)
    expect("edit" in result && result.looksMayDiffer).toEqual([])

    // Each scene as the page holds it: the linked sheet, then the scene.
    const styleOf = (file: string, words: string) => {
      const browser = new Window()
      const inner =
        /<template>([\s\S]*)<\/template>/.exec(files.get(file) ?? sources.get(file) ?? "")?.[1] ??
        ""
      browser.document.body.innerHTML = `<style>${linked}</style>${inner}`
      const element = [...browser.document.querySelectorAll("p")].find(
        (each) => each.textContent === words
      )
      if (!element) throw new Error(`No "${words}" in ${file}.`)
      const style = browser.getComputedStyle(element)
      const read = [
        "fontSize",
        "color",
        "fontWeight",
        "marginTop",
        "letterSpacing",
        "paddingLeft",
        "paddingRight",
        "textTransform",
      ] as const
      const values = Object.fromEntries(read.map((name) => [name, style[name]]))
      browser.close()
      return values
    }
    const before = (() => {
      const browser = new Window()
      browser.document.body.innerHTML = `<style>${linked}</style>${/<template>([\s\S]*)<\/template>/.exec(demo)?.[1] ?? ""}`
      const element = browser.document.querySelector("p")
      if (!element) throw new Error("No caption.")
      const style = browser.getComputedStyle(element)
      const values = {
        fontSize: style.fontSize,
        color: style.color,
        fontWeight: style.fontWeight,
        marginTop: style.marginTop,
        letterSpacing: style.letterSpacing,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        textTransform: style.textTransform,
      }
      browser.close()
      return values
    })()
    expect(before).toMatchObject({
      fontSize: "60px",
      color: "yellow",
      fontWeight: "300",
      letterSpacing: "3px",
    })
    expect(styleOf("scenes/outro.html", "Hi")).toEqual(before)
    // The outro's own caption keeps its look.
    expect(styleOf("scenes/outro.html", "Own")).toMatchObject({
      fontSize: "10px",
      color: "green",
      fontWeight: "900",
    })
  })

  // Guard proof: carry only rules whose last compound is the clip in stylesItself (looks.ts), as
  // it did; the highlighted word then loses its colour, the escaped class its size, both silently.
  test("a clip takes along what styles the words it holds, and reads escaped classes", () => {
    const demo = `<template>
  <div data-composition-id="demo" data-width="1920" data-height="1080">
    <p id="cap" class="caption md:big" data-start="1" data-duration="2">Nearest <span class="hot">tech</span></p>
    <style>
      [data-composition-id="demo"] .caption .hot { color: #ffd166 }
      [data-composition-id="demo"] .caption > span { font-weight: 800 }
      [data-composition-id="demo"] .md\\:big { font-size: 90px }
      [data-composition-id="demo"] p[class~="caption"] { letter-spacing: 2px }
      [data-composition-id="demo"] .caption { color: white }
    </style>
  </div>
</template>
`
    const sources = with_({ "scenes/demo.html": demo })
    const result = moveClip(sources, "scenes/demo.html", "cap", 8500)
    const files = applied(result, sources)
    expect("edit" in result && result.looksMayDiffer).toEqual([])

    const computed = (html: string) => {
      const browser = new Window()
      browser.document.body.innerHTML = /<template>([\s\S]*)<\/template>/.exec(html)?.[1] ?? ""
      const word = browser.document.querySelector(".hot")
      const line = browser.document.getElementById("cap")
      if (!word || !line) throw new Error("No caption.")
      const values = [
        browser.getComputedStyle(word).color,
        browser.getComputedStyle(word).fontWeight,
        browser.getComputedStyle(line).fontSize,
        browser.getComputedStyle(line).letterSpacing,
        browser.getComputedStyle(line).color,
      ]
      browser.close()
      return values
    }
    expect(computed(demo)).toEqual(["#ffd166", "800", "90px", "2px", "white"])
    expect(computed(files.get("scenes/outro.html") ?? "")).toEqual(computed(demo))

    // What styles its siblings stays with the scene, and says so.
    const beside = with_({
      "scenes/demo.html": demo.replace(
        "</style>",
        '  [data-composition-id="demo"] .caption + .note { color: red }\n    </style>'
      ),
    })
    const moved = moveClip(beside, "scenes/demo.html", "cap", 8500)
    expect("edit" in moved && moved.looksMayDiffer).toEqual([
      { file: "scenes/outro.html", clip: "cap" },
    ])
  })

  // Guard proof: carry the rules a wrapper or a place among siblings gives in lookOf (looks.ts),
  // rather than say so; or say nothing of them, and the caption leaves its frame's look with no
  // word.
  test("says when a look depends on what the clip leaves behind", () => {
    const style = `<style>
      [data-composition-id="demo"] .frame .caption { border-radius: 24px; }
      [data-composition-id="demo"] .caption:first-child { margin: 0; }
    </style>
    <script>`
    const sources = with_({ "scenes/demo.html": DEMO.replace("<script>", style) })
    const result = moveClips(
      sources,
      [{ file: "scenes/demo.html", clip: caption("in two taps") }],
      7000
    )
    expect("edit" in result && result.looksMayDiffer).toEqual([
      { file: "scenes/outro.html", clip: { ref: "#0", tag: "p", words: "in two taps" } },
    ])
    expect(applied(result, sources).get("scenes/outro.html")).not.toContain("border-radius")
  })

  // Guard proof: say every rule through what holds a clip in lookDiffers (looks.ts), as it did; the
  // footage then may look different in an outro that holds it as the demo did. Read a scene's
  // script by its classes and tags alone in placeFound (edit.ts), scriptReaches, and the outro's
  // captions' animation reaches the footage too.
  test("says a look or an animation changes only where what holds the clip makes it so", () => {
    const scened = (text: string, id: string) =>
      text.replace(
        `<div data-composition-id="${id}"`,
        `<div class="scene" data-composition-id="${id}"`
      )
    const linked = ".scene video { object-fit: cover; border-radius: 12px; }\n"
    const footage = (sources: VideoSources) =>
      moveClips(sources, [{ file: "scenes/demo.html", clip: "screen" }], 3000)
    const differ = (sources: VideoSources) => {
      const result = footage(sources)
      if ("error" in result) throw new Error(result.error)
      return result.looksMayDiffer ?? []
    }

    // Both chapters' compositions are scenes: the linked rule holds the footage alike in both.
    const alike = with_({
      "styles.css": linked,
      "scenes/demo.html": scened(DEMO, "demo"),
      "scenes/outro.html": scened(OUTRO, "outro"),
    })
    expect(differ(alike)).toEqual([])

    // Unless a rule it takes along sets what the linked one does: carried, it outranks it now.
    const outranked = new Map(alike)
    outranked.set(
      "scenes/demo.html",
      scened(DEMO, "demo").replace(
        "<script>",
        "<style>video { border-radius: 4px; }</style>\n    <script>"
      )
    )
    expect(differ(outranked)).toEqual([{ file: "scenes/outro.html", clip: "screen" }])

    // The outro is no scene, or the demo's own sheet styles it through the scene: it may differ.
    expect(
      differ(with_({ "styles.css": linked, "scenes/demo.html": scened(DEMO, "demo") }))
    ).toEqual([{ file: "scenes/outro.html", clip: "screen" }])
    const own = with_({
      "scenes/demo.html": scened(DEMO, "demo").replace(
        "<script>",
        '<style>[data-composition-id="demo"] .scene video { opacity: 0.9; }</style>\n    <script>'
      ),
      "scenes/outro.html": scened(OUTRO, "outro"),
    })
    expect(differ(own)).toEqual([{ file: "scenes/outro.html", clip: "screen" }])

    // A script animating the outro's captions, or shots inside a hero the outro does not hold,
    // reaches no footage; one animating its scene's footage, the footage that lands there.
    const animated = (selector: string) => {
      const sources = with_({
        "scenes/demo.html": DEMO.replace('id="screen"', 'id="screen" class="shot"'),
        "scenes/outro.html": scened(OUTRO, "outro").replace(
          "</div>",
          `<script>gsap.timeline().from('${selector}', { opacity: 0 })</script>\n  </div>`
        ),
      })
      const result = footage(sources)
      return "edit" in result ? result.animationsJoined : undefined
    }
    expect(animated('[data-composition-id="outro"] .caption')).toEqual([])
    expect(animated(".hero .shot")).toEqual([])
    expect(animated(".scene video")).toEqual([
      { clip: { file: "scenes/outro.html", clip: "screen" }, scene: "outro" },
    ])
  })

  // Guard proof: return false from scriptNames (looks.ts); the talk then leaves the demo, whose
  // script still looks for #talk, and nothing says so.
  test("says which clip left a scene whose script animates it", () => {
    const talk = moveClip(SOURCES, "scenes/demo.html", "talk", -2500)
    expect(left(talk)).toEqual([
      { clip: { file: "scenes/hook.html", clip: "talk" }, scene: "demo" },
    ])

    // The captions' class is in no script, and a clip that stays in its scene keeps its motion.
    expect(
      left(moveClips(SOURCES, [{ file: "scenes/demo.html", clip: caption("in two taps") }], 7000))
    ).toEqual([])
    expect(left(moveClip(SOURCES, "scenes/demo.html", "talk", 500))).toEqual([])

    // A class the script names as a selector counts; one it reads as a property does not.
    const sources = with_({
      "scenes/demo.html": DEMO.replace(
        '<p class="caption" data-start="0.5"',
        '<p class="caption from" data-start="0.5"'
      ),
    })
    expect(
      left(moveClip(sources, "scenes/demo.html", caption("Assign the nearest tech"), -1500))
    ).toEqual([])
    const named = with_({
      "scenes/demo.html": DEMO.replace(
        '<p class="caption" data-start="0.5"',
        '<p class="caption callout" data-start="0.5"'
      ),
    })
    const moved = moveClip(
      named,
      "scenes/demo.html",
      { ref: "#2", tag: "p", words: "Assign the nearest tech" },
      -1500
    )
    expect(left(moved).map((each) => each.scene)).toEqual(["demo"])
  })

  // Guard proof: return false from scriptReaches (looks.ts); the caption and the footage land in
  // an outro whose script animates captions and footage, and nothing says so.
  test("says which clip landed in a scene whose script animates what it is", () => {
    const sources = with_({
      "scenes/outro.html": OUTRO.replace(
        "</div>",
        `<script>
      const scene = '[data-composition-id="outro"]'
      gsap.timeline().from(\`\${scene} .caption\`, { opacity: 0 }).from(\`\${scene} video\`, { scale: 1.1 })
    </script>
  </div>`
      ),
    })
    const result = moveClips(
      sources,
      [
        { file: "scenes/demo.html", clip: caption("in two taps") },
        { file: "scenes/demo.html", clip: "screen" },
      ],
      7000
    )
    expect("edit" in result ? result.animationsJoined : []).toEqual([
      {
        clip: { file: "scenes/outro.html", clip: { ref: "#1", tag: "p", words: "in two taps" } },
        scene: "outro",
      },
      { clip: { file: "scenes/outro.html", clip: "screen" }, scene: "outro" },
    ])
    // A script that names neither, or only by words, reaches neither.
    const quiet = moveClips(
      SOURCES,
      [{ file: "scenes/demo.html", clip: caption("in two taps") }],
      7000
    )
    expect("edit" in quiet ? quiet.animationsJoined : undefined).toEqual([])
  })

  // Guard proof: give the video's own clips a scene in placeFound (edit.ts), the first; the music
  // then leaves index.html for the hook.
  test("the video's own clips keep to index.html, and a group across scenes is one edit", () => {
    const result = moveClips(
      SOURCES,
      [
        { file: "index.html", clip: "music" },
        { file: "scenes/demo.html", clip: "screen" },
        { file: "scenes/demo.html", clip: caption("Assign the nearest tech") },
      ],
      2000
    )
    const files = applied(result)

    expect(readRootTimeline(files.get("index.html") as string)?.clips[0]).toMatchObject({
      ref: "music",
      startMs: 2000,
    })
    for (const scene of ["scenes/hook.html", "scenes/demo.html", "scenes/outro.html"]) {
      expect(files.get(scene)).not.toContain("music")
    }
    // The screen, 7.5 s to 10.5 s, then 9.5 s to 12.5 s: its last 2 s in the outro.
    expect(timing(demoClips(files)).find(([ref]) => ref === "screen")).toEqual([
      "screen",
      7000,
      1000,
    ])
    expect(timing(outroClips(files))).toEqual([["screen-2", 0, 2000]])
    expect(outroClips(files)[0]?.mediaStartMs).toBe(1000)
    expect(placed(result)).toEqual([
      { file: "index.html", clip: "music" },
      { file: "scenes/demo.html", clip: "screen" },
      { file: "scenes/demo.html", clip: { ref: "#2", tag: "p", words: "Assign the nearest tech" } },
    ])
    expect("edit" in result && result.edit.map((file) => file.path).sort()).toEqual([
      "index.html",
      "scenes/demo.html",
      "scenes/outro.html",
    ])
  })

  // Guard proof: drop the check for clips held by the one leaving in placeFound (edit.ts); the
  // frame then lands in the outro with the footage in it, which still counts from the demo.
  test("refuses the whole group when one clip of it cannot be placed", () => {
    const sources = with_({
      "scenes/demo.html": DEMO.replace(
        '<video id="screen" src="media/screen.mp4" data-start="5" data-duration="3" muted playsinline></video>',
        '<div id="frame" data-start="5" data-duration="3"><video id="screen" src="media/screen.mp4" data-start="5" data-duration="3" muted playsinline></video></div>'
      ),
    })
    const result = moveClips(
      sources,
      [
        { file: "scenes/demo.html", clip: caption("in two taps") },
        { file: "scenes/demo.html", clip: "frame" },
      ],
      4000
    )
    expect("error" in result && result.error).toContain("'frame' holds other clips")
  })

  // Guard proof: drop the early return for a delta of 0 from moveFound (edit.ts); the footage
  // longer than its scene is written shorter, and the held group's too, each an undo step. Drop
  // the one for an unchanged length from trimClip, and the screen past its scene's end moves.
  test("a move or a trim that changes nothing writes nothing", () => {
    const sources = with_({
      "scenes/demo.html": DEMO.replace(
        'data-duration="5" data-media-start="2"',
        'data-duration="12" data-media-start="2"'
      ),
    })
    const unchanged = (result: VideoEditResult) => ("edit" in result ? result.edit : result.error)

    expect(unchanged(moveClip(sources, "scenes/demo.html", "talk", 0))).toEqual([])
    // The talk at the video's 2.5 s and the title held at 0: the group cannot go sooner.
    const held = with_({
      "scenes/demo.html": sources.get("scenes/demo.html") ?? "",
      "scenes/hook.html": HOOK.replace("<h1", '<h1 data-start="0" data-duration="3"'),
    })
    const group = moveClips(
      held,
      [
        { file: "scenes/demo.html", clip: "talk" },
        { file: "scenes/hook.html", clip: "#0" },
      ],
      -500
    )
    expect(unchanged(group)).toEqual([])
    expect(placed(group)).toEqual([
      { file: "scenes/demo.html", clip: "talk" },
      { file: "scenes/hook.html", clip: { ref: "#0", tag: "h1", words: "Every job, one screen" } },
    ])

    // A screen the Agent left past its scene's end stays there when its end is let go in place.
    const past = with_({
      "scenes/demo.html": DEMO.replace(
        'data-start="5" data-duration="3"',
        'data-start="9" data-duration="3"'
      ),
    })
    expect(unchanged(trimClip(past, "scenes/demo.html", "screen", "end", 12_000))).toEqual([])
  })

  // Guard proof: put a clip after the last clip of its track in insertInComposition (edit.ts),
  // as it did; the footage then lands in the outro's tilted phone, and the caption in its lower
  // third, styled as theirs.
  test("a clip lands beside the composition's own elements, never inside one", () => {
    const sources = with_({
      "scenes/outro.html": `<template>
  <div data-composition-id="outro" data-width="1920" data-height="1080">
    <div class="phone" style="transform: scale(0.4) rotate(-8deg)">
      <video id="phone" src="media/screen.mp4" data-start="0" data-duration="4" muted></video>
    </div>
    <div class="lower-third">
      <p class="name" data-start="0.5" data-duration="3">Ada</p>
    </div>
    <script>window.__timelines = window.__timelines || {}</script>
  </div>
</template>
`,
    })
    const files = applied(
      moveClips(
        sources,
        [
          { file: "scenes/demo.html", clip: "talk" },
          { file: "scenes/demo.html", clip: caption("in two taps") },
        ],
        9000
      ),
      sources
    )
    expect(files.get("scenes/outro.html")).toBe(`<template>
  <div data-composition-id="outro" data-width="1920" data-height="1080">
    <div class="phone" style="transform: scale(0.4) rotate(-8deg)">
      <video id="phone" src="media/screen.mp4" data-start="0" data-duration="4" muted></video>
    </div>
    <video id="talk" src="media/talk.mp4" data-start="1" data-duration="5" data-media-start="2" data-has-audio="true" playsinline></video>
    <div class="lower-third">
      <p class="name" data-start="0.5" data-duration="3">Ada</p>
    </div>
    <p class="caption" data-start="3.5" data-duration="2">in two taps</p>
    <script>window.__timelines = window.__timelines || {}</script>
  </div>
</template>
`)

    // An import too, and a picture under the words when the scene shows none yet.
    const imported = applied(
      insertClip(SOURCES, "scenes/outro.html", {
        kind: "image",
        src: "media/logo.png",
        startMs: 0,
        durationMs: 1000,
      })
    )
    expect(imported.get("scenes/outro.html")).toContain(
      '<img src="media/logo.png" alt="Logo">\n    <img id="logo" src="media/logo.png"'
    )
  })

  // Guard proof: put a picture after the last element holding one in insertInComposition
  // (edit.ts), whatever else it holds; the talk then covers the end card's words.
  test("footage lands under a card that holds a picture and words", () => {
    const sources = with_({
      "scenes/outro.html": `<template>
  <div data-composition-id="outro" data-width="1920" data-height="1080">
    <div class="card">
      <img id="logo" src="media/logo.png" data-start="0" data-duration="4">
      <p data-start="0" data-duration="4">Try it today</p>
    </div>
  </div>
</template>
`,
    })
    const files = applied(moveClip(sources, "scenes/demo.html", "talk", 8500), sources)
    expect(files.get("scenes/outro.html")).toContain(
      '<video id="talk" src="media/talk.mp4" data-start="0.5" data-duration="5" data-media-start="2" data-has-audio="true" playsinline></video>\n    <div class="card">'
    )
  })

  // Guard proof: drop the placeFound call from insertClip (edit.ts); the footage then plays on
  // past the hook's end, unseen, and the demo shows none of it.
  test("an import past its scene's end goes on in the next one", () => {
    const result = insertClip(SOURCES, "scenes/hook.html", {
      kind: "video",
      src: "media/new.mp4",
      startMs: 2000,
      durationMs: 2000,
    })
    const files = applied(result)
    expect(timing(hookClips(files))).toEqual([["new", 2000, 1000]])
    expect(timing(demoClips(files)).find(([ref]) => ref === "new-2")).toEqual(["new-2", 500, 1000])
    expect(times(files)).toEqual(times(SOURCES))
  })

  // Guard proof: place the end trim even with ripple in trimClip (edit.ts); the screen then goes
  // on in the outro, and the demo keeps its length.
  test("with ripple, an end trim stays in its scene, which grows as much", () => {
    const files = applied(
      trimClip(SOURCES, "scenes/demo.html", "screen", "end", 9000, { ripple: true })
    )
    expect(timing(demoClips(files)).find(([ref]) => ref === "screen")).toEqual([
      "screen",
      5000,
      4000,
    ])
    expect(outroClips(files)).toEqual([])
    expect(times(files)[1]).toEqual(["demo", 2500, 9000])
  })
})

describe("a clip that goes on in later scenes", () => {
  /** Three scenes back to back, the first opening on a recording. */
  const CHAINED_INDEX = `<div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="15">
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook" data-duration="8"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4"></div>
  </div>
`
  const scene = (id: string, inner = "") => `<template>
  <div data-composition-id="${id}" data-width="1920" data-height="1080">
    ${inner}
  </div>
</template>
`
  const opening = new Map<string, string | null>([
    ["index.html", CHAINED_INDEX],
    [
      "scenes/hook.html",
      scene(
        "hook",
        '<video id="intro" src="media/a.mp4" data-start="0" data-duration="2" data-has-audio="true"></video>'
      ),
    ],
    ["scenes/demo.html", scene("demo", '<p class="t" data-start="1" data-duration="1">x</p>')],
    ["scenes/outro.html", scene("outro", '<p class="t" data-start="1" data-duration="1">y</p>')],
    ["media/a.mp4", null],
  ])
  const intro = (files: ReadonlyMap<string, string | null>) =>
    ["scenes/hook.html", "scenes/demo.html", "scenes/outro.html"].flatMap((file) =>
      (readSceneTimeline(files.get(file) as string)?.clips ?? [])
        .filter((clip) => clip.src === "media/a.mp4")
        .map((clip) => [
          file,
          clip.ref,
          clip.startMs,
          clip.durationMs,
          clip.mediaStartMs,
          clip.continues,
        ])
    )
  /** The opening, its recording pulled to play until 5 s, then 12 s, into the scenes after. */
  const toFive = applied(trimClip(opening, "scenes/hook.html", "intro", "end", 5000), opening)
  const toTwelve = applied(trimClip(opening, "scenes/hook.html", "intro", "end", 12_000), opening)

  // Guard proof: write no `data-continues` on the parts placeFound adds (edit.ts); they then name
  // nothing, and no later edit finds them with their clip.
  test("each part names the clip it goes on from", () => {
    expect(intro(toTwelve)).toEqual([
      ["scenes/hook.html", "intro", 0, 3000, 0, undefined],
      ["scenes/demo.html", "intro-2", 0, 8000, 3000, "intro"],
      ["scenes/outro.html", "intro-3", 0, 1000, 11_000, "intro"],
    ])
  })

  // Guard proof: find no chain in logicalClip (edit.ts), each part named a clip of its own; the
  // move adds new parts beside the old one, and the recording plays twice in the demo.
  test("moves as one, its parts written again where they are, never twice", () => {
    const moved = moveClip(toFive, "scenes/hook.html", "intro", 1000)
    const files = applied(moved, toFive)
    expect(intro(files)).toEqual([
      ["scenes/hook.html", "intro", 1000, 2000, 0, undefined],
      ["scenes/demo.html", "intro-2", 0, 3000, 2000, "intro"],
    ])
    // Dragged by its part in the demo, as far.
    const byPart = applied(moveClip(toFive, "scenes/demo.html", "intro-2", 1000), toFive)
    expect(intro(byPart)).toEqual(intro(files))
  })

  // Guard proof: find no chain in trimClip (edit.ts), the part named a clip of its own; its end in
  // the outro then makes that part the whole clip, and the hook's and the demo's play on twice.
  test("trims as one, at either end, whichever part is held", () => {
    const shorter = applied(
      trimClip(toTwelve, "scenes/outro.html", "intro-3", "end", 500),
      toTwelve
    )
    expect(intro(shorter)).toEqual([
      ["scenes/hook.html", "intro", 0, 3000, 0, undefined],
      ["scenes/demo.html", "intro-2", 0, 8000, 3000, "intro"],
      ["scenes/outro.html", "intro-3", 0, 500, 11_000, "intro"],
    ])
    // Back within its first scene, it is one clip again.
    const back = applied(trimClip(toTwelve, "scenes/hook.html", "intro", "end", 2000), toTwelve)
    expect(intro(back)).toEqual([["scenes/hook.html", "intro", 0, 2000, 0, undefined]])

    // A later start plays as much less of each part's file, written only where it changes.
    const later = trimClip(toFive, "scenes/hook.html", "intro", "start", 1000)
    expect(intro(applied(later, toFive))).toEqual([
      ["scenes/hook.html", "intro", 1000, 2000, 1000, undefined],
      ["scenes/demo.html", "intro-2", 0, 2000, 3000, "intro"],
    ])
    expect("edit" in later && later.edit.map((file) => file.path)).toEqual(["scenes/hook.html"])
  })

  // Guard proof: find no chain in removeClip (edit.ts); the demo then plays the rest of the
  // recording on its own. Return the second half alone from splitChained, and the outro's part
  // still goes on from the first, which ends in the demo.
  test("goes whole, and splits into two clips that each go on as before", () => {
    for (const part of ["intro", "intro-2", "intro-3"]) {
      const file = {
        intro: "scenes/hook.html",
        "intro-2": "scenes/demo.html",
        "intro-3": "scenes/outro.html",
      }[part] as string
      expect(intro(applied(removeClip(toTwelve, file, part), toTwelve))).toEqual([])
    }
    expect(
      intro(
        applied(removeClips(toTwelve, [{ file: "scenes/demo.html", clip: "intro-2" }]), toTwelve)
      )
    ).toEqual([])

    // Split in the demo, at 5 s in the video: the second half heads what plays after it.
    const split = splitClip(toTwelve, "scenes/demo.html", "intro-2", 2000)
    expect("clip" in split && split.clip).toBe("intro-4")
    expect(intro(applied(split, toTwelve))).toEqual([
      ["scenes/hook.html", "intro", 0, 3000, 0, undefined],
      ["scenes/demo.html", "intro-2", 0, 2000, 3000, "intro"],
      ["scenes/demo.html", "intro-4", 2000, 6000, 5000, undefined],
      ["scenes/outro.html", "intro-3", 0, 1000, 11_000, "intro-4"],
    ])
  })

  // Guard proof: write no fades on the parts placeFound adds (edit.ts), dropping `fades`; each
  // keeps the voice's fades, and the sound dips at every chapter's edge. Drop them from a part
  // written again, or from the head in place, and a fade out is lost or left mid-clip.
  test("fades in on its first part and out on its last, however it is placed", () => {
    const voice = new Map(opening)
    voice.set(
      "scenes/hook.html",
      scene(
        "hook",
        '<audio id="vo" src="media/a.mp4" data-start="0" data-duration="2" data-fade-in="0.5" data-fade-out="1"></audio>'
      )
    )
    const fades = (files: ReadonlyMap<string, string | null>) =>
      ["scenes/hook.html", "scenes/demo.html", "scenes/outro.html"].flatMap((file) =>
        (readSceneTimeline(files.get(file) as string)?.clips ?? [])
          .filter((clip) => clip.kind === "audio")
          .map((clip) => [file, clip.fadeInMs, clip.fadeOutMs])
      )

    const long = applied(trimClip(voice, "scenes/hook.html", "vo", "end", 12_000), voice)
    expect(fades(long)).toEqual([
      ["scenes/hook.html", 500, undefined],
      ["scenes/demo.html", undefined, undefined],
      ["scenes/outro.html", undefined, 1000],
    ])
    // Shorter, its last part is now in the demo, and fades out there.
    const shorter = applied(trimClip(long, "scenes/hook.html", "vo", "end", 5000), long)
    expect(fades(shorter)).toEqual([
      ["scenes/hook.html", 500, undefined],
      ["scenes/demo.html", undefined, 1000],
    ])
    // Back in its first scene alone, it fades out there again.
    const back = applied(trimClip(shorter, "scenes/hook.html", "vo", "end", 2000), shorter)
    expect(fades(back)).toEqual([["scenes/hook.html", 500, 1000]])
  })

  // Guard proof: write the sound on the part named alone in setClipSound (edit.ts); the hook's and
  // the outro's parts then play at full volume, and the fade out lands mid-clip. Find no chain in
  // setClipTiming, and the parts after the head play their file as they did, out of step.
  test("sounds, plays from, and reads as one", () => {
    const sound = applied(
      setClipSound(toTwelve, "scenes/demo.html", "intro-2", {
        volume: 0.5,
        fadeInMs: 400,
        fadeOutMs: 800,
      }),
      toTwelve
    )
    const levels = ["scenes/hook.html", "scenes/demo.html", "scenes/outro.html"].map((file) => {
      const clip = readSceneTimeline(sound.get(file) as string)?.clips.find((each) => each.src)
      return [clip?.volume, clip?.fadeInMs, clip?.fadeOutMs]
    })
    expect(levels).toEqual([
      [0.5, 400, undefined],
      [0.5, undefined, undefined],
      [0.5, undefined, 800],
    ])

    const from = applied(
      setClipTiming(toTwelve, "scenes/hook.html", "intro", { mediaStartMs: 500 }),
      toTwelve
    )
    expect(intro(from).map((part) => part[4])).toEqual([500, 3500, 11_500])
  })

  // Guard proof: find no chain in setVideoText (edit.ts); the caption's part in the demo still
  // says what it said.
  test("says the same in each part when its words are typed over", () => {
    const sources = new Map(opening)
    sources.set(
      "scenes/hook.html",
      scene("hook", '<p class="caption" data-start="2" data-duration="2">Hello</p>')
    )
    const continued = applied(trimClip(sources, "scenes/hook.html", "#0", "end", 4000), sources)
    const files = applied(setVideoText(continued, "scenes/hook.html", "text", "Welcome"), continued)
    expect(
      readSceneTimeline(files.get("scenes/demo.html") as string)?.clips.map((clip) => clip.text)
    ).toEqual(["x", "Welcome"])
  })

  /** The chains the video holds, each as its parts' files and refs. */
  const chains = (files: ReadonlyMap<string, string | null>) =>
    videoChains(
      composition(files).scenes,
      (file) => readSceneTimeline(files.get(file) as string) ?? undefined
    ).map((chain) => chain.parts.map((part) => `${part.file}#${part.clip.ref}`))
  const titled = new Map(opening)
  titled.set(
    "scenes/hook.html",
    scene("hook", '<h1 class="title" data-start="0" data-duration="3">Title</h1>')
  )

  /**
   * Whether the opening's recording plays once at every instant, as its chain holds it: its parts
   * never overlap, each plays its file on from where the one before stops as written, and after a
   * placement, from where it stops as seen.
   */
  const playsOnce = (files: ReadonlyMap<string, string | null>, placed = false) => {
    const scenes = composition(files).scenes
    const found = videoChains(
      scenes,
      (file) => readSceneTimeline(files.get(file) as string) ?? undefined
    )
    const chain = found.find((each) => each.parts[0]?.clip.src === "media/a.mp4")
    if (!chain) throw new Error("The recording is in no chain.")
    const seen = chain.parts.map((part) => {
      const scene = scenes.find((each) => each.src === part.file)
      const end = Math.min(part.endMs, scene ? scene.startMs + scene.durationMs : part.endMs)
      return { ...part, seenEnd: end }
    })
    seen.slice(1).forEach((part, index) => {
      const before = seen[index]
      if (!before) return
      expect(part.startMs).toBeGreaterThanOrEqual(before.seenEnd)
      const stops = placed
        ? before.clip.mediaStartMs + before.seenEnd - before.startMs
        : before.clip.mediaStartMs + (before.clip.durationMs ?? 0)
      expect(part.clip.mediaStartMs).toBe(stops)
      if (placed) expect(part.startMs).toBe(before.seenEnd)
    })
    return seen.map((part) => [
      part.file,
      part.clip.ref,
      part.startMs,
      part.seenEnd,
      part.clip.mediaStartMs,
    ])
  }
  /** The opening's recording played to 6 s, over the hook and into the demo. */
  const sixSeconds = applied(trimClip(opening, "scenes/hook.html", "intro", "end", 6000), opening)

  /**
   * Each stretch of the opening's recording as the export plays it, `[file, ref, from, to, media]`
   * in the video, checking that it is heard once: no two stretches at once, none of the file twice
   * (but in a copied scene's own copy), and, as one clip, every one a part of the clip it is, so
   * the next edit moves them all.
   */
  const heardOnce = (
    files: ReadonlyMap<string, string | null>,
    as: "one clip" | "apart" | "copied" = "one clip"
  ) => {
    const scenes = composition(files).scenes
    const heard: { file: string; ref: string; from: number; to: number; media: number }[] = []
    for (const scene of scenes) {
      for (const clip of readSceneTimeline(files.get(scene.src) as string)?.clips ?? []) {
        if (clip.src !== "media/a.mp4" || clip.durationMs === undefined) continue
        const from = scene.startMs + clip.startMs
        const to = Math.min(from + clip.durationMs, scene.startMs + scene.durationMs)
        if (to > from)
          heard.push({ file: scene.src, ref: clip.ref, from, to, media: clip.mediaStartMs })
      }
    }

    const byTime = [...heard].sort((a, b) => a.from - b.from)
    byTime.slice(1).forEach((each, at) => {
      const before = byTime[at] as (typeof heard)[number]
      if (each.from < before.to - 15) {
        throw new Error(`${before.ref} and ${each.ref} play at once: ${JSON.stringify(byTime)}`)
      }
    })
    const chains = videoChains(
      scenes,
      (file) => readSceneTimeline(files.get(file) as string) ?? undefined
    ).filter((chain) => chain.parts[0]?.clip.src === "media/a.mp4")
    const parts = new Set(
      chains.flatMap((chain) => chain.parts.map((part) => `${part.file}#${part.clip.ref}`))
    )

    // A copied scene plays its own copy of the file again; the clip itself, never.
    const byMedia = heard
      .filter((each) => as !== "copied" || parts.has(`${each.file}#${each.ref}`))
      .sort((a, b) => a.media - b.media)
    byMedia.slice(1).forEach((each, at) => {
      const before = byMedia[at] as (typeof heard)[number]
      if (each.media < before.media + before.to - before.from - 15) {
        throw new Error(
          `${before.ref} and ${each.ref} play the file twice: ${JSON.stringify(byMedia)}`
        )
      }
    })

    if (
      as === "one clip" &&
      heard.length > 1 &&
      (chains.length !== 1 || heard.some((each) => !parts.has(`${each.file}#${each.ref}`)))
    ) {
      throw new Error(`The recording is not one clip: ${JSON.stringify(byTime)}`)
    }
    return byTime.map((each) => [each.file, each.ref, each.from, each.to, each.media])
  }

  // Guard proof: judge a recording's part by where the part before it ends in goesOn
  // (timeline.ts), as it did: once the hook is shorter, its end hidden, the chain breaks, and the
  // move writes a second part over the demo's, which plays the recording twice.
  test("a scene made shorter under a clip that goes on keeps it one clip", () => {
    const shorter = applied(setSceneLength(sixSeconds, "hook", 2500), sixSeconds)
    expect(playsOnce(shorter)).toEqual([
      ["scenes/hook.html", "intro", 0, 2500, 0],
      ["scenes/demo.html", "intro-2", 2500, 5500, 3000],
    ])
    const moved = applied(moveClip(shorter, "scenes/hook.html", "intro", 500), shorter)
    expect(playsOnce(moved, true)).toEqual([
      ["scenes/hook.html", "intro", 500, 2500, 0],
      ["scenes/demo.html", "intro-2", 2500, 6000, 2000],
    ])
  })

  // Guard proof: give a clip that goes on the length from its first part's start to its last's
  // end in logicalClip (edit.ts), as it did; the move then keeps the gap the longer hook left,
  // and plays half a second more.
  test("a scene made longer under a clip that goes on keeps it one clip, which a move closes", () => {
    const longer = applied(setSceneLength(sixSeconds, "hook", 3500), sixSeconds)
    expect(playsOnce(longer)).toEqual([
      ["scenes/hook.html", "intro", 0, 3000, 0],
      ["scenes/demo.html", "intro-2", 3500, 6500, 3000],
    ])
    const moved = applied(moveClip(longer, "scenes/hook.html", "intro", 500), longer)
    expect(playsOnce(moved, true)).toEqual([
      ["scenes/hook.html", "intro", 500, 3500, 0],
      ["scenes/demo.html", "intro-2", 3500, 6500, 3000],
    ])
  })

  // Guard proof: drop markCutChains from run (edit.ts); the hook's second piece then goes on from
  // nothing, the demo's part from the first piece across it, and the move plays both at once.
  test("a cut through its first part leaves pieces that go on one from the other, moved as one", () => {
    const cut = applied(
      removeMediaRanges(sixSeconds, "scenes/hook.html", "media/a.mp4", [
        { startMs: 1000, endMs: 1500 },
      ]),
      sixSeconds
    )
    expect(heardOnce(cut)).toEqual([
      ["scenes/hook.html", "intro", 0, 1000, 0],
      ["scenes/hook.html", "intro-3", 1000, 2500, 1500],
      ["scenes/demo.html", "intro-2", 2500, 5500, 3000],
    ])

    // Half a second later, it keeps what was cut out of it, back to back across the edge.
    const moved = applied(moveClip(cut, "scenes/hook.html", "intro", 500), cut)
    expect(heardOnce(moved)).toEqual([
      ["scenes/hook.html", "intro", 500, 1500, 0],
      ["scenes/hook.html", "intro-3", 1500, 2500, 1500],
      ["scenes/demo.html", "intro-2", 2500, 6000, 2500],
    ])
  })

  // Guard proof: require a recording's part to play its file on from the one before in goesOn
  // (timeline.ts), as it did; the demo's part, its first words cut, is then a clip of its own, and
  // moving the head plays the demo's start twice. Cut each placed part only at the scenes' edges
  // in atJumps (edit.ts), and the move plays the cut words again; trim the start without
  // jumpsFrom in trimClip, and the trimmed clip plays them twice. Take the parts of the file named
  // alone in removeMediaRanges, without chainParts, and words across the edge are cut half.
  test("a cut at a later part's start, or across the edge, keeps it one clip that skips there", () => {
    const atStart = applied(
      removeMediaRanges(sixSeconds, "scenes/demo.html", "media/a.mp4", [
        { startMs: 3000, endMs: 3400 },
      ]),
      sixSeconds
    )
    expect(heardOnce(atStart)).toEqual([
      ["scenes/hook.html", "intro", 0, 3000, 0],
      ["scenes/demo.html", "intro-2", 3000, 5600, 3400],
    ])
    const moved = applied(moveClip(atStart, "scenes/hook.html", "intro", 300), atStart)
    expect(heardOnce(moved)).toEqual([
      ["scenes/hook.html", "intro", 300, 3000, 0],
      ["scenes/demo.html", "intro-2", 3000, 3300, 2700],
      ["scenes/demo.html", "intro-3", 3300, 5900, 3400],
    ])

    // Its start trimmed later, it skips at the same words.
    const trimmed = applied(trimClip(atStart, "scenes/hook.html", "intro", "start", 500), atStart)
    expect(heardOnce(trimmed)).toEqual([
      ["scenes/hook.html", "intro", 500, 3000, 500],
      ["scenes/demo.html", "intro-2", 3000, 5600, 3400],
    ])

    // Words across the edge, cut from either file: each part loses its share.
    for (const file of ["scenes/hook.html", "scenes/demo.html"]) {
      const across = applied(
        removeMediaRanges(sixSeconds, file, "media/a.mp4", [{ startMs: 2500, endMs: 3500 }]),
        sixSeconds
      )
      expect(heardOnce(across)).toEqual([
        ["scenes/hook.html", "intro", 0, 2500, 0],
        ["scenes/demo.html", "intro-2", 2500, 5000, 3500],
      ])
    }
  })

  // Guard proof: keep the stretches in the part named alone in keepClipRanges (edit.ts), without
  // chainParts; the hook's part then keeps what the clip no longer holds.
  test("keeps the stretches it is told in every part, as one clip", () => {
    const kept = applied(
      keepClipRanges(sixSeconds, "scenes/demo.html", "intro-2", [{ startMs: 1000, endMs: 5000 }]),
      sixSeconds
    )
    expect(heardOnce(kept)).toEqual([
      ["scenes/hook.html", "intro", 0, 2000, 1000],
      ["scenes/demo.html", "intro-2", 2000, 4000, 3000],
    ])
  })

  // Guard proof: drop markCutChains or settleChains from run (edit.ts), or require a recording's
  // part to play its file on from the one before in goesOn, or prefer no piece beside it in its
  // scene in videoChains (timeline.ts): a step then breaks the clip, or plays a stretch at once
  // with another.
  test("a recording that goes on is heard once, whatever is done to it and its scenes", () => {
    const crossfade = `<div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="15">
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook - 0.5" data-duration="4"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4"></div>
  </div>
`
    let files = new Map<string, string | null>([
      ["index.html", crossfade],
      [
        "scenes/hook.html",
        scene(
          "hook",
          '<video id="v" src="media/a.mp4" data-start="1" data-duration="2" data-has-audio="true" data-fade-in="0.3" data-fade-out="0.5"></video>'
        ),
      ],
      ["scenes/demo.html", scene("demo", '<p data-start="1" data-duration="1">x</p>')],
      ["scenes/outro.html", scene("outro", '<p data-start="1" data-duration="1">y</p>')],
      ["media/a.mp4", null],
    ])
    const heads = () => {
      const head = readSceneTimeline(files.get("scenes/hook.html") as string)?.clips.find(
        (clip) => clip.src === "media/a.mp4"
      )
      if (!head) throw new Error("The recording left the hook.")
      return head
    }
    /** Where the demo's part plays the file from, and to. */
    const demoPart = () => {
      const part = readSceneTimeline(files.get("scenes/demo.html") as string)?.clips.find(
        (clip) => clip.src === "media/a.mp4"
      )
      if (!part?.durationMs) throw new Error("The recording plays in no demo part.")
      return { from: part.mediaStartMs, to: part.mediaStartMs + part.durationMs }
    }
    const steps: [string, () => VideoEditResult | ReadonlyMap<string, string | null>][] = [
      [
        "pulled on over three chapters",
        () => trimClip(files, "scenes/hook.html", "v", "end", 9000),
      ],
      ["a shorter hook", () => setSceneLength(files, "hook", 2600)],
      ["a longer demo", () => setSceneLength(files, "demo", 4700)],
      ["moved", () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 300)],
      [
        "a silence inside the head",
        () =>
          removeMediaRanges(files, "scenes/hook.html", "media/a.mp4", [
            { startMs: 400, endMs: 700, room: { startMs: 350, endMs: 750 } },
          ]),
      ],
      [
        "a filler word just before the edge",
        () =>
          removeMediaRanges(files, "scenes/hook.html", "media/a.mp4", [
            { startMs: demoPart().from - 300, endMs: demoPart().from - 100 },
          ]),
      ],
      [
        "a pause at the demo's start, from its file",
        () =>
          removeMediaRanges(files, "scenes/demo.html", "media/a.mp4", [
            { startMs: demoPart().from, endMs: demoPart().from + 400 },
          ]),
      ],
      [
        "words across the edge, from the hook",
        () =>
          removeMediaRanges(files, "scenes/hook.html", "media/a.mp4", [
            { startMs: demoPart().from - 200, endMs: demoPart().from + 300 },
          ]),
      ],
      [
        "words across the edge, from the demo",
        () =>
          removeMediaRanges(files, "scenes/demo.html", "media/a.mp4", [
            { startMs: demoPart().from - 200, endMs: demoPart().from + 300 },
          ]),
      ],
      [
        "all kept but a stretch of the demo's part",
        () =>
          keepClipRanges(files, "scenes/demo.html", "v-2", [
            { startMs: 0, endMs: demoPart().from + 500 },
            { startMs: demoPart().from + 900, endMs: 60_000 },
          ]),
      ],
      [
        "moved later",
        () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 500),
      ],
      ["a range cut out of the video", () => cutRange(files, { startMs: 4000, endMs: 4600 })],
      [
        "moved sooner",
        () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs - 400),
      ],
      ["the outro first", () => moveScene(files, "outro", 0)],
      ["the outro last again", () => moveScene(files, "outro", 2)],
      [
        "moved again",
        () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 200),
      ],
      ["the demo removed", () => removeScene(files, "demo")],
      [
        "moved over the gap",
        () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 200),
      ],
      [
        "moved over it again",
        () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 200),
      ],
      ["ended in the hook", () => trimClip(files, "scenes/hook.html", heads().ref, "end", 2500)],
      ["pulled on to 12 s", () => trimClip(files, "scenes/hook.html", heads().ref, "end", 12_000)],
    ]
    const play = (
      steps_: typeof steps,
      as: (step: string) => "one clip" | "apart" | "copied" = () => "one clip"
    ) => {
      for (const [step, edit] of steps_) {
        const result = edit()
        if ("error" in result) throw new Error(`${step}: ${result.error}`)
        files = "edit" in result ? applied(result as VideoEditResult, files) : new Map(result)
        try {
          heardOnce(files, as(step))
        } catch (error) {
          throw new Error(`${step}: ${(error as Error).message}`)
        }
      }
    }
    // Played first, the outro's part is apart from the clip until it is last again.
    const outroFirst = steps.findIndex(([step]) => step === "the outro first")
    play(steps.slice(0, outroFirst))
    play(steps.slice(outroFirst, outroFirst + 1), () => "apart")
    play(steps.slice(outroFirst + 1, outroFirst + 2))
    const copyFrom = files
    play(steps.slice(outroFirst + 2))
    expect(heardOnce(files).length).toBeGreaterThan(1)
    const end = files

    // The demo copied between it and the outro: the outro's part, left out, is a clip of its own,
    // and two moves of the head play nothing at once, even into the copy.
    files = copyFrom
    play(
      [
        ["the demo copied", () => duplicateScene(files, "demo")],
        [
          "moved into the copy",
          () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 200),
        ],
        [
          "moved further into it",
          () => moveClip(files, "scenes/hook.html", heads().ref, heads().startMs + 200),
        ],
      ],
      () => "copied"
    )
    files = end

    // Removed with what follows it, the recording is gone.
    const gone = applied(
      removeClip(files, "scenes/hook.html", heads().ref, { ripple: true }),
      files
    )
    expect(heardOnce(gone)).toEqual([])
  })

  // Guard proof: cut placed parts only where a skip leaves a clip's least length either side in
  // atJumps (edit.ts), moving the others to the edge as it did; a move of 50 ms then brings back
  // 50 ms of the cut words, and loses as much of those kept. Keep every piece, however short, and
  // a move of 1 ms writes one a millisecond long. Link a recording's pieces in a scene only as
  // close as an instant in goesOn (timeline.ts), and the two either side of the one left out are
  // two clips.
  test("a skip near a chapter's edge keeps what is heard, however little the move", () => {
    const index = `<div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="15">
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook - 0.5" data-duration="4"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4"></div>
  </div>
`
    let files = new Map<string, string | null>([
      ["index.html", index],
      [
        "scenes/hook.html",
        scene(
          "hook",
          '<video id="v" src="media/a.mp4" data-start="1" data-duration="2" data-has-audio="true"></video>'
        ),
      ],
      ["scenes/demo.html", scene("demo")],
      ["scenes/outro.html", scene("outro")],
      ["media/a.mp4", null],
    ])
    files = applied(trimClip(files, "scenes/hook.html", "v", "end", 9000), files)
    files = applied(
      removeMediaRanges(files, "scenes/demo.html", "media/a.mp4", [{ startMs: 3000, endMs: 3300 }]),
      files
    )
    // Words cut 70 ms before the hook's end.
    files = applied(
      removeMediaRanges(files, "scenes/hook.html", "media/a.mp4", [{ startMs: 1930, endMs: 2200 }]),
      files
    )

    /** What of the file is heard, as merged stretches of it. */
    const heard = (each: ReadonlyMap<string, string | null>) => {
      const stretches = heardOnce(each)
        .map((part) => {
          const [, , from, to, media] = part as [string, string, number, number, number]
          return [media, media + to - from] as [number, number]
        })
        .sort((a, b) => a[0] - b[0])
      const merged: [number, number][] = []
      for (const [from, to] of stretches) {
        const last = merged.at(-1)
        if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
        else merged.push([from, to])
      }
      return merged
    }
    const before = heard(files)
    expect(before).toEqual([
      [0, 1900],
      [2200, 3000],
      [3300, 8000],
    ])
    // Moved, it never plays what was cut, and keeps all it did, but less than a frame at a skip
    // that falls within a frame of a chapter's edge: the cut 70 ms before the hook's end took it
    // to the end, in whole steps, so the skip lies at that edge.
    const frame = 1000 / 30
    for (const by of [10, 50, 99, 120, -10, -50, -99, -120]) {
      const now = heard(applied(moveClip(files, "scenes/hook.html", "v", 1000 + by), files))
      const near = Math.abs(by) < frame
      if (!near) expect([by, now]).toEqual([by, before])
      expect(now).toHaveLength(before.length)
      now.forEach(([from, to], at) => {
        const [wasFrom, wasTo] = before[at] as [number, number]
        expect([by, from >= wasFrom, to <= wasTo]).toEqual([by, true, true])
        expect([by, wasFrom - from + to - wasTo < frame]).toEqual([by, true])
      })
    }

    // Two skips 20 ms apart in the demo, as an Agent may write them: moved, the piece between is
    // left out, and the pieces either side, less than a frame apart, go on one from the other.
    const close = new Map(files)
    close.set(
      "scenes/demo.html",
      scene(
        "demo",
        [
          '<video id="w-2" src="media/a.mp4" data-start="0.5" data-duration="1" data-has-audio="true" data-media-start="2" data-continues="w"></video>',
          '<video id="w-3" src="media/a.mp4" data-start="1.5" data-duration="0.02" data-has-audio="true" data-media-start="3.3" data-continues="w"></video>',
          '<video id="w-4" src="media/a.mp4" data-start="1.52" data-duration="2" data-has-audio="true" data-media-start="3.5" data-continues="w"></video>',
        ].join("\n    ")
      )
    )
    close.set(
      "scenes/hook.html",
      scene(
        "hook",
        '<video id="w" src="media/a.mp4" data-start="1" data-duration="2" data-has-audio="true"></video>'
      )
    )
    close.set("scenes/outro.html", scene("outro"))
    const spaced = applied(moveClip(close, "scenes/hook.html", "w", 1300), close)
    expect(heardOnce(spaced).map((part) => [part[2], part[3], part[4]])).toEqual([
      [1300, 2900, 0],
      [2900, 4200, 1600],
      [4220, 5900, 3500],
      [5900, 6200, 5180],
    ])

    // However little the move, no part it writes is shorter than a frame, and it is one clip.
    for (let by = -40; by <= 40; by += 1) {
      if (by === 0) continue
      const moved = applied(moveClip(files, "scenes/hook.html", "v", 1000 + by), files)
      heardOnce(moved)
      for (const file of ["scenes/hook.html", "scenes/demo.html", "scenes/outro.html"]) {
        for (const clip of readSceneTimeline(moved.get(file) as string)?.clips ?? []) {
          if (clip.src === "media/a.mp4") {
            expect([by, clip.ref, (clip.durationMs ?? 0) >= frame]).toEqual([by, clip.ref, true])
          }
        }
      }
    }
  })

  // Guard proof: drop strandedParts from duplicateScene or removeScene (edit.ts), or the stale-marker
  // sweep from placeFound, and the outro's part, left out, keeps its marker; with none of the three,
  // and a recording let go on past a gap from anywhere in its file in goesOn (timeline.ts), it
  // joins the head's overflow into the copy, and the next move plays the copy's recording twice.
  test("a chapter copied or removed between a clip's parts leaves no part to link again", () => {
    const index = `<div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="15">
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook - 0.5" data-duration="4"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4"></div>
  </div>
`
    const start = new Map<string, string | null>([
      ["index.html", index],
      [
        "scenes/hook.html",
        scene(
          "hook",
          '<video id="v" src="media/a.mp4" data-start="1" data-duration="2" data-has-audio="true"></video>'
        ),
      ],
      ["scenes/demo.html", scene("demo")],
      ["scenes/outro.html", scene("outro")],
      ["media/a.mp4", null],
    ])
    const long = applied(trimClip(start, "scenes/hook.html", "v", "end", 9000), start)
    expect(heardOnce(long).map((part) => part[1])).toEqual(["v", "v-2", "v-3"])

    // The middle chapter removed, the head's, or cut across: one clip, heard once.
    expect(heardOnce(applied(removeScene(long, "demo"), long)).map((part) => part[1])).toEqual([
      "v",
      "v-3",
    ])
    heardOnce(applied(removeScene(long, "hook"), long))
    heardOnce(applied(cutRange(long, { startMs: 4000, endMs: 6000 }), long))

    // Copied, the demo comes between: the outro's part is a clip of its own from then on.
    const copied = applied(duplicateScene(long, "demo"), long)
    const outro = readSceneTimeline(copied.get("scenes/outro.html") as string)?.clips[0]
    expect([outro?.ref, outro?.continues]).toEqual(["v-3", undefined])
    heardOnce(applied(removeScene(copied, "demo"), copied), "copied")

    // A marker the outro's part kept all the same, as an older edit wrote it, goes once the head
    // is placed again without it.
    const kept = new Map(copied)
    kept.set(
      "scenes/outro.html",
      (copied.get("scenes/outro.html") as string).replace('id="v-3"', 'id="v-3" data-continues="v"')
    )
    const placed = applied(moveClip(kept, "scenes/hook.html", "v", 1200), kept)
    expect(readSceneTimeline(placed.get("scenes/outro.html") as string)?.clips[0]?.continues).toBe(
      undefined
    )
    heardOnce(applied(moveClip(placed, "scenes/hook.html", "v", 1400), placed), "copied")

    // A chapter removed after a gap the hook was made longer by: the outro's part plays elsewhere
    // in the file than the head stops, so it goes on from nothing, and lets go of its marker.
    const gap = applied(setSceneLength(long, "hook", 3500), long)
    const apart = applied(removeScene(gap, "demo"), gap)
    expect(readSceneTimeline(apart.get("scenes/outro.html") as string)?.clips[0]?.continues).toBe(
      undefined
    )

    // Moved twice, the head goes on into the copy, over none of its own.
    const once = applied(moveClip(copied, "scenes/hook.html", "v", 1200), copied)
    const twice = applied(moveClip(once, "scenes/hook.html", "v", 1400), once)
    expect(heardOnce(twice, "copied").map((part) => [part[1], part[2], part[3]])).toEqual([
      ["v", 1400, 3000],
      ["v-2", 3000, 6500],
      ["v-5", 6500, 6900],
      ["v-4", 7000, 10_500],
      ["v-3", 10_500, 13_000],
    ])
  })

  // Guard proof: walk the parts once in order in videoChains (timeline.ts), as it did; a stale part
  // the Agent left before the real one breaks the chain there, and the real part is lost from it.
  test("a stale part hides no later one, and a split then a move plays once", () => {
    const stale = new Map(sixSeconds)
    stale.set(
      "scenes/demo.html",
      (sixSeconds.get("scenes/demo.html") as string).replace(
        "<video",
        '<video id="old" src="media/a.mp4" data-start="0" data-duration="1" data-media-start="40" data-continues="intro"></video>\n    <video'
      )
    )
    expect(playsOnce(stale).map((part) => part[1])).toEqual(["intro", "intro-2"])

    const split = splitClip(sixSeconds, "scenes/hook.html", "intro", 1000)
    const second = ("clip" in split ? split.clip : undefined) ?? ""
    const files = applied(split, sixSeconds)
    const moved = applied(moveClip(files, "scenes/hook.html", second, 1500), files)
    expect(playsOnce(moved, true)).toEqual([
      ["scenes/hook.html", second, 1500, 3000, 1000],
      ["scenes/demo.html", "intro-2", 3000, 6500, 2500],
    ])
  })

  // Guard proof: drop the check that the part before ends with its scene from goesOn
  // (timeline.ts), as the gap rule let it; the outro's part then goes on from the hook's across
  // the demo, and moving the head writes a whole title into the demo again.
  test("a part goes on only from the scene just before it, ended with it", () => {
    const long = applied(trimClip(titled, "scenes/hook.html", "#0", "end", 13_000), titled)
    expect(chains(long)).toEqual([
      ["scenes/hook.html#text", "scenes/demo.html#text-2", "scenes/outro.html#text-3"],
    ])

    // Its middle part taken out by hand, the outro's is a clip of its own.
    const gapped = new Map(long)
    gapped.set(
      "scenes/demo.html",
      (long.get("scenes/demo.html") as string).replace(/\n\s*<h1[^\n]*<\/h1>/, "")
    )
    expect(chains(gapped)).toEqual([])
    const moved = applied(moveClip(gapped, "scenes/hook.html", "text", 200), gapped)
    const titles = (file: string) =>
      (readSceneTimeline(moved.get(file) as string)?.clips ?? [])
        .filter((clip) => clip.tag === "h1")
        .map((clip) => [clip.ref, clip.startMs, clip.durationMs])
    expect(titles("scenes/demo.html")).toEqual([["text-2", 0, 200]])
    expect(titles("scenes/outro.html")).toEqual([["text-3", 0, 2000]])
  })

  // Guard proof: rename only recordings in copySceneFile (edit.ts), as it did, and keep its
  // `data-continues`; the copied demo's title joins the chain, stretches when the head moves, and
  // goes when the head goes. Let an id written twice head a chain in videoChains (timeline.ts),
  // and the part goes on from whichever title the Agent gave that id.
  test("a copied scene's clips are its own: none goes on from the original's", () => {
    const continued = applied(trimClip(titled, "scenes/hook.html", "#0", "end", 5000), titled)
    const copied = applied(duplicateScene(continued, "demo"), continued)
    expect(copied.get("scenes/demo-2.html")).not.toContain("data-continues")
    expect(copied.get("scenes/demo-2.html")).toContain('id="text-3"')
    expect(chains(copied)).toEqual([["scenes/hook.html#text", "scenes/demo.html#text-2"]])

    const moved = applied(moveClip(copied, "scenes/hook.html", "text", 500), copied)
    expect(moved.get("scenes/demo-2.html")).toBe(copied.get("scenes/demo-2.html"))
    const gone = applied(removeClip(copied, "scenes/hook.html", "text"), copied)
    expect(gone.get("scenes/demo-2.html")).toBe(copied.get("scenes/demo-2.html"))

    // Two titles the Agent gave one id, each ending with the hook: neither heads the part that
    // names it, as either could be the one it went on from.
    const twice = new Map(continued)
    twice.set(
      "scenes/hook.html",
      (continued.get("scenes/hook.html") as string).replace(
        "</h1>",
        '</h1>\n    <h1 class="title" id="text" data-start="2" data-duration="1">Title</h1>'
      )
    )
    expect(chains(twice)).toEqual([])

    // The head's own scene copied: its title takes an id of its own, and the copy, now between
    // the hook and the demo, ends the chain: the demo's part plays on its own.
    const hooks = applied(duplicateScene(continued, "hook"), continued)
    expect(hooks.get("scenes/hook-2.html")).toContain('id="text-3"')
    expect(chains(hooks)).toEqual([])
  })

  // Guard proof: read a chained start's name lazily, up to a `-`, in copySceneFile (edit.ts), as
  // its lookahead let it; the follower of `talk-2` then follows `talk-3-2`. Rename in a style's
  // declarations too, and the colour `#fade` becomes `#fade-2`; in a script's property values, and
  // so does GSAP's; leave `[id=…]` as it is, and it still names the original.
  test("a copied scene renames ids by their whole name, where they are selectors alone", () => {
    const sources = new Map(opening)
    sources.set(
      "scenes/demo.html",
      scene(
        "demo",
        `<video id="talk" src="media/a.mp4" data-start="0" data-duration="2"></video>
    <video id="talk-2" src="media/a.mp4" data-start="2" data-duration="4" data-media-start="2"></video>
    <p id="fade" class="c" data-start="talk-2 + 0.5" data-duration="1" style="color: #fade">hi</p>
    <style>[data-composition-id="demo"] .c { color: #fade; background: #FADE; } [id="talk"], #fade { opacity: 1 } @media (min-width: 1px) { #talk-2 { margin: 0 } }</style>
    <script>gsap.to(\`[data-composition-id="demo"] #talk\`, { color: "#fade" }); document.querySelector('#fade'); document.getElementById("talk")</script>`
      )
    )
    const copy = applied(duplicateScene(sources, "demo"), sources).get("scenes/demo-2.html") ?? ""
    expect(copy).toContain(
      '<p id="fade-2" class="c" data-start="talk-4 + 0.5" data-duration="1" style="color: #fade">'
    )
    expect(copy).toContain(
      '<style>[data-composition-id="demo-2"] .c { color: #fade; background: #FADE; } [id="talk-3"], #fade-2 { opacity: 1 } @media (min-width: 1px) { #talk-4 { margin: 0 } }</style>'
    )
    expect(copy).toContain(
      '<script>gsap.to(`[data-composition-id="demo-2"] #talk-3`, { color: "#fade" }); document.querySelector(\'#fade-2\'); document.getElementById("talk-3")</script>'
    )
  })

  // Guard proof: rename no chained start in copySceneFile (edit.ts); the copy's caption then
  // follows nothing. A carried look is keyed by data-look, which a copy keeps as it is.
  test("a copied scene's looks and chained starts follow its new ids", () => {
    const sources = new Map(opening)
    sources.set(
      "scenes/outro.html",
      scene(
        "outro",
        `<p id="cap" class="caption" data-look="k1" data-start="0" data-duration="1">Hi</p>
    <p id="after" data-start="cap + 0.5" data-duration="1">there</p>
    <style data-look="k1" data-from="demo">
      [data-composition-id="outro"] .caption:is([data-look="k1"], #sixb-look) { color: yellow; }
      [data-composition-id="outro"] #cap { font-size: 30px; }
    </style>
    <script>document.getElementById("cap")</script>`
      )
    )
    const copy = applied(duplicateScene(sources, "outro"), sources).get("scenes/outro-2.html") ?? ""
    expect(copy).toContain('<p id="cap-2" class="caption" data-look="k1"')
    expect(copy).toContain('data-start="cap-2 + 0.5"')
    expect(copy).toContain('<style data-look="k1" data-from="demo">')
    expect(copy).toContain(
      '[data-composition-id="outro-2"] .caption:is([data-look="k1"], #sixb-look) { color: yellow; }'
    )
    expect(copy).toContain('[data-composition-id="outro-2"] #cap-2 { font-size: 30px; }')
    expect(copy).toContain('getElementById("cap-2")')
  })

  // Guard proof: place each part from where its clip starts in its file, ignoring its jumps, in
  // placeFound (edit.ts); the move then plays the head's stretch on where the Agent skipped to 40 s.
  // Keep the marker on a part placed alone, and the orphan still names a head it no longer has.
  test("a part the Agent points elsewhere in the file skips there, and one whose head is gone is a clip of its own", () => {
    // The Agent played another stretch of the file in the demo's part: half a second later, the
    // head plays on into the demo, then skips to 40 s as before.
    const edited = new Map(toFive)
    edited.set(
      "scenes/demo.html",
      (toFive.get("scenes/demo.html") as string).replace(
        'data-media-start="3"',
        'data-media-start="40"'
      )
    )
    const moved = applied(moveClip(edited, "scenes/hook.html", "intro", 500), edited)
    expect(intro(moved)).toEqual([
      ["scenes/hook.html", "intro", 500, 2500, 0, undefined],
      ["scenes/demo.html", "intro-2", 0, 500, 2500, "intro"],
      ["scenes/demo.html", "intro-3", 500, 2000, 40_000, "intro"],
    ])

    // The head gone, its part moves alone, and no longer names it.
    const orphan = new Map(toFive)
    orphan.set("scenes/hook.html", scene("hook"))
    const alone = applied(moveClip(orphan, "scenes/demo.html", "intro-2", 1000), orphan)
    expect(intro(alone)).toEqual([["scenes/demo.html", "intro-2", 1000, 2000, 3000, undefined]])
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
    // 1–2 s into the demo: talk is split around it, the first caption loses its middle.
    const files = applied(cutRange(SOURCES, { startMs: 3500, endMs: 4500 }))

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

  // Guard proof: cut only the share of the first scene the range meets in cutRange; the outro
  // keeps its first second.
  test("a range across scenes cuts each scene's share, and a scene it covers whole goes", () => {
    // From 1 s before the demo ends to 1 s into the outro: the demo loses its last second, the
    // outro its first, and the video two seconds.
    const across = applied(cutRange(SOURCES, { startMs: 9500, endMs: 11_500 }))
    expect(times(across)).toEqual([
      ["hook", 0, 3000],
      ["demo", 2500, 7000],
      ["outro", 9500, 3500],
    ])
    expect(composition(across).durationMs).toBe(13_000)

    // From 1 s into the hook to 1 s into the outro: the demo goes, and the outro takes its place
    // after the hook, its crossfade included.
    const covered = applied(cutRange(SOURCES, { startMs: 1000, endMs: 11_500 }))
    expect(times(covered)).toEqual([
      ["hook", 0, 1500],
      ["outro", 1000, 3500],
    ])
    expect(covered.has("scenes/demo.html")).toBe(false)

    expect(cutRange(SOURCES, { startMs: 0, endMs: 15_000 })).toEqual({
      error: "A video keeps at least one scene.",
    })
  })

  // The talk as a cut of its file leaves it: where its first part ends, where its second starts
  // in the file.
  const cutTalk = (sources: VideoSources, cut: VideoCut) => {
    const files = applied(
      removeMediaRanges(sources, "scenes/demo.html", "media/talk.mp4", [cut]),
      sources
    )
    const [first, second] = demoClips(files)
    return { files, endMs: first?.durationMs, resumesAt: second?.mediaStartMs }
  }
  const at24 = new Map(SOURCES).set("index.html", INDEX.replace('data-fps="30"', 'data-fps="24"'))

  // Guard proof: cut the spans as merged in rippleRemove, and the demo loses 40 ms; let
  // frameStepMs return one frame, and it loses 33.33 ms, written as 33: the outro then starts a
  // third of a millisecond into a frame.
  test("a cut takes whole frame steps, so the scenes after move by whole frames", () => {
    // A 40 ms word of the talk, at 30 fps: three frames, 100 ms, as much on each side.
    const { files, endMs, resumesAt } = cutTalk(SOURCES, { startMs: 3500, endMs: 3540 })
    expect(times(files)).toEqual([
      ["hook", 0, 3000],
      ["demo", 2500, 7900],
      ["outro", 10_400, 4500],
    ])
    expect([endMs, resumesAt]).toEqual([1470, 3570])

    // At 24 fps, three frames are 125 ms, and a scene's length is the nearest number of them.
    expect(times(cutTalk(at24, { startMs: 3500, endMs: 3540 }).files)[2]).toEqual([
      "outro",
      10_375,
      4500,
    ])
    expect(times(applied(setSceneLength(at24, "demo", 8200), at24))[1]).toEqual([
      "demo",
      2500,
      8250,
    ])
  })

  // Guard proof: round each stretch to the nearest number of steps in growToSteps rather than up,
  // and 27 ms of the "um" is heard on either side of a 125 ms cut.
  test("a cut grows to whole frames around what it removes, never into it", () => {
    // An "um" of 180 ms, 1.5 s into the talk, at 24 fps: two steps, 250 ms, 35 ms on each side.
    const { endMs, resumesAt } = cutTalk(at24, { startMs: 3500, endMs: 3680 })
    expect([endMs, resumesAt]).toEqual([1465, 3715])
  })

  // Guard proof: grow every cut as much on each side in growToSteps, its room aside, and the cut
  // takes 20 ms of the word before it.
  test("a cut grows into the pauses beside it before any word kept", () => {
    // 40 ms, with 10 ms of pause before it and 160 ms after: 10 ms before, 50 ms after.
    const { endMs, resumesAt } = cutTalk(SOURCES, {
      startMs: 3500,
      endMs: 3540,
      room: { startMs: 3490, endMs: 3700 },
    })
    expect([endMs, resumesAt]).toEqual([1490, 3590])
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
    const files = applied(cutRange(chained, { startMs: 3500, endMs: 4500 }), chained)
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

  test("a scene moved rewrites only the starts that change, each host on its own line", () => {
    const result = moveScene(SOURCES, "outro", 0)

    // The poster, in the outro, goes with it; the outro starts at 0, and the hook after it.
    expect(inserted(result)).toEqual([
      ' data-poster="1.5"',
      ' data-start="outro"',
      ' data-start="0"',
    ])
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

  // Guard proof: drop joinStrays from settleChains (edit.ts), or settle only once scenes moved in
  // run; the part one person added then names the head the other's cut took away, and stays a clip
  // of its own after the next edit.
  test("one person cutting a clip's words while another pulls it on leave one clip, next edit", () => {
    const index = `<div data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="20">
    <div id="hook" data-composition-id="hook" data-composition-src="scenes/hook.html" data-start="0" data-duration="3"></div>
    <div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="hook" data-duration="4"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo" data-duration="4"></div>
    <div id="end" data-composition-id="end" data-composition-src="scenes/end.html" data-start="outro" data-duration="4"></div>
  </div>
`
    const scene = (id: string, inner = "") =>
      `<template>\n  <div data-composition-id="${id}" data-width="1920" data-height="1080">\n    ${inner}\n  </div>\n</template>\n`
    const start = new Map<string, string | null>([
      ["index.html", index],
      [
        "scenes/hook.html",
        scene(
          "hook",
          '<video id="v" src="media/a.mp4" data-start="1" data-duration="2" data-has-audio="true"></video>'
        ),
      ],
      [
        "scenes/demo.html",
        scene("demo", '<p class="caption" data-start="1" data-duration="1">Hi</p>'),
      ],
      ["scenes/outro.html", scene("outro")],
      ["scenes/end.html", scene("end")],
      ["media/a.mp4", null],
    ])
    // The recording from the hook into the middle of the outro.
    const base = applied(trimClip(start, "scenes/hook.html", "v", "end", 9000), start)
    const one = createArtifactDocument("video", live(base))
    const two = new Y.Doc()
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    // One person cuts the hook's words away, so the demo's part heads the clip; the other pulls it
    // on into the end card, from the files before the cut.
    editDocument(
      one,
      removeMediaRanges(sourcesOf(one), "scenes/hook.html", "media/a.mp4", [
        { startMs: 0, endMs: 2000 },
      ])
    )
    editDocument(two, trimClip(sourcesOf(two), "scenes/hook.html", "v", "end", 13_000))
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))
    const merged = sourcesOf(one)
    expect(sourcesOf(two)).toEqual(merged)
    const parts = (files: VideoSources) =>
      videoChains(composition(files).scenes, (file) =>
        typeof files.get(file) === "string"
          ? (readSceneTimeline(files.get(file) as string) ?? undefined)
          : undefined
      ).map((chain) => chain.parts.map((part) => part.file))
    expect(parts(merged)).toEqual([["scenes/demo.html", "scenes/outro.html"]])

    // The next edit of a file holding one of its parts makes it one clip again.
    const caption = demoClips(merged).find((clip) => clip.text === "Hi")
    if (!caption) throw new Error("No caption in the demo.")
    const next = applied(
      setClipTiming(merged, "scenes/demo.html", videoTarget(caption), { startMs: 1500 }),
      merged
    )
    expect(parts(next)).toEqual([["scenes/demo.html", "scenes/outro.html", "scenes/end.html"]])
  })

  // Guard proof: write a look the outro holds already only once, as before, in placeFound
  // (edit.ts), without writeWhole; the merge then keeps the caption carried in and loses the look
  // the other person removed with their last caption. Write it as a change of its own beside the
  // caption inserted just before it in wholeAgain, and the version's own reading of the edit puts
  // the caption inside the look. Keep every copy of a look in pruneLooks, and two people carrying
  // it in at once leave it twice.
  test("a look one person carries in while another takes its last clip out stays, once", () => {
    const sources = new Map(SOURCES)
    sources.set(
      "scenes/demo.html",
      DEMO.replace(
        "<script>",
        `<style>
      [data-composition-id="demo"] .caption { color: #ffd166; }
    </style>
    <script>`
      )
    )
    const inDemo = (files: VideoSources, words: string) => {
      const found = demoClips(files).find((clip) => clip.text === words)
      if (!found) throw new Error(`No "${words}" in the demo.`)
      return videoTarget(found)
    }
    const inOutro = (files: VideoSources, words: string) => {
      const found = outroClips(files).find((clip) => clip.text === words)
      if (!found) throw new Error(`No "${words}" in the outro.`)
      return videoTarget(found)
    }
    const looks = (files: VideoSources) =>
      (files.get("scenes/outro.html") as string).match(/<style data-look="/g)?.length ?? 0
    const styled = (files: VideoSources, words: string) =>
      new RegExp(`data-look="([^"]+)">${words}<`).exec(
        files.get("scenes/outro.html") as string
      )?.[1]

    // One caption in the outro, with its look.
    const base = applied(
      moveClip(sources, "scenes/demo.html", inDemo(sources, "Assign the nearest tech"), 8500),
      sources
    )
    const one = createArtifactDocument("video", live(base))
    const two = new Y.Doc()
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    // One person takes it home, its look with it; the other brings the other caption, alike.
    editDocument(
      one,
      moveClip(sourcesOf(one), "scenes/outro.html", inOutro(base, "Assign the nearest tech"), -7500)
    )
    const brought = moveClip(
      sourcesOf(two),
      "scenes/demo.html",
      inDemo(base, "in two taps"),
      10_500
    )
    editDocument(two, brought)
    // The look written whole again reads the same however the edit is applied.
    expect(sourcesOf(two)).toEqual(applied(brought, base))
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))
    const merged = sourcesOf(one)
    expect(sourcesOf(two)).toEqual(merged)
    const key = styled(merged, "in two taps")
    expect(key).toBeDefined()
    expect(merged.get("scenes/outro.html")).toContain(`<style data-look="${key}"`)
    expect(looks(merged)).toBe(1)

    // Both bring a caption at once: the look is written twice, and the next edit keeps it once.
    const three = createArtifactDocument("video", live(sources))
    const four = new Y.Doc()
    Y.applyUpdate(four, Y.encodeStateAsUpdate(three))
    editDocument(
      three,
      moveClip(
        sourcesOf(three),
        "scenes/demo.html",
        inDemo(sources, "Assign the nearest tech"),
        8500
      )
    )
    editDocument(
      four,
      moveClip(sourcesOf(four), "scenes/demo.html", inDemo(sources, "in two taps"), 10_500)
    )
    Y.applyUpdate(three, Y.encodeStateAsUpdate(four))
    const twice = sourcesOf(three)
    expect(looks(twice)).toBe(2)
    const home = applied(
      moveClip(twice, "scenes/outro.html", inOutro(twice, "Assign the nearest tech"), -7500),
      twice
    )
    expect(looks(home)).toBe(1)
    expect(styled(home, "in two taps")).toBe(key)
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

  // Guard proof: move the host's line in moveScene, as before. The outro's line is then deleted
  // whole, the other person's ` data-duration="2"` stays alone between the hosts, and the root,
  // 12.5 s long, ends before the demo does.
  for (const order of ["mover first", "trimmer first"] as const) {
    test(`a scene moved while someone trims it keeps the trim, merged ${order}`, () => {
      const one = createArtifactDocument("video", live(SOURCES))
      const two = new Y.Doc()
      Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

      editDocument(one, moveScene(sourcesOf(one), "outro", 0))
      editDocument(two, setSceneLength(sourcesOf(two), "outro", 2000))
      const [first, second] = order === "mover first" ? [one, two] : [two, one]
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
      Y.applyUpdate(first, Y.encodeStateAsUpdate(second))

      const files = sourcesOf(one)
      expect(sourcesOf(two)).toEqual(files)
      expect(times(files)).toEqual([
        ["outro", 0, 2000],
        ["hook", 2000, 3000],
        ["demo", 4500, 8000],
      ])
      expect(composition(files).durationMs).toBe(12_500)
    })
  }
})
