import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactMediaResponse } from "@sixb/client"
import {
  type LiveFiles,
  readVideoComposition,
  readVideoFileTimeline,
  setSceneLength,
  splitClip,
} from "@sixb/core/artifacts/live"
import { TooltipProvider } from "@sixb/ui/components"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import * as Y from "yjs"
import { createArtifactDocument } from "../../core/src/artifacts/live/document"
import { frameLinkKey } from "../src/artifacts/frame"
import { LiveArtifact } from "../src/artifacts/live/session"
import { LiveVideo } from "../src/artifacts/live/video"
import VideoEditor from "../src/artifacts/renderers/video/editor/editor"
import { importKind } from "../src/artifacts/renderers/video/editor/import"
import {
  formatSeconds,
  Inspector,
  parseSeconds,
  SecondsField,
  TextField,
} from "../src/artifacts/renderers/video/editor/inspector"
import {
  type MediaParts,
  type MediaTarget,
  pollAgainIn,
  readMediaParts,
  useMediaParts,
} from "../src/artifacts/renderers/video/editor/media"
import {
  editPoints,
  groupDelta,
  inRectangle,
  layClips,
  nextEditPoint,
  openingSeek,
  rulerSteps,
  sceneSpans,
  snapMove,
  snapTo,
  trackRows,
  zoomAround,
} from "../src/artifacts/renderers/video/editor/model"
import { RenameField, SceneBlock } from "../src/artifacts/renderers/video/editor/scenes"
import {
  everySceneClips,
  heardRecordings,
  laidClips,
} from "../src/artifacts/renderers/video/editor/selection"
import { Timeline } from "../src/artifacts/renderers/video/editor/timeline"
import {
  fillers,
  findWords,
  isFiller,
  rangesLength,
  readTranscript,
  silences,
  type TranscriptWord,
  wordAt,
  wordsCut,
} from "../src/artifacts/renderers/video/editor/transcript"
import {
  TranscriptPanel,
  TranscriptTab,
} from "../src/artifacts/renderers/video/editor/transcript-panel"
import { appleKeyboard } from "../src/artifacts/renderers/video/keys"
import { artifactVersion } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "location",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "HTMLImageElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "MessageEvent",
  "FocusEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

afterEach(cleanup)

// Radix picks its layout effect when it loads, a no-op without a `document`, and its menus then
// never mount. It is given React's own for this file, and its own back after.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const originalConfig = client.getConfig()
afterEach(() => client.setConfig({ fetch: originalConfig.fetch }))
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

// The video editor: the timeline's arithmetic, editing by the transcript, the live video the editor
// reads and changes, and the pieces readers touch first.

/** Two scenes: a title, then an interview over a recording, its lines captioned. */
const INDEX = `<div data-composition-id="main" data-width="1280" data-height="720" data-duration="10">
  <audio id="score" src="media/score.m4a" data-start="0" data-duration="10"></audio>
  <div id="title" data-composition-id="title" data-composition-src="scenes/title.html" data-start="0" data-duration="3" data-label="Title"></div>
  <div id="talk" data-composition-id="talk" data-composition-src="scenes/talk.html" data-start="title" data-duration="7" data-label="Interview"></div>
</div>`

const TITLE = `<template>
  <div data-composition-id="title" data-width="1280" data-height="720">
    <h1>Calmer operations</h1>
  </div>
</template>`

const TALK = `<template>
  <div data-composition-id="talk" data-width="1280" data-height="720">
    <video id="clip" src="media/talk.mp4" data-start="0" data-duration="7" data-media-start="1" data-has-audio="true"></video>
    <p class="caption" data-start="0.5" data-duration="2">Thanks for having me.</p>
  </div>
</template>`

const ref = (path: string) =>
  ({ blobId: path, digest: `sha256:${path}`, sizeBytes: 1, mediaType: "video/mp4" }) as never

const FILES: LiveFiles = new Map([
  ["index.html", { text: INDEX }],
  ["scenes/title.html", { text: TITLE }],
  ["scenes/talk.html", { text: TALK }],
  ["media/score.m4a", { file: ref("media/score.m4a") }],
  ["media/talk.mp4", { file: ref("media/talk.mp4") }],
])

const composition = () => {
  const read = readVideoComposition(INDEX, (path) =>
    path === "scenes/title.html" ? TITLE : path === "scenes/talk.html" ? TALK : undefined
  )
  if ("error" in read) throw new Error(read.error)
  return read.composition
}

describe("the timeline's arithmetic", () => {
  test("an edge snaps to the nearest target within reach, and stays put beyond it", () => {
    expect(snapTo(1010, [0, 1000, 1030], 40)).toEqual({ ms: 1000, target: 1000 })
    expect(snapTo(1100, [0, 1000], 40)).toEqual({ ms: 1100 })
  })

  test("a moved clip lands whichever of its edges is nearer a target", () => {
    // Its end, at 3020, is 20 from 3000; its start, at 1020, 70 from 950.
    expect(snapMove(1020, 2000, [950, 3000], 100)).toEqual({ startMs: 1000, target: 3000 })
    expect(snapMove(980, 2000, [950, 3500], 100)).toEqual({ startMs: 950, target: 950 })
    expect(snapMove(1500, 2000, [0], 100)).toEqual({ startMs: 1500 })
  })

  // Guard proof: start each span at its scene's own start in sceneSpans; the interview then
  // starts under the opening's end, and covers it.
  test("two scenes that cross lie apart, their crossfade between them", () => {
    expect(
      sceneSpans([
        { startMs: 0, endMs: 5000 },
        { startMs: 4500, endMs: 20_000 },
        { startMs: 20_000, endMs: 24_000 },
      ])
    ).toEqual([
      { startMs: 0, endMs: 4500, crossfade: { startMs: 4500, endMs: 5000 } },
      { startMs: 5000, endMs: 20_000 },
      { startMs: 20_000, endMs: 24_000 },
    ])
  })

  // Guard proof: scroll to `atMs * pxPerSecond` in zoomAround, without the anchor; the instant
  // under the pointer then slides away.
  test("zooming keeps the instant under the pointer where it is", () => {
    const before = { pxPerSecond: 100, scrollLeft: 300 }
    const after = zoomAround(before, 2, 200)
    const atBefore = (before.scrollLeft + 200) / before.pxPerSecond
    const atAfter = (after.scrollLeft + 200) / after.pxPerSecond
    expect(after.pxPerSecond).toBe(200)
    expect(atAfter).toBeCloseTo(atBefore, 6)
  })

  // Guard proof: give every track the first row free in onRows (model.ts), as sounds take it;
  // the end card's title, which paints over the footage still playing, then lies under it.
  test("clips that overlap lie on rows of their own, what paints over another above it", () => {
    const timeline = {
      composition: { element: { start: 0, end: 0 }, tag: { start: 0, end: 0 }, attributes: {} },
      texts: [],
      clips: [
        { ref: "a", track: "picture", startMs: 0, durationMs: 2000 },
        { ref: "b", track: "picture", startMs: 1000, durationMs: 2000 },
        { ref: "c", track: "picture", startMs: 2500, durationMs: 1000 },
        { ref: "d", track: "sound", startMs: 0 },
        { ref: "e", track: "sound", startMs: 0, durationMs: 1000 },
        { ref: "f", track: "sound", startMs: 1500, durationMs: 1000 },
      ],
    } as never
    const laid = layClips(timeline, "scenes/a.html", 4000, 9000)
    // c paints over b, which still plays: it lies above it, though a has ended under it. Sounds
    // stack nothing: f takes the row e has left.
    expect(
      laid.map((clip) => [clip.clip.ref, clip.startMs, clip.endMs, clip.row, clip.open])
    ).toEqual([
      ["a", 4000, 6000, 0, false],
      ["b", 5000, 7000, 1, false],
      ["c", 6500, 7500, 2, false],
      ["d", 4000, 9000, 0, true],
      ["e", 4000, 5000, 1, false],
      ["f", 5500, 6500, 1, false],
    ])
    expect(trackRows(laid)).toEqual({ picture: 3, text: 1, sound: 2 })
  })

  // Reproduce by laying each clip its whole length: footage of 5.8 s in a scene trimmed to 5.15 s
  // then draws over the start of the next scene.
  test("a clip longer than its scene ends where the scene does", () => {
    const timeline = {
      composition: { element: { start: 0, end: 0 }, tag: { start: 0, end: 0 }, attributes: {} },
      texts: [],
      clips: [{ ref: "footage", track: "picture", startMs: 0, durationMs: 5800 }],
    } as never
    const [footage] = layClips(timeline, "scenes/case.html", 4000, 9150)
    expect(footage).toMatchObject({ startMs: 4000, endMs: 9150, open: false })
  })

  test("the arrows jump between every scene's and clip's edges", () => {
    const points = editPoints(composition(), [])
    expect(points).toEqual([0, 3000, 10_000])
    expect(nextEditPoint(points, 0, 1)).toBe(3000)
    expect(nextEditPoint(points, 3000, -1)).toBe(0)
    expect(nextEditPoint(points, 10_000, 1)).toBeUndefined()
  })

  // Guard proof: seek to `scene.startMs` in `openingSeek` (model.ts); a scene starting between two
  // frames opens on the frame before it, the scene before's last.
  test("opening a scene goes to its first frame, unless the playhead is in it already", () => {
    const scene = { startMs: 5510, durationMs: 1490 }

    expect(openingSeek(scene, 0, 30)).toBe((166 / 30) * 1000)
    expect(openingSeek(scene, (165 / 30) * 1000, 30)).toBe((166 / 30) * 1000)
    expect(openingSeek(scene, 7000, 30)).toBe((166 / 30) * 1000)
    expect(openingSeek(scene, 6000, 30)).toBeUndefined()
  })

  // Guard proof: return `deltaMs` alone from groupDelta in model.ts; the caption is dragged 1.5 s
  // into the scene before its own, and the group apart.
  test("clips dragged together go only as far as the first to reach its composition's start", () => {
    const group = [
      { startMs: 3500, floorMs: 3000 },
      { startMs: 6000, floorMs: 3000 },
      { startMs: 1000, floorMs: 0 },
    ]
    expect(groupDelta(group, -2000)).toBe(-500)
    expect(groupDelta(group, -200)).toBe(-200)
    expect(groupDelta(group, 4000)).toBe(4000)
  })

  // Guard proof: compare the times alone in inRectangle in model.ts; the soundtrack under the
  // rectangle's span, two tracks below it, is selected too.
  test("a selection rectangle takes each clip whose time and row it crosses, drawn either way", () => {
    const boxes = [
      { clip: "footage", startMs: 3000, endMs: 10_000, top: 2, height: 40 },
      { clip: "caption", startMs: 3500, endMs: 5500, top: 46, height: 22 },
      { clip: "score", startMs: 0, endMs: 10_000, top: 108, height: 32 },
    ]
    expect(inRectangle(boxes, { ms: 4000, y: 10 }, { ms: 5000, y: 50 })).toEqual([
      "footage",
      "caption",
    ])
    expect(inRectangle(boxes, { ms: 5000, y: 50 }, { ms: 4000, y: 10 })).toEqual([
      "footage",
      "caption",
    ])
    expect(inRectangle(boxes, { ms: 6000, y: 50 }, { ms: 9000, y: 60 })).toEqual([])
  })

  test("the ruler leaves room for its labels at every zoom", () => {
    for (const zoom of [2, 20, 100, 640]) {
      const { major } = rulerSteps(zoom)
      expect((major / 1000) * zoom).toBeGreaterThanOrEqual(72)
    }
  })
})

