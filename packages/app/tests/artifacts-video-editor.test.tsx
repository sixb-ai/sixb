import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactMediaResponse } from "@sixb/client"
import {
  type LiveFiles,
  readVideoComposition,
  setSceneLength,
  splitClip,
} from "@sixb/core/artifacts/live"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import * as Y from "yjs"
import { createArtifactDocument } from "../../core/src/artifacts/live/document"
import { LiveVideo } from "../src/artifacts/live/video"
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
  layClips,
  nextEditPoint,
  rulerSteps,
  sceneSpans,
  snapMove,
  snapTo,
  trackRows,
  zoomAround,
} from "../src/artifacts/renderers/video/editor/model"
import { RenameField, SceneBlock } from "../src/artifacts/renderers/video/editor/scenes"
import { heardRecordings, laidClips } from "../src/artifacts/renderers/video/editor/selection"
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
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "HTMLImageElement",
  "Event",
  "CustomEvent",
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

/**
 * Types into a field as React reads it here: it loaded before the window, so it watches the keys
 * a change comes with, as for a browser without `input` events.
 */
function typeIn(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) ?? "a" })
}

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
          target={{ artifactId: "art_video", version: 1, files: [] }}
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
            clipSound: noop,
            text: noop,
            clipText: noop,
            removeClip: noop,
            splitClip: noop,
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

  function tab(sceneId: string, timeMs: number) {
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
        onSeek={() => {}}
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

describe("the timeline", () => {
  const video = () => {
    const state = new LiveVideo(createArtifactDocument("video", FILES)).getState()
    const shown = state.composition
    if (!shown) throw new Error("No composition.")
    return { state, composition: shown, talk: shown.scenes[1] }
  }

  function timeline(props: Partial<Parameters<typeof Timeline>[0]> & { readonly timeMs: number }) {
    const { state, composition, talk } = video()
    return wrap(
      <Timeline
        composition={composition}
        clips={laidClips(state, composition, talk)}
        open={talk}
        selection={null}
        marks={{}}
        snapping
        agentScenes={new Set()}
        people={new Map()}
        timelines={state.timelines}
        target={{ artifactId: "art_video", version: 1, files: [] }}
        uploads={[]}
        toolbar={() => null}
        dropTarget={false}
        formatLength={(ms) => `${ms / 1000} s`}
        edits={{
          seek: () => {},
          select: () => {},
          open: () => {},
          moveClip: () => {},
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
