import { afterEach, describe, expect, test } from "bun:test"
import {
  type LiveFiles,
  readVideoComposition,
  setSceneLength,
  splitClip,
} from "@sixb/core/artifacts/live"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import * as Y from "yjs"
import { createArtifactDocument } from "../../core/src/artifacts/live/document"
import { LiveVideo } from "../src/artifacts/live/video"
import { importKind } from "../src/artifacts/renderers/video/editor/import"
import { formatSeconds, parseSeconds } from "../src/artifacts/renderers/video/editor/inspector"
import {
  editPoints,
  layClips,
  nextEditPoint,
  rulerSteps,
  snapMove,
  snapTo,
  trackRows,
  zoomAround,
} from "../src/artifacts/renderers/video/editor/model"
import { SceneBlock } from "../src/artifacts/renderers/video/editor/scenes"
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
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLImageElement",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
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

  test("clips that overlap lie on rows of their own, by track", () => {
    const timeline = {
      composition: { element: { start: 0, end: 0 }, tag: { start: 0, end: 0 }, attributes: {} },
      texts: [],
      clips: [
        { ref: "a", track: "picture", startMs: 0, durationMs: 2000 },
        { ref: "b", track: "picture", startMs: 1000, durationMs: 2000 },
        { ref: "c", track: "picture", startMs: 2500, durationMs: 1000 },
        { ref: "d", track: "sound", startMs: 0 },
      ],
    } as never
    const laid = layClips(timeline, "scenes/a.html", 4000, 9000)
    expect(
      laid.map((clip) => [clip.clip.ref, clip.startMs, clip.endMs, clip.row, clip.open])
    ).toEqual([
      ["a", 4000, 6000, 0, false],
      ["b", 5000, 7000, 1, false],
      ["c", 6500, 7500, 0, false],
      ["d", 4000, 9000, 0, true],
    ])
    expect(trackRows(laid)).toEqual({ picture: 2, text: 1, sound: 1 })
  })

  test("the arrows jump between every scene's and clip's edges", () => {
    const points = editPoints(composition(), [])
    expect(points).toEqual([0, 3000, 10_000])
    expect(nextEditPoint(points, 0, 1)).toBe(3000)
    expect(nextEditPoint(points, 3000, -1)).toBe(0)
    expect(nextEditPoint(points, 10_000, 1)).toBeUndefined()
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
    // "um,": from 120 ms after "So," ends to 120 ms before "thanks" starts.
    expect(wordsCut(WORDS, 1, 1, BOUNDS)).toEqual({ startMs: 520, endMs: 1180 })
    // Words closer than twice the air split the pause between them.
    expect(wordsCut(WORDS, 3, 3, BOUNDS)).toEqual({ startMs: 1625, endMs: 1825 })
  })

  test("a cut never reaches into a word kept, and lands on a cut of the picture nearby", () => {
    const cut = wordsCut(WORDS, 1, 1, BOUNDS, [500])
    expect(cut).toEqual({ startMs: 500, endMs: 1180 })
    // A picture cut inside a word kept is no place to land.
    expect(wordsCut(WORDS, 1, 1, BOUNDS, [300])).toEqual({ startMs: 520, endMs: 1180 })
  })

  test("the first and last words cut to the ends of the clip", () => {
    expect(wordsCut(WORDS, 0, 0, BOUNDS)).toEqual({ startMs: 0, endMs: 680 })
    expect(wordsCut(WORDS, 5, 5, BOUNDS)).toEqual({ startMs: 2420, endMs: 5000 })
  })

  test("silences longer than a breath are shortened to the air either side", () => {
    expect(silences(WORDS, BOUNDS)).toEqual([
      { startMs: 2420, endMs: 3880 },
      { startMs: 4520, endMs: 5000 },
    ])
  })

  test("filler words are found whatever their case and punctuation", () => {
    expect(isFiller("Um,")).toBe(true)
    expect(isFiller("euh…")).toBe(true)
    expect(isFiller("umbrella")).toBe(false)
    expect(fillers(WORDS, BOUNDS)).toEqual([{ startMs: 520, endMs: 1180 }])
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

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <LocaleProvider>{children}</LocaleProvider>
    </QueryClientProvider>
  )
}

describe("the editor's pieces", () => {
  test("a scene on the timeline opens, moves with Alt and an arrow, and renames on a double click", () => {
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
          timeline={undefined}
          target={{ artifactId: "art_video", version: 1 }}
          open={false}
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

    const block = view.getByRole("button", { name: "Scene 2, Interview, 7 s" })
    expect(block.parentElement?.className).toContain("sixb-agent-board")
    expect(block.getAttribute("title")).toBe("The agent is editing this scene")

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
})