describe("editing by the transcript", () => {
  const WORDS: TranscriptWord[] = [
    { text: "So,", startMs: 100, endMs: 400 },
    { text: "um,", startMs: 800, endMs: 1000 },
    { text: "thanks", startMs: 1300, endMs: 1600 },
    { text: "for", startMs: 1650, endMs: 1800 },
    { text: "coming.", startMs: 1850, endMs: 2300 },
    { text: "Right.", startMs: 4000, endMs: 4400 },
  ]
  const BOUNDS = { startMs: 0, endMs: 5000 }

  test("cutting words takes the pause before them, and leaves air beside the words kept", () => {
    // "um,": from 120 ms after "So," ends to 120 ms before "thanks" starts. Growing to whole
    // frames, the cut may take the rest of the pauses, up to the words either side.
    expect(wordsCut(WORDS, 1, 1, BOUNDS)).toEqual({
      startMs: 520,
      endMs: 1180,
      room: { startMs: 400, endMs: 1300 },
    })
    // Words closer than twice the air split the pause between them.
    expect(wordsCut(WORDS, 3, 3, BOUNDS)).toEqual({
      startMs: 1625,
      endMs: 1825,
      room: { startMs: 1600, endMs: 1850 },
    })
  })

  test("a cut never reaches into a word kept, and lands on a cut of the picture nearby", () => {
    const cut = wordsCut(WORDS, 1, 1, BOUNDS, [500])
    expect(cut).toMatchObject({ startMs: 500, endMs: 1180 })
    // A picture cut inside a word kept is no place to land.
    expect(wordsCut(WORDS, 1, 1, BOUNDS, [300])).toMatchObject({ startMs: 520, endMs: 1180 })
  })

  test("the first and last words cut to the ends of the clip", () => {
    expect(wordsCut(WORDS, 0, 0, BOUNDS)).toMatchObject({ startMs: 0, endMs: 680 })
    expect(wordsCut(WORDS, 5, 5, BOUNDS)).toMatchObject({ startMs: 2420, endMs: 5000 })
  })

  test("silences longer than a breath are shortened to the air either side", () => {
    expect(silences(WORDS, BOUNDS)).toEqual([
      { startMs: 2420, endMs: 3880, room: { startMs: 2300, endMs: 4000 } },
      { startMs: 4520, endMs: 5000, room: { startMs: 4400, endMs: 5000 } },
    ])
  })

  test("filler words are found whatever their case and punctuation", () => {
    expect(isFiller("Um,")).toBe(true)
    expect(isFiller("euh…")).toBe(true)
    expect(isFiller("umbrella")).toBe(false)
    expect(fillers(WORDS, BOUNDS)).toMatchObject([{ startMs: 520, endMs: 1180 }])
  })

  test("words are found, in a row, whatever their case and accents", () => {
    expect(findWords(WORDS, "THANKS for")).toEqual([2])
    expect(findWords(WORDS, "right")).toEqual([5])
    expect(findWords(WORDS, "  ")).toEqual([])
  })

  test("the word said at an instant, and what ranges last together", () => {
    expect(wordAt(WORDS, 50)).toBe(-1)
    expect(wordAt(WORDS, 900)).toBe(1)
    expect(wordAt(WORDS, 3000)).toBe(4)
    expect(
      rangesLength([
        { startMs: 0, endMs: 100 },
        { startMs: 50, endMs: 200 },
        { startMs: 500, endMs: 600 },
      ])
    ).toBe(300)
  })
})

describe("a transcript timed by phrase", () => {
  // Guard proof: return `timing: "words"` from readTranscript whatever it reads; the whole text,
  // one entry, then reads as one word, and cutting it cuts everything.
  test("a model that times the whole text as one entry gives phrases, never words", () => {
    const whole = { text: "So, um, thanks for having me.", startMs: 0, endMs: 9000 }
    expect(readTranscript({ text: whole.text, words: [whole] })).toEqual({
      words: [whole],
      timing: "phrases",
    })
  })

  test("its sentences are taken when they are finer than its words", () => {
    const read = readTranscript({
      words: [{ text: "So, um, thanks for having me. I should start.", startMs: 0, endMs: 6000 }],
      segments: [
        { text: "So, um, thanks for having me.", startMs: 0, endMs: 2500 },
        { text: "I should start.", startMs: 3000, endMs: 6000 },
      ],
    })
    expect(read.timing).toBe("phrases")
    expect(read.words.map((phrase) => phrase.text)).toEqual([
      "So, um, thanks for having me.",
      "I should start.",
    ])
  })

  test("words timed one by one stay words, a name of two aside", () => {
    const words = [
      "Dana Reyes",
      "runs",
      "field",
      "service",
      "teams",
      "for",
      "a",
      "living",
      "now",
      "here",
    ]
    const read = readTranscript({
      words: words.map((text, index) => ({ text, startMs: index * 300, endMs: index * 300 + 250 })),
    })
    expect(read.timing).toBe("words")
  })

  test("a search finds the phrase that holds it whole", () => {
    const phrases = [
      { text: "Thanks for having me.", startMs: 0, endMs: 2000 },
      { text: "Twelve years of field service.", startMs: 2500, endMs: 5000 },
    ]
    expect(findWords(phrases, "field service", "phrases")).toEqual([1])
  })
})

describe("the live video", () => {
  const live = () => {
    const doc = createArtifactDocument("video", FILES)
    return { doc, video: new LiveVideo(doc) }
  }

  test("reads the composition and each file's clips from the document", () => {
    const { video } = live()
    const state = video.getState()
    expect(state.composition?.scenes.map((scene) => scene.id)).toEqual(["title", "talk"])
    expect(state.timelines.get("scenes/talk.html")?.clips.map((clip) => clip.ref)).toEqual([
      "clip",
      "#1",
    ])
    expect(state.sources.get("media/talk.mp4")).toBeNull()
  })

  // Guard proof: return the scenes' clips as `layClips` rows them, file by file, without `onRows`
  // over them all: the second scene's line, shown while the first's still is, lands on its row.
  test("all the scenes lay every scene's clips in the video, apart where they play together", () => {
    const index = `<div data-composition-id="main" data-width="1280" data-height="720" data-duration="5">
  <audio id="score" src="media/score.m4a" data-start="0" data-duration="5"></audio>
  <div id="a" data-composition-id="a" data-composition-src="scenes/a.html" data-start="0" data-duration="3"></div>
  <div id="b" data-composition-id="b" data-composition-src="scenes/b.html" data-start="a - 1" data-duration="3"></div>
</div>`
    const scene = (id: string, words: string) =>
      `<template><div data-composition-id="${id}" data-width="1280" data-height="720"><p data-start="0" data-duration="3">${words}</p></div></template>`
    const state = new LiveVideo(
      createArtifactDocument(
        "video",
        new Map([
          ["index.html", { text: index }],
          ["scenes/a.html", { text: scene("a", "Fresh every morning") }],
          ["scenes/b.html", { text: scene("b", "Order by noon") }],
          ["media/score.m4a", { file: ref("media/score.m4a") }],
        ])
      )
    ).getState()
    const composition = state.composition
    if (!composition) throw new Error("No video.")

    const laid = (
      clips: readonly { file: string; startMs: number; endMs: number; row: number }[]
    ) => clips.map((each) => [each.file, each.startMs, each.endMs, each.row])
    expect(laid(everySceneClips(state, composition))).toEqual([
      ["scenes/a.html", 0, 3000, 0],
      ["scenes/b.html", 2000, 5000, 1],
      ["index.html", 0, 5000, 0],
    ])
    expect(laid(laidClips(state, composition, composition.scenes[1]))).toEqual([
      ["scenes/b.html", 2000, 5000, 0],
      ["index.html", 0, 5000, 0],
    ])
  })

  test("an edit is one step of the reader's undo, and a file nobody changed keeps its timeline", () => {
    const { video } = live()
    const before = video.getState()
    expect(video.apply((sources) => setSceneLength(sources, "title", 4000))).toBeNull()

    const after = video.getState()
    expect(after.composition?.durationMs).toBe(11_000)
    expect(after.timelines.get("scenes/talk.html")).toBe(before.timelines.get("scenes/talk.html"))
    expect(video.getHistory()).toEqual({ undo: true, redo: false })

    video.undo()
    expect(video.getState().composition?.durationMs).toBe(10_000)
    expect(video.getHistory()).toEqual({ undo: false, redo: true })
  })

  test("a refused edit changes nothing and says why", () => {
    const { video } = live()
    const refused = video.apply((sources) => splitClip(sources, "scenes/talk.html", "clip", 10))
    expect(refused).toContain("at least")
    expect(video.getHistory()).toEqual({ undo: false, redo: false })
  })

  // Guard proof: drop `trackedOrigins` from LiveVideo's undo manager; the other reader's change
  // becomes this one's to undo.
  test("someone else's change shows, and is never the reader's to undo", () => {
    const { doc, video } = live()
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const otherVideo = new LiveVideo(other)
    otherVideo.apply((sources) => setSceneLength(sources, "talk", 5000))
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other))

    expect(video.getState().composition?.durationMs).toBe(8000)
    expect(video.getHistory()).toEqual({ undo: false, redo: false })
  })

  test("a file the reader adds stays when they undo the clip that plays it", () => {
    const { video } = live()
    video.addFile("media/new.mp4", ref("media/new.mp4"))
    expect(video.getState().sources.has("media/new.mp4")).toBe(true)
    expect(video.getHistory()).toEqual({ undo: false, redo: false })
  })
})

describe("fields and files", () => {
  test("seconds are read as people type them", () => {
    expect(parseSeconds("4.5")).toBe(4500)
    expect(parseSeconds("4,5")).toBe(4500)
    expect(parseSeconds("1:04.5")).toBe(64_500)
    expect(parseSeconds("soon")).toBeNull()
    expect(parseSeconds("-1")).toBeNull()
    expect(formatSeconds(4500)).toBe("4.5")
    expect(formatSeconds(17_840)).toBe("17.84")
  })

  test("a file is added as what its type, else its name, says", () => {
    expect(importKind({ type: "video/quicktime", name: "a.mov" })).toBe("video")
    expect(importKind({ type: "", name: "voice.M4A" })).toBe("audio")
    expect(importKind({ type: "image/png", name: "logo.png" })).toBe("image")
    expect(importKind({ type: "image/svg+xml", name: "logo.svg" })).toBeNull()
    expect(importKind({ type: "application/pdf", name: "deck.pdf" })).toBeNull()
  })
})

/**
 * Types into a field as React reads it here: it loaded before the window, so it watches the keys
 * a change comes with, as for a browser without `input` events.
 */
function typeIn(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) ?? "a" })
}

function wrap(children: ReactNode, queries = new QueryClient()) {
  return (
    <QueryClientProvider client={queries}>
      <LocaleProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

describe("the editor's pieces", () => {
  test("a chapter on the timeline opens, moves with Alt and an arrow, and renames on a double click", () => {
    const moves: [string, number][] = []
    const selected: string[] = []
    const renamed: string[] = []
    const pressed: string[] = []
    const talk = composition().scenes[1]
    if (!talk) throw new Error("No interview scene.")

    const view = render(
      wrap(
        <SceneBlock
          scene={talk}
          index={1}
          count={2}
          open={false}
          playing={false}
          agent
          people={[]}
          dragging={false}
          length="7 s"
          onPress={() => pressed.push(talk.id)}
          actions={{
            select: (scene) => selected.push(scene.id),
            move: (scene, to) => moves.push([scene.id, to]),
            duplicate: () => {},
            remove: () => {},
            rename: (scene, label) => renamed.push(`${scene.id}: ${label}`),
          }}
        />
      )
    )

    const block = view.getByRole("button", { name: "Chapter 2, Interview, 7 s" })
    expect(block.parentElement?.className).toContain("sixb-agent-board")
    expect(block.getAttribute("title")).toBe("The agent is editing this chapter")

    // A press is the timeline's to follow; a click without one, from the keyboard, opens it.
    fireEvent.pointerDown(block, { button: 0, clientX: 10, pointerId: 1 })
    fireEvent.click(block, { detail: 0 })
    fireEvent.keyDown(block, { key: "ArrowLeft", altKey: true })
    expect(pressed).toEqual(["talk"])
    expect(selected).toEqual(["talk"])
    expect(moves).toEqual([["talk", 0]])

    fireEvent.doubleClick(block)
    const field = view.getByRole("textbox", { name: "Name" })
    fireEvent.change(field, { target: { value: "In their words" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(renamed).toEqual(["talk: In their words"])
  })

  // Guard proof: drop `narrow` from SceneBlock in scenes.tsx: a short chapter keeps room for its
  // menu, and shows nothing of its name.
  test("a chapter too short for its name shows its number, and its name in a tooltip", async () => {
    const talk = composition().scenes[1]
    if (!talk) throw new Error("No interview scene.")
    // Laid out 30 pixels wide, as a 4 s scene is at a long video's fit.
    const measured = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 30,
    })

    try {
      const view = render(
        wrap(
          <SceneBlock
            scene={talk}
            index={1}
            count={2}
            open={false}
            playing={false}
            agent={false}
            people={[]}
            dragging={false}
            length="7 s"
            onPress={() => {}}
            actions={{
              select: () => {},
              move: () => {},
              duplicate: () => {},
              remove: () => {},
              rename: () => {},
            }}
          />
        )
      )

      const block = view.getByRole("button", { name: "Chapter 2, Interview, 7 s" })
      expect(block.textContent).toBe("2")
      expect(block.getAttribute("title")).toBeNull()

      fireEvent.focus(block)
      await waitFor(() => expect(view.getAllByText("2. Interview").length).toBeGreaterThan(0))
    } finally {
      if (measured) Object.defineProperty(HTMLElement.prototype, "clientWidth", measured)
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  })

  // Guard proof: compare the field's words with the current `value` on leaving, as before, in
  // TextField (inspector.tsx), or with the current `name` in RenameField (scenes.tsx). Left
  // untouched, each then writes the words it opened on over the other's change.
  test("a field left untouched writes nothing back over someone else's change", () => {
    const written: string[] = []
    const field = (value: string) =>
      wrap(<TextField label="Name" value={value} onCommit={(text) => written.push(text)} />)

    const view = render(field("Interview"))
    const input = view.getByRole("textbox", { name: "Name" }) as HTMLInputElement
    fireEvent.focus(input)

    // The Agent renames the scene while the reader's field has focus: it shows the new name, and
    // leaving it writes nothing.
    view.rerender(field("In their words"))
    expect(input.value).toBe("In their words")
    fireEvent.blur(input)
    expect(written).toEqual([])

    // What the reader types is theirs, whatever changed meanwhile; Escape drops it.
    typeIn(input, "Their story")
    view.rerender(field("Voices"))
    fireEvent.blur(input)
    expect(written).toEqual(["Their story"])

    typeIn(input, "Dropped")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(written).toEqual(["Their story"])
    expect(input.value).toBe("Voices")

    const renamed: (string | null)[] = []
    const rename = (name: string) =>
      wrap(<RenameField name={name} placeholder="talk" onDone={(label) => renamed.push(label)} />)
    const renaming = render(rename("Interview"))
    renaming.rerender(rename("In their words"))
    fireEvent.blur(renaming.getAllByRole("textbox", { name: "Name" }).at(-1) as HTMLElement)
    expect(renamed).toEqual([null])
  })

  // Reproduce by dropping the `cancelled` ref in TextField or SecondsField: the blur Escape causes
  // still holds the typed text, and saves it.
  test("Escape leaves a field as it was, and Enter keeps what was typed", () => {
    const names: string[] = []
    const lengths: number[] = []
    const view = render(
      wrap(
        <>
          <TextField label="Name" value="Intro" onCommit={(name) => names.push(name)} />
          <SecondsField label="Length" ms={4000} min={100} onCommit={(ms) => lengths.push(ms)} />
        </>
      )
    )
    const name = view.getByRole("textbox", { name: "Name" }) as HTMLInputElement
    const length = view.getByRole("textbox", { name: "Length" }) as HTMLInputElement

    type(name, "Intro v2")
    fireEvent.keyDown(name, { key: "Escape" })
    type(length, "9")
    fireEvent.keyDown(length, { key: "Escape" })
    expect(names).toEqual([])
    expect(lengths).toEqual([])
    expect(name.value).toBe("Intro")
    expect(length.value).toBe("4")

    // The next edit is kept as usual.
    type(name, "Opening")
    fireEvent.keyDown(name, { key: "Enter" })
    expect(names).toEqual(["Opening"])
  })

  // Reproduce by leaving `round` off the scene's Length field in SceneInspector: it keeps "2.95",
  // which the scene, still 3 s long, does not last.
  test("a scene's length shows the length the edit gives it, in whole frame steps", () => {
    const composition = new LiveVideo(createArtifactDocument("video", FILES)).getState().composition
    const title = composition?.scenes[0]
    if (!composition || !title) throw new Error("No scene.")

    const lengths: number[] = []
    const noop = () => {}
    const view = render(
      wrap(
        <Inspector
          composition={{ ...composition, fps: 24 }}
          timelines={new Map()}
          scene={title}
          clip={undefined}
          splittable={false}
          target={{ artifactId: "art_video", version: 2, files: [] }}
          actions={{
            renameScene: noop,
            sceneLength: (_scene, ms) => lengths.push(ms),
            duplicateScene: noop,
            removeScene: noop,
            clipTiming: noop,
            clipStart: noop,
            clipLength: noop,
            clipSound: noop,
            text: noop,
            clipText: noop,
            removeClip: noop,
            splitClip: noop,
            splitClips: noop,
            removeClips: noop,
          }}
        />
      )
    )
    const length = view.getByRole("textbox", { name: "Length" }) as HTMLInputElement

    // At 24 fps a step is 125 ms: 2.95 s is the scene's 3 s, and 4.2 s is 4.25 s.
    type(length, "2.95")
    fireEvent.keyDown(length, { key: "Enter" })
    expect(length.value).toBe("3")
    type(length, "4.2")
    fireEvent.keyDown(length, { key: "Enter" })
    expect(length.value).toBe("4.25")
    // Enter commits it, and so does the blur it causes, with this scene still 3 s long.
    expect([...new Set(lengths)]).toEqual([4250])
  })

  // Guard proof: show the Text field for every text clip, as `clip.kind === "text"` did: the
  // styled caption offers its words, and typing them would drop its highlighted word.
  test("a clip's words are typed over only when it holds text alone", () => {
    const composition = new LiveVideo(createArtifactDocument("video", FILES)).getState().composition
    const timeline = readVideoFileTimeline(
      "scenes/captions.html",
      '<template><div data-composition-id="captions">' +
        '<p data-start="0" data-duration="1">Fresh bagels</p>' +
        '<p data-start="1" data-duration="1"><span class="hot">Office</span> parties</p>' +
        "</div></template>"
    )
    const [plain, styled] = timeline?.clips ?? []
    if (!composition || !timeline || !plain || !styled) throw new Error("No captions.")

    const noop = () => {}
    const inspect = (clip: typeof plain) =>
      render(
        wrap(
          <Inspector
            composition={composition}
            timelines={new Map([["scenes/captions.html", timeline]])}
            scene={undefined}
            clip={{ file: "scenes/captions.html", clip }}
            splittable={false}
            target={{ artifactId: "art_video", version: 2, files: [] }}
            actions={{
              renameScene: noop,
              sceneLength: noop,
              duplicateScene: noop,
              removeScene: noop,
              clipTiming: noop,
              clipStart: noop,
              clipLength: noop,
              clipSound: noop,
              text: noop,
              clipText: noop,
              removeClip: noop,
              splitClip: noop,
              splitClips: noop,
              removeClips: noop,
            }}
          />
        )
      )

    expect(inspect(plain).queryByRole("textbox", { name: "Text" })).not.toBeNull()
    cleanup()
    expect(styled.track).toBe("text")
    expect(inspect(styled).queryByRole("textbox", { name: "Text" })).toBeNull()
  })
})

/**
 * Types into a field as React reads it here: it loaded before the window existed, so it follows a
 * field's words from the key that changed them.
 */
function type(field: HTMLInputElement, value: string) {
  field.focus()
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) })
}

describe("what is derived of a recording", () => {
  const blob = (path: string, mediaType: string) => ({
    path,
    file: { blobId: path, digest: `sha256:${path}`, sizeBytes: 1, mediaType },
  })
  const target: MediaTarget = {
    artifactId: "art_video",
    version: 2,
    files: [
      blob("media/voice.m4a", "audio/mp4"),
      blob("media/talk.mp4", "video/mp4"),
      blob("media/broken.mp4", "video/mp4"),
      blob("media/logo.png", "image/png"),
    ],
  }

  const unavailable = (reason: string, lacks?: string) => ({
    status: "unavailable",
    reason,
    ...(lacks ? { lacks } : {}),
  })
  const failed = { status: "failed", reason: "It could not be read as a video or a sound." }
  const ready = { status: "ready", url: "/part", mediaType: "x", sizeBytes: 1 }
  const probe = { status: "ready", durationMs: 4800, container: "mp4" }

  /** Each recording's parts, as the server derives them: a sound, footage still filming, one broken. */
  const parts: Record<string, Record<string, unknown>> = {
    "media/voice.m4a": {
      probe,
      proxy: unavailable("It plays as it is."),
      poster: unavailable("It has no picture."),
      filmstrip: unavailable("It has no picture."),
      waveform: ready,
      cuts: unavailable("It has no picture."),
      transcript: unavailable("This project has no transcription model.", "transcription_model"),
    },
    "media/talk.mp4": {
      probe,
      proxy: ready,
      poster: ready,
      filmstrip: { status: "pending" },
      waveform: ready,
      cuts: { status: "ready", atMs: [] },
      transcript: unavailable("This project has no transcription model.", "transcription_model"),
    },
    "media/broken.mp4": Object.fromEntries(
      ["probe", "proxy", "poster", "filmstrip", "waveform", "cuts", "transcript"].map((part) => [
        part,
        failed,
      ])
    ),
  }

  /** The API, answering each recording's parts, and counting what was asked for each. */
  function serve() {
    const asked = new Map<string, number>()
    client.setConfig({
      baseUrl: "https://api.sixb.test",
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(new Request(input, init).url).searchParams.get("path") ?? ""
          asked.set(path, (asked.get(path) ?? 0) + 1)
          const found = parts[path]
          if (!found) return Response.json({ error: "No video or sound there." }, { status: 400 })
          return Response.json({ path, version: 2, parts: found })
        },
        { preconnect: fetch.preconnect }
      ),
    })
    return asked
  }

  test("is read once the version holds it, and only for a video or a sound", async () => {
    const asked = serve()
    const seen = new Map<string, MediaParts>()
    function Probe({ path }: { readonly path: string }) {
      seen.set(path, useMediaParts(target, path))
      return null
    }

    const paths = ["media/voice.m4a", "media/broken.mp4", "media/logo.png", "media/imported.mp4"]
    render(wrap(paths.map((path) => <Probe key={path} path={path} />)))
    await waitFor(() => expect(seen.get("media/broken.mp4")?.failed).toBeDefined())
    await waitFor(() => expect(seen.get("media/voice.m4a")?.durationMs).toBe(4800))

    // A picture has nothing derived, and a recording not saved yet is not in the version.
    expect([...asked.keys()].sort()).toEqual(["media/broken.mp4", "media/voice.m4a"])
    expect(seen.get("media/logo.png")?.processing).toBe(false)
    expect(seen.get("media/imported.mp4")?.processing).toBe(true)

    expect(seen.get("media/voice.m4a")).toMatchObject({
      processing: false,
      durationMs: 4800,
      transcriptLacks: "transcription_model",
    })
    expect(seen.get("media/broken.mp4")).toMatchObject({
      processing: false,
      failed: "It could not be read as a video or a sound.",
    })
  })

  // Reproduce by dropping the alert from ClipInspector: a recording that cannot be read then looks
  // like any other, its Length box blank and nothing saying why it plays nothing.
  test("says when a recording cannot be read, in the inspector", async () => {
    serve()
    const state = new LiveVideo(createArtifactDocument("video", FILES)).getState()
    const shown = state.composition
    const footage = state.timelines.get("scenes/talk.html")?.clips[0]
    if (!shown || !footage) throw new Error("No footage.")

    const noop = () => {}
    const view = render(
      wrap(
        <Inspector
          composition={shown}
          timelines={state.timelines}
          scene={undefined}
          clip={{ file: "scenes/talk.html", clip: { ...footage, src: "media/broken.mp4" } }}
          splittable={false}
          target={target}
          actions={{
            renameScene: noop,
            sceneLength: noop,
            duplicateScene: noop,
            removeScene: noop,
            clipTiming: noop,
            clipStart: noop,
            clipLength: noop,
            clipSound: noop,
            text: noop,
            clipText: noop,
            removeClip: noop,
            splitClip: noop,
            splitClips: noop,
            removeClips: noop,
          }}
        />
      )
    )

    const alert = await waitFor(() => view.getByRole("alert"))
    expect(alert.textContent).toContain("This recording can’t be read")
    expect(alert.textContent).toContain("It could not be read as a video or a sound.")
  })

  // Reproduce by dropping the transcription-model notice from TranscriptPanel: the tab then says
  // only that the project has none, with nothing the reader can act on.
  test("says what editing by words needs when the project cannot transcribe", async () => {
    serve()
    const view = render(
      wrap(
        <TranscriptPanel
          target={target}
          src="media/voice.m4a"
          clips={[]}
          timeMs={0}
          onSeek={() => {}}
          onRemove={() => {}}
        />
      )
    )

    await waitFor(() => view.getByText("Editing by words needs a transcription model"))
    expect(view.container.textContent).toContain("models.audio.transcription")
  })

  // Reproduce by polling while a recording has no filmstrip, as the editor did: a sound, which
  // never gets one, and a broken recording are then asked for every 4 s for as long as it is open.
  test("is asked for again only while a part is still being derived", () => {
    const read = (path: string) =>
      readMediaParts({ path, version: 2, parts: parts[path] } as GetArtifactMediaResponse)

    expect(pollAgainIn(read("media/talk.mp4"))).toBe(4000)
    expect(pollAgainIn(read("media/voice.m4a"))).toBe(false)
    expect(pollAgainIn(read("media/broken.mp4"))).toBe(false)
  })
})

describe("the Transcript tab", () => {
  /** A voice-over along the whole video; a title, then an interview over muted b-roll. */
  const SPOKEN_INDEX = `<div data-composition-id="main" data-width="1280" data-height="720" data-duration="10">
  <audio id="narration" src="media/narration.m4a" data-start="0" data-duration="10"></audio>
  <div id="title" data-composition-id="title" data-composition-src="scenes/title.html" data-start="0" data-duration="3" data-label="Title"></div>
  <div id="talk" data-composition-id="talk" data-composition-src="scenes/talk.html" data-start="title" data-duration="7" data-label="Interview"></div>
</div>`
  const SPOKEN_TALK = `<template>
  <div data-composition-id="talk" data-width="1280" data-height="720">
    <video id="broll" src="media/broll.mp4" data-start="0" data-duration="7" muted></video>
    <audio id="answer" src="media/answer.m4a" data-start="0.5" data-duration="6"></audio>
  </div>
</template>`

  const blob = (path: string, mediaType: string) => ({
    path,
    file: { blobId: path, digest: `sha256:${path}`, sizeBytes: 1, mediaType },
  })
  const target: MediaTarget = {
    artifactId: "art_video",
    version: 3,
    files: [
      blob("media/narration.m4a", "audio/mp4"),
      blob("media/broll.mp4", "video/mp4"),
      blob("media/answer.m4a", "audio/mp4"),
    ],
  }

  /** What each recording says, as its transcription model timed it. */
  const said: Record<string, string[]> = {
    "media/narration.m4a": ["Every", "boiler", "tells", "a", "story."],
    "media/answer.m4a": ["We", "fixed", "it", "before", "lunch."],
    "media/broll.mp4": [],
  }

  /** The API, answering each recording's parts and its transcript's file. */
  function serve() {
    const unavailable = { status: "unavailable", reason: "It has no picture." }
    const parts = (path: string) => ({
      probe: { status: "ready", durationMs: 7000, container: "mp4" },
      proxy: unavailable,
      poster: unavailable,
      filmstrip: unavailable,
      waveform: unavailable,
      cuts: unavailable,
      transcript: {
        status: "ready",
        url: `/transcripts/${encodeURIComponent(path)}`,
        mediaType: "application/json",
        sizeBytes: 1,
      },
    })
    client.setConfig({
      baseUrl: "https://api.sixb.test",
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(new Request(input, init).url).searchParams.get("path") ?? ""
          return Response.json({ path, version: 3, parts: parts(path) })
        },
        { preconnect: fetch.preconnect }
      ),
    })

    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const { pathname } = new URL(String(input))
        const path = decodeURIComponent(pathname.replace(/^\/transcripts\//, ""))
        const words = (said[path] ?? []).map((text, index) => ({
          text,
          startMs: index * 400,
          endMs: index * 400 + 300,
        }))
        return Response.json({ text: words.map((word) => word.text).join(" "), words })
      },
      { preconnect: original.preconnect }
    )
    return () => {
      globalThis.fetch = original
    }
  }

  function tab(sceneId: string, timeMs: number, onSeek: (ms: number) => void = () => {}) {
    const files: LiveFiles = new Map([
      ["index.html", { text: SPOKEN_INDEX }],
      ["scenes/title.html", { text: TITLE }],
      ["scenes/talk.html", { text: SPOKEN_TALK }],
    ])
    const state = new LiveVideo(createArtifactDocument("video", files)).getState()
    const shown = state.composition
    const scene = shown?.scenes.find((each) => each.id === sceneId)
    if (!shown || !scene) throw new Error(`No scene ${sceneId}.`)

    const clips = laidClips(state, shown, scene)
    return wrap(
      <TranscriptTab
        target={target}
        scene={scene.id}
        recordings={heardRecordings(clips, scene, timeMs)}
        selected={undefined}
        timeMs={timeMs}
        onSeek={onSeek}
        onRemove={() => {}}
      />
    )
  }

  // Reproduce by showing only the selected clip's recording in TranscriptTab (drop
  // `?? speaking[0]`), or by offering only footage in heardRecordings, as the editor did: with
  // nothing selected, the tab then says nothing is said, though the interview and the voice-over
  // speak.
  test("opens on the open scene's spoken recording with nothing selected, and switches to another", async () => {
    const restore = serve()
    try {
      const view = render(tab("talk", 4000))
      await waitFor(() => view.getByText("lunch."))
      expect(view.container.textContent).not.toContain("boiler")

      // The muted b-roll says nothing, so only the voice-over is offered beside the answer.
      await act(async () => {
        fireEvent.pointerDown(view.getByRole("button", { name: /^Transcript of answer\.m4a/ }), {
          button: 0,
          ctrlKey: false,
          pointerType: "mouse",
        })
      })
      const items = await view.findAllByRole("menuitem")
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining("answer.m4a"),
        expect.stringContaining("narration.m4a"),
      ])

      await act(async () => {
        fireEvent.click(view.getByRole("menuitem", { name: /narration\.m4a/ }))
      })
      await waitFor(() => view.getByText("boiler"))
    } finally {
      restore()
    }
  })

  // Reproduce by deciding the click in Words' onPointerUp from the word under the release, its
  // `event.target`, as the panel did: the release lands on "lunch.", as when the text moved under
  // the pointer, and the press selects "fixed" instead of going there.
  test("a click on a word goes there, whichever word the text has moved under its release", async () => {
    const restore = serve()
    try {
      const seeks: number[] = []
      const view = render(tab("talk", 4000, (ms) => seeks.push(ms)))
      await waitFor(() => view.getByText("lunch."))

      fireEvent.pointerDown(view.getByText("fixed"), { button: 0, pointerId: 1 })
      fireEvent.pointerUp(view.getByText("lunch."), { button: 0, pointerId: 1 })

      // The answer plays from 3.5 s, and "fixed" is said 0.4 s into it.
      expect(seeks).toEqual([3900])
      expect(view.queryByText(/^Cut \d+ words?$/)).toBeNull()
    } finally {
      restore()
    }
  })

  test("falls back on the video's own voice-over when the scene has no recording", async () => {
    const restore = serve()
    try {
      const view = render(tab("title", 1000))
      await waitFor(() => view.getByText("boiler"))
      expect(view.container.textContent).toContain("Soundtrack")
    } finally {
      restore()
    }
  })
})

describe("the editor", () => {
  /** The video as the editor opens it, live, the title's words timed so both chapters have clips. */
  function openEditor(talk = TALK, title = (text: string) => text) {
    const live = new LiveArtifact("art_video", () => false, {
      list: () => [],
      write: () => {},
      remove: () => {},
    })
    const files = new Map(FILES)
    files.set("scenes/title.html", {
      text: title(TITLE.replace("<h1>", '<h1 data-start="0" data-duration="3">')),
    })
    files.set("scenes/talk.html", { text: talk })
    Y.applyUpdate(live.doc, Y.encodeStateAsUpdate(createArtifactDocument("video", files)))

    const outline = {
      kind: "video" as const,
      width: 1280,
      height: 720,
      fps: 30,
      durationMs: 10_000,
      scenes: [
        { id: "title", label: "Title", startMs: 0, durationMs: 3000, renderKey: "a" },
        { id: "talk", label: "Interview", startMs: 3000, durationMs: 7000, renderKey: "b" },
      ],
    }
    const version = artifactVersion({
      artifactId: "art_video",
      title: "Interview",
      entry: "index.html",
      outline,
    })
    const queries = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    })
    queries.setQueryData(frameLinkKey(version), {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-11-22T13:00:00.000Z",
    })

    const view = render(
      wrap(<VideoEditor version={version} outline={outline} live={live} />, queries)
    )
    const text = (path: string) => live.doc.getMap<Y.Text>("files").get(path)?.toString() ?? ""
    return { view, live, text }
  }

  // Guard proof: give the timeline the open chapter's clips alone in editor.tsx, `clips={clips}`,
  // as it had without All scenes: with the playhead in the title, the interview shows none.
  test("shows the whole video on one timeline, with no choice of scenes to make", () => {
    const { view, live } = openEditor()
    const tracks = view.container.querySelector<HTMLElement>("[data-video-tracks]")
    const files = [...(tracks?.querySelectorAll("[data-timeline-file]") ?? [])].map((block) =>
      block.getAttribute("data-timeline-file")
    )
    expect(new Set(files)).toEqual(new Set(["scenes/title.html", "scenes/talk.html", "index.html"]))
    expect(view.queryByRole("button", { name: "All scenes" })).toBeNull()
    expect(view.getByText("Chapters")).toBeDefined()
    live.destroy()
  })

  // Guard proof: leave the selection as it was after a move in editor.tsx (`follow` false in
  // `place`): the caption lands in the title, and nothing is selected.
  test("a caption dragged into the chapter before lands in its file, and stays selected", () => {
    const { view, live, text } = openEditor()
    const caption = () => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-video-tracks] [data-timeline-clip][aria-label$="Thanks for having me."]'
      )
      if (!found) throw new Error("No caption on the timeline.")
      return found
    }
    const xAt = (ms: number) => 112 + ms / 10

    // From 3.5 s, in the interview, to 0.5 s, in the title: its 2 s end there.
    fireEvent.pointerDown(caption(), { button: 0, clientX: xAt(3500), pointerId: 1 })
    fireEvent.pointerMove(caption(), { clientX: xAt(500), pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(caption(), { clientX: xAt(500), pointerId: 1, shiftKey: true })

    expect(text("scenes/talk.html")).not.toContain("Thanks for having me.")
    expect(text("scenes/title.html")).toContain(
      '<p class="caption" data-start="0.5" data-duration="2">Thanks for having me.</p>'
    )
    expect(caption().getAttribute("data-timeline-file")).toBe("scenes/title.html")
    expect(caption().style.left).toBe("50px")
    expect(caption().getAttribute("aria-pressed")).toBe("true")
    live.destroy()
  })

  // Guard proof: commit the Inspector's Start as the caption's own time in its file,
  // `setClipTiming`, as the editor did; the caption then starts 1 s into the interview. Leave the
  // selection where it was after a length (`place(…, false)` in clipLength, editor.tsx): the
  // caption, given an id once it goes on, is then let go, and the Inspector empties.
  test("sets a clip's start and length in the video, placed as a drag places it", () => {
    const { view, live, text } = openEditor()
    const caption = () => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-video-tracks] [data-timeline-clip][aria-label$="Thanks for having me."]'
      )
      if (!found) throw new Error("No caption on the timeline.")
      return found
    }
    fireEvent.pointerDown(caption(), { button: 0, clientX: 112 + 350, pointerId: 1 })
    fireEvent.pointerUp(caption(), { clientX: 112 + 350, pointerId: 1 })

    const start = view.getByRole("textbox", { name: /Starts at/ }) as HTMLInputElement
    expect(start.value).toBe("3.5")
    type(start, "1")
    fireEvent.keyDown(start, { key: "Enter" })
    expect(text("scenes/title.html")).toContain(
      '<p class="caption" data-start="1" data-duration="2">Thanks for having me.</p>'
    )

    // Longer than the title has room for: it goes on into the interview, and reads as one.
    const length = view.getByRole("textbox", { name: "Length" }) as HTMLInputElement
    type(length, "4")
    fireEvent.keyDown(length, { key: "Enter" })
    expect(text("scenes/talk.html")).toContain('data-continues="text"')
    expect((view.getByRole("textbox", { name: /Starts at/ }) as HTMLInputElement).value).toBe("1")
    expect((view.getByRole("textbox", { name: "Length" }) as HTMLInputElement).value).toBe("4")
    live.destroy()
  })

  // Guard proof: say only what a clip leaves in tellAnimations (editor.tsx), dropping `joined`;
  // the caption lands in a title whose script fades every caption in, and nothing says so.
  test("says once that a chapter's animation now plays on the clip moved into it", () => {
    const { view, live } = openEditor(TALK, (title) =>
      title.replace(
        "  </div>",
        "  <script>gsap.timeline().from('[data-composition-id=\"title\"] .caption', { opacity: 0 })</script>\n  </div>"
      )
    )
    const caption = view.container.querySelector<HTMLElement>(
      '[data-video-tracks] [data-timeline-clip][aria-label$="Thanks for having me."]'
    )
    if (!caption) throw new Error("No caption on the timeline.")
    fireEvent.pointerDown(caption, { button: 0, clientX: 112 + 350, pointerId: 1 })
    fireEvent.pointerMove(caption, { clientX: 112 + 50, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(caption, { clientX: 112 + 50, pointerId: 1, shiftKey: true })

    const notice = view
      .getByText("“Thanks for having me.” now moves with “Title”")
      .closest("[role=status]")
    expect(notice?.textContent).toContain("“Title” animates clips like it")
    live.destroy()
  })

  // Guard proof: say every animation left in tellAnimations (editor.tsx), without `told`: the
  // caption's second trip says it again.
  test("says once, kindly, that a caption's animation stayed with its chapter", () => {
    const animated = TALK.replace(
      "  </div>\n</template>",
      "    <script>gsap.timeline().from('[data-composition-id=\"talk\"] .caption', { opacity: 0 })</script>\n  </div>\n</template>"
    )
    const { view, live } = openEditor(animated)
    const xAt = (ms: number) => 112 + ms / 10
    const drag = (from: number, to: number) => {
      const caption = view.container.querySelector<HTMLElement>(
        '[data-video-tracks] [data-timeline-clip][aria-label$="Thanks for having me."]'
      )
      if (!caption) throw new Error("No caption on the timeline.")
      fireEvent.pointerDown(caption, { button: 0, clientX: xAt(from), pointerId: 1 })
      fireEvent.pointerMove(caption, { clientX: xAt(to), pointerId: 1, shiftKey: true })
      fireEvent.pointerUp(caption, { clientX: xAt(to), pointerId: 1, shiftKey: true })
    }

    drag(3500, 500)
    const notice = view.getByText("“Thanks for having me.” keeps its look").closest("[role=status]")
    expect(notice?.textContent).toContain("Its animation stays with “Interview”.")
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }))

    // Back into the interview, and out again: said already.
    drag(500, 3500)
    drag(3500, 500)
    expect(view.queryByText(/keeps its look/)).toBeNull()
    live.destroy()
  })
})

/** Where a timeline's recordings would be read from: a version that holds none. */
const TARGET = { artifactId: "art_video", version: 1, files: [] }

describe("the timeline", () => {
  const video = () => {
    const state = new LiveVideo(createArtifactDocument("video", FILES)).getState()
    const shown = state.composition
    if (!shown) throw new Error("No composition.")
    return { state, composition: shown, talk: shown.scenes[1] }
  }

  function timeline(props: Partial<Parameters<typeof Timeline>[0]> & { readonly timeMs: number }) {
    const { state, composition } = video()
    return wrap(
      <Timeline
        composition={composition}
        clips={everySceneClips(state, composition)}
        selection={null}
        marks={{}}
        snapping
        agentScenes={new Set()}
        people={new Map()}
        target={TARGET}
        uploads={[]}
        toolbar={() => null}
        dropTarget={false}
        formatLength={(ms) => `${ms / 1000} s`}
        edits={{
          seek: () => {},
          select: () => {},
          moveClip: () => {},
          moveClips: () => {},
          trimClip: () => {},
          sceneLength: () => {},
          scene: {
            select: () => {},
            move: () => {},
            duplicate: () => {},
            remove: () => {},
            rename: () => {},
          },
        }}
        {...props}
      />
    )
  }

  // Guard proof: open the chapter with something else than `edits.scene.select` on a tap in
  // timeline.tsx, as it was: a click left the playhead, and the picture, in another chapter.
  test("a tap on a chapter opens it as Enter does, which moves the playhead to it", () => {
    const opened: string[] = []
    const view = render(
      timeline({
        timeMs: 0,
        edits: {
          seek: () => {},
          select: () => {},
          moveClip: () => {},
          moveClips: () => {},
          trimClip: () => {},
          sceneLength: () => {},
          scene: {
            select: (scene) => opened.push(scene.id),
            move: () => {},
            duplicate: () => {},
            remove: () => {},
            rename: () => {},
          },
        },
      })
    )

    const block = view.getByRole("button", { name: /^Chapter 2, Interview/ })
    fireEvent.pointerDown(block, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(window, { button: 0, clientX: 300, pointerId: 1 })
    expect(opened).toEqual(["talk"])
  })

  // Guard proof: drop the knob's room from the ruler's labels in timeline.tsx (`left-1`, as it
  // was): the playhead resting on 0:00 hides its first digit.
  test("the time under the playhead's knob stays readable, 0:00 first", () => {
    const view = render(timeline({ timeMs: 0 }))
    const label = [...view.container.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.childElementCount === 0 && span.textContent === "0:00"
    )
    const knob = view.container.querySelector<HTMLElement>(".bg-red-500 > span")
    if (!label || !knob) throw new Error("No ruler label or playhead knob.")

    const knobRight = Number.parseFloat(knob.style.left) + Number.parseFloat(knob.style.width)
    expect(Number.parseFloat(label.style.left)).toBeGreaterThan(knobRight)
  })

  // Reproduce by giving the follow-the-playhead effect no dependency list, as it had: any render,
  // such as a selection, scrolls the timeline back to the paused playhead.
  test("stays where the reader scrolled it until the playhead moves", () => {
    const view = render(timeline({ timeMs: 0 }))
    const scroller = view.container.querySelector<HTMLElement>("[data-video-timeline]")
    if (!scroller) throw new Error("No timeline.")

    scroller.scrollLeft = 600
    view.rerender(timeline({ timeMs: 0, selection: { type: "scene", scene: "talk" } }))
    expect(scroller.scrollLeft).toBe(600)

    view.rerender(timeline({ timeMs: 0, marks: { in: 1000 } }))
    expect(scroller.scrollLeft).toBe(600)

    // Moved, the playhead is brought back in sight.
    view.rerender(timeline({ timeMs: 1000, marks: { in: 1000 } }))
    expect(scroller.scrollLeft).not.toBe(600)
  })

  describe("selecting several clips", () => {
    // The timeline here draws 100 px a second from its labels' edge, 112 px in: 4 s is at 512.
    const xAt = (ms: number) => 112 + ms / 10
    // Asked once the page's navigator is in place: ⌘ on a Mac, Ctrl elsewhere.
    const command = () => (appleKeyboard() ? { metaKey: true } : { ctrlKey: true })
    const footage = { file: "scenes/talk.html", target: "clip" }
    const caption = {
      file: "scenes/talk.html",
      target: { ref: "#1", tag: "p", words: "Thanks for having me." },
    }

    function selecting(selection: Parameters<typeof Timeline>[0]["selection"] = null) {
      const selected: Parameters<typeof Timeline>[0]["selection"][] = []
      const moved: [string[], number][] = []
      const edits = {
        seek: () => {},
        select: (next: Parameters<typeof Timeline>[0]["selection"]) => selected.push(next),
        moveClip: () => {},
        moveClips: (clips: readonly { readonly clip: { readonly ref: string } }[], ms: number) =>
          moved.push([clips.map((laid) => laid.clip.ref), ms]),
        trimClip: () => {},
        sceneLength: () => {},
        scene: { select: () => {}, move: () => {}, duplicate: () => {}, remove: () => {} },
      }
      const view = render(timeline({ timeMs: 0, selection, edits: edits as never }))
      const query = (selector: string) => {
        const found = view.container.querySelector<HTMLElement>(selector)
        if (!found) throw new Error(`Nothing at ${selector}.`)
        return found
      }
      return { view, selected, moved, query }
    }

    // Guard proof: drop the command key's branch from the clip's onPointerDown in timeline.tsx;
    // the press starts a move, and the click selects the caption alone.
    test("a click with the command key adds a clip to the selection, and takes it out again", () => {
      const added = selecting({ type: "clip", ...footage })
      const block = added.query('[data-timeline-clip="#1"]')
      fireEvent.pointerDown(block, { button: 0, clientX: xAt(4000), pointerId: 1, ...command() })
      fireEvent.pointerUp(added.query("[data-video-tracks]"), { pointerId: 1, ...command() })
      expect(added.selected).toEqual([{ type: "clips", clips: [footage, caption] }])
      cleanup()

      const taken = selecting({ type: "clips", clips: [footage, caption] })
      const again = taken.query('[data-timeline-clip="#1"]')
      fireEvent.pointerDown(again, { button: 0, clientX: xAt(4000), pointerId: 1, ...command() })
      fireEvent.pointerUp(taken.query("[data-video-tracks]"), { pointerId: 1, ...command() })
      expect(taken.selected).toEqual([{ type: "clip", ...footage }])
    })

    // Guard proof: drop the command key's branch from the tracks' onBackground in timeline.tsx;
    // the press clears the selection, and no rectangle follows the pointer.
    test("a drag with the command key selects every clip its rectangle touches, as it grows", () => {
      const { selected, query } = selecting()
      const tracks = query("[data-video-tracks]")
      // The first row, past the chapters' edges drawn under the clips.
      const picture = [...tracks.children].find((child) => child.tagName === "DIV")?.children[1]
      if (!picture) throw new Error("No picture track.")

      fireEvent.pointerDown(picture, {
        button: 0,
        clientX: xAt(4000),
        clientY: 10,
        pointerId: 1,
        ...command(),
      })
      fireEvent.pointerMove(tracks, { clientX: xAt(4500), clientY: 20, pointerId: 1 })
      expect(selected.at(-1)).toEqual({ type: "clip", ...footage })

      fireEvent.pointerMove(tracks, { clientX: xAt(5000), clientY: 50, pointerId: 1 })
      expect(selected.at(-1)).toEqual({ type: "clips", clips: [footage, caption] })
      expect(query("[data-marquee]").style.top).toBe("10px")

      fireEvent.pointerUp(tracks, { clientX: xAt(5000), clientY: 50, pointerId: 1 })
      expect(selected.at(-1)).toEqual({ type: "clips", clips: [footage, caption] })
      expect(tracks.querySelector("[data-marquee]")).toBeNull()
    })

    // Guard proof: start the move without its `group` in timeline.tsx; the footage stays put, and
    // the caption moves alone, through moveClip.
    test("dragging one of the clips selected moves them all, as one edit", () => {
      const { moved, query } = selecting({ type: "clips", clips: [footage, caption] })
      const block = () => query('[data-timeline-clip="clip"]')
      const before = block().style.left

      fireEvent.pointerDown(query('[data-timeline-clip="#1"]'), {
        button: 0,
        clientX: xAt(4000),
        pointerId: 1,
      })
      fireEvent.pointerMove(query('[data-timeline-clip="#1"]'), {
        clientX: xAt(4500),
        pointerId: 1,
        shiftKey: true,
      })
      // The footage follows the caption it was selected with.
      expect(Number.parseFloat(block().style.left) - Number.parseFloat(before)).toBe(50)

      fireEvent.pointerUp(query('[data-timeline-clip="#1"]'), {
        clientX: xAt(4500),
        pointerId: 1,
        shiftKey: true,
      })
      expect(moved).toEqual([[["clip", "#1"], 500]])
    })
  })

  // Guard proof: edit on every drag let go in onDragEnd (timeline.tsx), as it did; a clip dragged
  // away and back, and a trim handle let go where it was, each ask for an edit that changes nothing.
  test("a drag let go where it started asks for no edit", () => {
    const asked: string[] = []
    const edits = {
      seek: () => {},
      select: () => {},
      moveClip: () => asked.push("move"),
      moveClips: () => asked.push("moves"),
      trimClip: () => asked.push("trim"),
      sceneLength: () => {},
      scene: { select: () => {}, move: () => {}, duplicate: () => {}, remove: () => {} },
    }
    const view = render(timeline({ timeMs: 0, edits: edits as never }))
    const block = () => {
      const found = view.container.querySelector<HTMLElement>('[data-timeline-clip="clip"]')
      if (!found) throw new Error("No footage on the timeline.")
      return found
    }

    fireEvent.pointerDown(block(), { button: 0, clientX: 412, pointerId: 1 })
    fireEvent.pointerMove(block(), { clientX: 480, pointerId: 1, shiftKey: true })
    fireEvent.pointerMove(block(), { clientX: 412, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(block(), { clientX: 412, pointerId: 1, shiftKey: true })

    const handle = block().querySelector<HTMLElement>(".cursor-ew-resize")
    if (!handle) throw new Error("No trim handle on the footage.")
    fireEvent.pointerDown(handle, { button: 0, clientX: 412, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(handle, { clientX: 412, pointerId: 1, shiftKey: true })
    expect(asked).toEqual([])
  })

  // Guard proof: leave `dragRef.current` set in onDragEnd in timeline.tsx; the handle's release
  // bubbles to its clip, and the trim is made twice, a start trim with ripple twice as deep.
  test("a trim is made once when its handle is let go", () => {
    const trims: number[] = []
    const edits = {
      seek: () => {},
      select: () => {},
      moveClip: () => {},
      moveClips: () => {},
      trimClip: (_laid: unknown, _edge: unknown, atMs: number) => trims.push(atMs),
      sceneLength: () => {},
      scene: { select: () => {}, move: () => {}, duplicate: () => {}, remove: () => {} },
    }
    const view = render(timeline({ timeMs: 0, edits: edits as never }))
    const handle = view.container.querySelector<HTMLElement>(
      '[data-timeline-clip="clip"] > .cursor-ew-resize'
    )
    if (!handle) throw new Error("No trim handle on the footage.")

    fireEvent.pointerDown(handle, { button: 0, clientX: 412, pointerId: 1, shiftKey: true })
    fireEvent.pointerMove(handle, { clientX: 462, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(handle, { clientX: 462, pointerId: 1, shiftKey: true })
    expect(trims).toHaveLength(1)
  })

  describe("one film, its chapters on a bar", () => {
    // 100 px a second from the labels' edge, 112 px in, as above.
    const xAt = (ms: number) => 112 + ms / 10

    /** The timeline, every edit it asks for kept. */
    function film(selection: Parameters<typeof Timeline>[0]["selection"] = null) {
      const moved: [string, string, number][] = []
      const grouped: [string[], number][] = []
      const edits = {
        seek: () => {},
        select: () => {},
        moveClip: (laid: { file: string; clip: { ref: string } }, startMs: number) =>
          moved.push([laid.file, laid.clip.ref, startMs]),
        moveClips: (clips: readonly { readonly clip: { readonly ref: string } }[], ms: number) =>
          grouped.push([clips.map((laid) => laid.clip.ref), ms]),
        trimClip: () => {},
        sceneLength: () => {},
        scene: { select: () => {}, move: () => {}, duplicate: () => {}, remove: () => {} },
      }
      const view = render(timeline({ timeMs: 0, selection, edits: edits as never }))
      const block = (ref: string) => {
        const found = view.container.querySelector<HTMLElement>(`[data-timeline-clip="${ref}"]`)
        if (!found) throw new Error(`No clip ${ref} on the timeline.`)
        return found
      }
      return { view, moved, grouped, block }
    }

    // Guard proof: drop the chapters' edges from the tracks in timeline.tsx: nothing on them says
    // where the interview starts.
    test("lays every chapter's clips where they play, and marks where each chapter starts", () => {
      const { view, block } = film()
      // The interview's footage plays from 3 s, after the title, on the one track.
      expect(block("clip").style.left).toBe("300px")
      expect(view.getByText("Chapters")).toBeDefined()
      const edge = view.container.querySelector<HTMLElement>('[data-chapter-edge="talk"]')
      expect(edge?.style.left).toBe(`${xAt(3000)}px`)
      // The chapter under the playhead is marked, and nothing on the tracks is dimmed.
      const title = view.getByRole("button", { name: /^Chapter 1, Title/ })
      expect(title.getAttribute("aria-current")).toBe("true")
      expect(view.container.querySelector(".opacity-50")).toBeNull()
    })

    // Guard proof: draw every row from the top in rowTop (timeline.tsx), as sounds are; the card
    // painted over the footage is then drawn under it. Draw them so, but lay the boxes a
    // rectangle touches from the top, and the rectangle over the upper row takes the footage.
    test("draws what paints in front on the upper row, where a selection rectangle finds it", () => {
      const files = new Map(FILES)
      files.set("scenes/talk.html", {
        text: TALK.replace(
          "    <p class",
          '    <img id="card" src="media/card.png" data-start="1" data-duration="2">\n    <p class'
        ),
      })
      files.set("media/card.png", { file: ref("media/card.png") })
      const state = new LiveVideo(createArtifactDocument("video", files)).getState()
      const shown = state.composition
      if (!shown) throw new Error("No video.")

      const selected: unknown[] = []
      const view = render(
        timeline({
          timeMs: 0,
          composition: shown,
          clips: everySceneClips(state, shown),
          edits: {
            seek: () => {},
            select: (next: unknown) => selected.push(next),
            moveClip: () => {},
            moveClips: () => {},
            trimClip: () => {},
            sceneLength: () => {},
            scene: {
              select: () => {},
              move: () => {},
              duplicate: () => {},
              remove: () => {},
              rename: () => {},
            },
          } as never,
        })
      )
      const top = (ref: string) =>
        Number.parseFloat(
          view.container.querySelector<HTMLElement>(`[data-timeline-clip="${ref}"]`)?.style.top ??
            ""
        )
      expect(top("card")).toBeLessThan(top("clip"))

      const tracks = view.container.querySelector<HTMLElement>("[data-video-tracks]")
      const picture = [...(tracks?.children ?? [])].find((child) => child.tagName === "DIV")
        ?.children[1]
      if (!tracks || !picture) throw new Error("No picture track.")
      const command = appleKeyboard() ? { metaKey: true } : { ctrlKey: true }
      fireEvent.pointerDown(picture, {
        button: 0,
        clientX: xAt(3500),
        clientY: 8,
        pointerId: 1,
        ...command,
      })
      fireEvent.pointerMove(tracks, { clientX: xAt(4500), clientY: 14, pointerId: 1 })
      expect(selected.at(-1)).toEqual({ type: "clip", file: "scenes/talk.html", target: "card" })
      fireEvent.pointerUp(tracks, { clientX: xAt(4500), clientY: 14, pointerId: 1 })
    })

    // Guard proof: give every block both handles at 8 px in ClipBlock (timeline.tsx), as it had;
    // the one-word caption is then all handles, held only to trim. Drop the command key's branch
    // from the handles' press, and a ⌘-press on an edge trims rather than selects.
    test("a narrow clip keeps a middle to hold, and the command key on an edge selects", () => {
      const files = new Map(FILES)
      files.set("scenes/talk.html", {
        text: TALK.replace(
          "  </div>",
          '  <p class="caption" data-start="3" data-duration="0.12">So</p>\n    <p class="caption" data-start="4" data-duration="0.2">we</p>\n  </div>'
        ),
      })
      const state = new LiveVideo(createArtifactDocument("video", files)).getState()
      const shown = state.composition
      if (!shown) throw new Error("No video.")
      const selected: unknown[] = []
      const moved: number[] = []
      const view = render(
        timeline({
          timeMs: 0,
          composition: shown,
          clips: everySceneClips(state, shown),
          edits: {
            seek: () => {},
            select: (next: unknown) => selected.push(next),
            moveClip: (_: unknown, ms: number) => moved.push(ms),
            moveClips: () => {},
            trimClip: () => {},
            sceneLength: () => {},
            scene: {
              select: () => {},
              move: () => {},
              duplicate: () => {},
              remove: () => {},
              rename: () => {},
            },
          } as never,
        })
      )
      const word = (words: string) => {
        const found = view.container.querySelector<HTMLElement>(`[aria-label$=", ${words}"]`)
        if (!found) throw new Error(`No caption "${words}".`)
        return found
      }
      const handles = (block: HTMLElement) => [
        ...block.querySelectorAll<HTMLElement>(".cursor-ew-resize"),
      ]

      // 12 px: none, so it moves; 20 px: a quarter of it each.
      expect(handles(word("So")).length).toBe(0)
      expect(handles(word("we")).map((handle) => handle.style.width)).toEqual(["5px", "5px"])
      fireEvent.pointerDown(word("So"), { button: 0, clientX: xAt(6050), pointerId: 1 })
      fireEvent.pointerMove(word("So"), { clientX: xAt(6550), pointerId: 1, shiftKey: true })
      fireEvent.pointerUp(word("So"), { clientX: xAt(6550), pointerId: 1, shiftKey: true })
      expect(moved).toEqual([6500])

      const command = appleKeyboard() ? { metaKey: true } : { ctrlKey: true }
      const [edge] = handles(
        view.container.querySelector<HTMLElement>('[data-timeline-clip="clip"]') as HTMLElement
      )
      if (!edge) throw new Error("No handle on the footage.")
      fireEvent.pointerDown(edge, { button: 0, clientX: xAt(3000), pointerId: 2, ...command })
      const tracks = view.container.querySelector<HTMLElement>("[data-video-tracks]") as HTMLElement
      fireEvent.pointerUp(tracks, { clientX: xAt(3000), pointerId: 2, ...command })
      expect(selected.at(-1)).toEqual({ type: "clip", file: "scenes/talk.html", target: "clip" })
    })

    /** The title opening on footage that goes on into the interview, as an edit continues it. */
    function continued(selection: Parameters<typeof Timeline>[0]["selection"] = null) {
      const files = new Map(FILES)
      files.set("scenes/title.html", {
        text: TITLE.replace(
          "<h1>",
          '<video id="intro" src="media/talk.mp4" data-start="0" data-duration="3"></video>\n    <h1>'
        ),
      })
      files.set("scenes/talk.html", {
        text: TALK.replace(
          '    <video id="clip"',
          '    <video id="intro-2" src="media/talk.mp4" data-start="0" data-duration="2" data-media-start="3" data-continues="intro"></video>\n    <video id="clip"'
        ),
      })
      const state = new LiveVideo(createArtifactDocument("video", files)).getState()
      const shown = state.composition
      if (!shown) throw new Error("No video.")

      const selected: unknown[] = []
      const grouped: [string[], number][] = []
      const view = render(
        timeline({
          timeMs: 0,
          selection,
          composition: shown,
          clips: everySceneClips(state, shown),
          edits: {
            seek: () => {},
            select: (next: unknown) => selected.push(next),
            moveClip: () => {},
            moveClips: (clips: readonly { clip: { ref: string } }[], ms: number) =>
              grouped.push([clips.map((laid) => laid.clip.ref), ms]),
            trimClip: () => {},
            sceneLength: () => {},
            scene: {
              select: () => {},
              move: () => {},
              duplicate: () => {},
              remove: () => {},
              rename: () => {},
            },
          } as never,
        })
      )
      const block = (ref: string) => {
        const found = view.container.querySelector<HTMLElement>(`[data-timeline-clip="${ref}"]`)
        if (!found) throw new Error(`No clip ${ref} on the timeline.`)
        return found
      }
      return { view, selected, grouped, block }
    }

    // Guard proof: select the part pressed in onDragEnd (timeline.tsx),
    // `selectionOfClip(current.clip)`; the interview's part is then chosen alone. Drag the part
    // pressed alone in its press handler, and the title's stays put. Give every part both trim
    // handles, and the seam holds two that cut the clip in the middle.
    test("a clip that goes on in the next chapter is pressed, selected and dragged as one", () => {
      const pressed = continued()
      fireEvent.pointerDown(pressed.block("intro-2"), {
        button: 0,
        clientX: xAt(3500),
        pointerId: 1,
      })
      fireEvent.pointerUp(pressed.block("intro-2"), { clientX: xAt(3500), pointerId: 1 })
      expect(pressed.selected).toEqual([
        { type: "clip", file: "scenes/title.html", target: "intro" },
      ])

      fireEvent.pointerDown(pressed.block("intro-2"), {
        button: 0,
        clientX: xAt(3500),
        pointerId: 1,
      })
      fireEvent.pointerMove(pressed.block("intro-2"), {
        clientX: xAt(4500),
        pointerId: 1,
        shiftKey: true,
      })
      // Both parts follow the pointer.
      expect(pressed.block("intro").style.left).toBe("100px")
      fireEvent.pointerUp(pressed.block("intro-2"), {
        clientX: xAt(4500),
        pointerId: 1,
        shiftKey: true,
      })
      expect(pressed.grouped).toEqual([[["intro", "intro-2"], 1000]])
      cleanup()

      // Chosen, every part shows it; it is trimmed at its two ends only, one block across the edge.
      const chosen = continued({ type: "clip", file: "scenes/title.html", target: "intro" })
      expect(chosen.block("intro").getAttribute("aria-pressed")).toBe("true")
      expect(chosen.block("intro-2").getAttribute("aria-pressed")).toBe("true")
      const handles = (ref: string) =>
        [...chosen.block(ref).querySelectorAll<HTMLElement>(".cursor-ew-resize")].map((handle) =>
          handle.className.includes("left-0") ? "start" : "end"
        )
      expect(handles("intro")).toEqual(["start"])
      expect(handles("intro-2")).toEqual(["end"])
      expect(chosen.block("intro").className).toContain("rounded-r-none")
      expect(chosen.block("intro-2").querySelector("[data-seam]")).not.toBeNull()
    })

    // Guard proof: give each clip its chapter's start as its floor in onDragMove (timeline.tsx),
    // `floorMs: sceneStartOf(each.file)`, as the timeline had it: the group stops at the
    // interview's start, and moveClips is asked for no move at all.
    test("a clip dragged across a chapter's edge goes there, alone or with the clips selected", () => {
      const alone = film()
      // The caption, at 3.5 s in the interview, dragged two seconds sooner: into the title.
      fireEvent.pointerDown(alone.block("#1"), { button: 0, clientX: xAt(3500), pointerId: 1 })
      for (const ms of [3000, 2000, 1500]) {
        fireEvent.pointerMove(alone.block("#1"), { clientX: xAt(ms), pointerId: 1, shiftKey: true })
      }
      // It follows the pointer over the edge.
      expect(alone.block("#1").style.left).toBe("150px")
      fireEvent.pointerUp(alone.block("#1"), { clientX: xAt(1500), pointerId: 1, shiftKey: true })
      expect(alone.moved).toEqual([["scenes/talk.html", "#1", 1500]])
      cleanup()

      const together = film({
        type: "clips",
        clips: [
          { file: "scenes/talk.html", target: "clip" },
          {
            file: "scenes/talk.html",
            target: { ref: "#1", tag: "p", words: "Thanks for having me." },
          },
        ],
      })
      fireEvent.pointerDown(together.block("#1"), { button: 0, clientX: xAt(3500), pointerId: 1 })
      fireEvent.pointerMove(together.block("#1"), {
        clientX: xAt(500),
        pointerId: 1,
        shiftKey: true,
      })
      fireEvent.pointerUp(together.block("#1"), { clientX: xAt(500), pointerId: 1, shiftKey: true })
      // As far as the footage, at 3 s, can go: to the video's start.
      expect(together.grouped).toEqual([[["clip", "#1"], -3000]])
    })
  })

  // Guard proof: drop `memo` from ClipBlock in timeline.tsx; every caption's block is drawn again
  // at each move of the pointer, 301 of them, where only the one dragged moves.
  test("a drag draws again only what it moves, on a video of hundreds of captions", () => {
    // A 40 s video in four chapters of 10 s, each a recording under 75 captions of a word each.
    const scene = (id: string) => {
      const words = Array.from(
        { length: 75 },
        (_, index) =>
          `<p class="caption" data-start="${(index * 0.13).toFixed(2)}" data-duration="0.13">w${index}</p>`
      ).join("\n    ")
      return `<template>
  <div data-composition-id="${id}" data-width="1280" data-height="720">
    <video id="${id}-take" src="media/talk.mp4" data-start="0" data-duration="10" data-has-audio="true"></video>
    ${words}
  </div>
</template>`
    }
    const ids = ["one", "two", "three", "four"]
    const index = `<div data-composition-id="main" data-width="1280" data-height="720" data-duration="40">
  ${ids
    .map(
      (id, at) =>
        `<div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${at * 10}" data-duration="10"></div>`
    )
    .join("\n  ")}
</div>`
    const state = new LiveVideo(
      createArtifactDocument(
        "video",
        new Map([
          ["index.html", { text: index }],
          ...ids.map((id) => [`scenes/${id}.html`, { text: scene(id) }] as const),
          ["media/talk.mp4", { file: ref("media/talk.mp4") }],
        ])
      )
    ).getState()
    const shown = state.composition
    if (!shown) throw new Error("No video.")
    const clips = everySceneClips(state, shown)
    expect(clips).toHaveLength(304)

    // Each block reads its recording's parts as it draws, and React Query reads a hook's options
    // again once it is drawn: two reads are a block drawn.
    const queries = new QueryClient()
    const read = queries.defaultQueryOptions.bind(queries)
    let drawn = 0
    queries.defaultQueryOptions = ((options: Parameters<typeof read>[0]) => {
      drawn += 1
      return read(options)
    }) as typeof queries.defaultQueryOptions

    const view = render(
      wrap(
        <Timeline
          composition={shown}
          clips={clips}
          selection={null}
          timeMs={0}
          marks={{}}
          snapping
          agentScenes={new Set()}
          people={new Map()}
          target={TARGET}
          uploads={[]}
          toolbar={() => null}
          dropTarget={false}
          formatLength={(ms) => `${ms / 1000} s`}
          edits={{
            seek: () => {},
            select: () => {},
            moveClip: () => {},
            moveClips: () => {},
            trimClip: () => {},
            sceneLength: () => {},
            scene: {
              select: () => {},
              move: () => {},
              duplicate: () => {},
              remove: () => {},
              rename: () => {},
            },
          }}
        />,
        queries
      )
    )
    const word = view.container.querySelector<HTMLElement>(
      '[data-timeline-file="scenes/two.html"][data-timeline-clip="#40"]'
    )
    if (!word) throw new Error("No caption on the timeline.")

    fireEvent.pointerDown(word, { button: 0, clientX: 1000, pointerId: 1 })
    const before = drawn
    const moves = 30
    for (let step = 1; step <= moves; step += 1) {
      fireEvent.pointerMove(word, { clientX: 1000 + step * 7, pointerId: 1, shiftKey: true })
    }
    // The timeline itself, and the caption it moves: nothing else.
    expect((drawn - before) / moves / 2).toBeLessThanOrEqual(2)
    fireEvent.pointerUp(word, { clientX: 1000 + moves * 7, pointerId: 1, shiftKey: true })
  })

  // Reproduce by finding the dragged clip by identity, as the timeline did: a change that lands
  // mid-drag lays every clip out anew, and the block snaps back to where it was.
  test("keeps a clip where it is dragged when a change lands mid-drag", () => {
    const view = render(timeline({ timeMs: 0 }))
    const block = () => {
      const found = view.container.querySelector<HTMLElement>('[data-timeline-clip="clip"]')
      if (!found) throw new Error("No footage on the timeline.")
      return found
    }
    const before = block().style.left

    fireEvent.pointerDown(block(), { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(block(), { clientX: 160, pointerId: 1 })
    const dragged = block().style.left
    expect(dragged).not.toBe(before)

    // Someone else's edit: every clip laid out again, as new objects.
    view.rerender(timeline({ timeMs: 0, marks: { in: 9000 } }))
    expect(block().style.left).toBe(dragged)
    expect(block().className).toContain("shadow-lg")
  })
})
