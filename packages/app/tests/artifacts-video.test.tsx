import { afterEach, describe, expect, jest, test } from "bun:test"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { versionSummary } from "../src/artifacts/card-details"
import { ArtifactPreview } from "../src/artifacts/card-preview"
import { frameLinkKey } from "../src/artifacts/frame"
import { en, fr } from "../src/artifacts/messages"
import { chapterAt } from "../src/artifacts/renderers/video/chapters"
import {
  controlMessage,
  HYPERFRAMES_PROTOCOL_VERSION,
  initialPlayback,
  playbackAfter,
  readReport,
} from "../src/artifacts/renderers/video/hyperframes"
import { playerKeyAction, typesItself } from "../src/artifacts/renderers/video/keys"
import { startOf, VideoRenderer } from "../src/artifacts/renderers/video/renderer"
import { artifactVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "MessageEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

// A fake-timer test that times out never reaches its `finally`.
afterEach(() => jest.useRealTimers())

// A video in the app: HyperFrames' runtime plays it in its frame, and the app drives it in the
// runtime's own messages, through one adapter.

const FILM = artifactVersion({
  artifactId: "art_v1de0f17m0",
  title: "Launch film",
  entry: "index.html",
  files: textFiles({ "index.html": "<div></div>" }),
  outline: {
    kind: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 7000,
    scenes: [
      { id: "intro", label: "Opening", startMs: 0, durationMs: 2000, renderKey: "a" },
      { id: "demo", startMs: 2000, durationMs: 3000, renderKey: "b" },
      { id: "outro", label: "Thanks", startMs: 5500, durationMs: 1500, renderKey: "c" },
    ],
  },
})
const OUTLINE = FILM.outline.kind === "video" ? FILM.outline : null
if (!OUTLINE) throw new Error("Expected a video.")

/** What a runtime of this release says beside every report. */
const RUNTIME = {
  source: "hf-preview",
  protocolVersion: 1,
  capabilities: ["seconds-time", "rational-fps", "seek-keep-playing"],
  fps: { numerator: 30, denominator: 1 },
}

describe("the HyperFrames adapter", () => {
  test("posts each control with the protocol's version and the video's frame rate", () => {
    expect(controlMessage({ action: "play" }, 30)).toEqual({
      source: "hf-parent",
      type: "control",
      action: "play",
      protocolVersion: HYPERFRAMES_PROTOCOL_VERSION,
      capabilities: ["seconds-time"],
      fps: { numerator: 30, denominator: 1 },
    })
    expect(controlMessage({ action: "seek", seconds: 2.5, mode: "drag" }, 25)).toMatchObject({
      action: "seek",
      timeSeconds: 2.5,
      frame: 63,
      seekMode: "drag",
    })
    expect(controlMessage({ action: "set-playback-rate", rate: 1.5 }, 30)).toMatchObject({
      action: "set-playback-rate",
      playbackRate: 1.5,
    })
  })

  test("reads the runtime's reports, and nothing of another protocol", () => {
    expect(readReport({ ...RUNTIME, type: "ready" })).toEqual({ type: "ready" })
    expect(readReport({ ...RUNTIME, type: "timeline", durationSeconds: 11 })).toEqual({
      type: "timeline",
      duration: 11,
    })
    expect(
      readReport({ ...RUNTIME, type: "state", currentTime: 1.5, isPlaying: true, ended: false })
    ).toEqual({ type: "state", time: 1.5, playing: true, buffering: false, ended: false })
    expect(readReport({ ...RUNTIME, type: "media-autoplay-blocked" })).toEqual({
      type: "sound-blocked",
    })
    expect(
      readReport({ ...RUNTIME, type: "diagnostic", code: "runtime_media_load_failed" })
    ).toEqual({ type: "media-failed" })

    // The frame's own protocol, a report the player does not read, and a state with no time.
    expect(readReport({ protocol: FRAME_PROTOCOL, event: "ready" })).toBeNull()
    expect(readReport({ ...RUNTIME, type: "analytics" })).toBeNull()
    expect(readReport({ ...RUNTIME, type: "state", currentTime: "soon" })).toBeNull()
  })

  // Reproduce by reading only `runtime_media_load_failed` in `mediaFailed` (hyperframes.ts): a
  // recording the browser cannot read at all is reported the other way, and plays black.
  test("reads a recording that could not load, however the runtime says it", () => {
    const failed = (tagName: string) =>
      readReport({
        ...RUNTIME,
        type: "diagnostic",
        code: "runtime_asset_load_failed",
        details: { tagName, assetUrl: "media/clip.mp4" },
      })
    expect(failed("video")).toEqual({ type: "media-failed" })
    expect(failed("AUDIO")).toEqual({ type: "media-failed" })
    expect(failed("source")).toEqual({ type: "media-failed" })

    // An image the frame could not load is not a recording.
    expect(failed("img")).toBeNull()
  })

  // Guard proof: return true from `supported` in hyperframes.ts; the first two read as reports.
  test("refuses a runtime of another version, or one that cannot seek by seconds", () => {
    expect(readReport({ ...RUNTIME, protocolVersion: 2, type: "ready" })).toEqual({
      type: "unsupported",
    })
    expect(readReport({ ...RUNTIME, capabilities: ["rational-fps"], type: "ready" })).toEqual({
      type: "unsupported",
    })
    expect(
      readReport({ ...RUNTIME, fps: { numerator: 0, denominator: 1 }, type: "ready" })
    ).toEqual({ type: "unsupported" })
  })

  test("is ready once the timeline is built, follows each state, and stays failed", () => {
    let state = initialPlayback(7)
    state = playbackAfter(state, { type: "ready" })
    expect(state.phase).toBe("loading")

    state = playbackAfter(state, { type: "timeline", duration: 7.2 })
    expect(state).toMatchObject({ phase: "ready", duration: 7.2 })

    const same = playbackAfter(state, {
      type: "state",
      time: 0,
      playing: false,
      buffering: false,
      ended: false,
    })
    expect(same).toBe(state)

    state = playbackAfter(state, {
      type: "state",
      time: 9,
      playing: true,
      buffering: true,
      ended: false,
    })
    expect(state).toMatchObject({ time: 7.2, playing: true, buffering: true })

    state = playbackAfter(state, { type: "unsupported" })
    expect(state).toMatchObject({ phase: "failed", playing: false })
    expect(playbackAfter(state, { type: "timeline", duration: 3 })).toBe(state)
  })
})

describe("the player's keys", () => {
  const key = (name: string, paused: boolean, shiftKey = false) =>
    playerKeyAction({ key: name, shiftKey, metaKey: false, ctrlKey: false, altKey: false }, paused)

  test("play, skip, step frames while paused, and go to either end", () => {
    expect(key(" ", false)).toEqual({ type: "toggle" })
    expect(key("k", true)).toEqual({ type: "toggle" })
    expect(key("j", false)).toEqual({ type: "skip", seconds: -10 })
    expect(key("L", false)).toEqual({ type: "skip", seconds: 10 })
    expect(key("ArrowLeft", false)).toEqual({ type: "skip", seconds: -5 })
    expect(key("ArrowRight", false, true)).toEqual({ type: "skip", seconds: 5 })
    expect(key("ArrowRight", true, true)).toEqual({ type: "step", frames: 1 })
    expect(key(",", true)).toEqual({ type: "step", frames: -1 })
    expect(key(".", false)).toBeNull()
    expect(key("Home", false)).toEqual({ type: "start" })
    expect(key("End", false)).toEqual({ type: "end" })
    expect(key("m", false)).toEqual({ type: "mute" })
    expect(key("f", false)).toEqual({ type: "fullscreen" })
    expect(key("c", false)).toEqual({ type: "comment" })
    expect(playerKeyAction({ key: "k", metaKey: true } as KeyboardEvent, false)).toBeNull()
  })

  test("leave a field's typing, and a focused button's Space, alone", () => {
    const field = document.createElement("textarea")
    const button = document.createElement("button")
    expect(typesItself(field, "k")).toBe(true)
    expect(typesItself(button, " ")).toBe(true)
    expect(typesItself(button, "k")).toBe(false)
    expect(typesItself(document.createElement("div"), " ")).toBe(false)
  })
})

describe("a video's chapters and addresses", () => {
  test("the chapter at an instant is the scene that started last by then", () => {
    expect(chapterAt(OUTLINE, 0)?.id).toBe("intro")
    expect(chapterAt(OUTLINE, 2)?.id).toBe("demo")
    // Between the demo's end and the outro's start, the demo is still the chapter.
    expect(chapterAt(OUTLINE, 5.2)?.id).toBe("demo")
    expect(chapterAt(OUTLINE, 6)?.id).toBe("outro")
  })

  test("opens at the scene or the instant an address names", () => {
    expect(startOf(FILM, OUTLINE, "demo")).toBe(2)
    expect(startOf(FILM, OUTLINE, "t=6.5")).toBe(6.5)
    expect(startOf(FILM, OUTLINE, "credits")).toBe(0)
    expect(startOf(FILM, OUTLINE, undefined)).toBe(0)
  })
})

function Wrap({ cache, children }: { readonly cache: QueryClient; readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={cache}>
      <LocaleProvider>{children}</LocaleProvider>
    </QueryClientProvider>
  )
}

/** A cache that reads nothing itself, with the video's frame link minted already. */
function frameCache(): QueryClient {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  cache.setQueryData(frameLinkKey(FILM), {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-11-18T13:00:00.000Z",
  })
  return cache
}

/** The player rendered, its frame loaded, and a way to speak as the runtime in it. */
async function openPlayer(part?: string) {
  const view = render(
    <Wrap cache={frameCache()}>
      <VideoRenderer version={FILM} {...(part ? { part } : {})} />
    </Wrap>
  )
  const frame = view.container.querySelector("iframe")
  const target = frame?.contentWindow
  if (!target) throw new Error("Expected a loaded frame.")

  const posted: Record<string, unknown>[] = []
  target.postMessage = ((message: Record<string, unknown>) => {
    posted.push(message)
  }) as never
  const runtime = async (data: Record<string, unknown>) => {
    await act(async () => {
      browser.dispatchEvent(new browser.MessageEvent("message", { data, source: target as never }))
    })
  }
  const controls = () =>
    posted.filter((message) => message.source === "hf-parent").map((message) => message.action)

  // The frame's own runtime says it is ready; HyperFrames' builds the timeline.
  await runtime({ protocol: FRAME_PROTOCOL, event: "ready", params: {} })
  await runtime({ ...RUNTIME, type: "ready" })
  await runtime({ ...RUNTIME, type: "timeline", durationSeconds: 7 })
  await runtime({ ...RUNTIME, type: "assets-ready" })

  const screen = view.container.querySelector<HTMLElement>("[data-video-screen]")
  if (!screen) throw new Error("Expected the player's screen.")
  return { view, frame, posted, runtime, controls, screen }
}

describe("the player", () => {
  test("plays the frame with sound allowed, and its runtime plays and pauses as asked", async () => {
    const { view, frame, controls, runtime } = await openPlayer()
    expect(frame?.getAttribute("allow")).toBe("autoplay; fullscreen")
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-modals")

    fireEvent.click(view.getAllByRole("button", { name: "Play" })[0] as HTMLElement)
    expect(controls()).toContain("play")

    // From its poster, it lands on its start first.
    await runtime({ ...RUNTIME, type: "state", currentTime: 0, isPlaying: true })
    await runtime({ ...RUNTIME, type: "state", currentTime: 1, isPlaying: true })
    expect(view.getByRole("slider", { name: "Position" }).getAttribute("aria-valuetext")).toBe(
      "0:01 of 0:07, Opening"
    )
    fireEvent.click(view.getAllByRole("button", { name: "Pause" })[0] as HTMLElement)
    expect(controls().at(-1)).toBe("pause")
  })

  // Guard proof: drop the seek in the effect that starts the video in player.tsx; it opens at 0.
  test("opens at an address's instant once the runtime has built its timeline", async () => {
    const { posted } = await openPlayer("t=4.5")
    const seek = posted.find((message) => message.action === "seek")
    expect(seek).toMatchObject({ timeSeconds: 4.5, frame: 135 })
  })

  test("answers the keys, and steps one frame at a time while paused", async () => {
    const { screen, posted, controls } = await openPlayer()

    fireEvent.keyDown(screen, { key: "l" })
    expect(posted.at(-1)).toMatchObject({ action: "seek", timeSeconds: 7 })

    fireEvent.keyDown(screen, { key: "Home" })
    fireEvent.keyDown(screen, { key: "." })
    expect(posted.at(-1)).toMatchObject({ action: "seek", frame: 1 })

    fireEvent.keyDown(screen, { key: "m" })
    expect(posted.at(-1)).toMatchObject({ action: "set-muted", muted: true })
    expect(screen.querySelector("[role=status]")?.textContent).toBe("Muted")

    fireEvent.keyDown(screen, { key: "k" })
    expect(controls().at(-1)).toBe("play")
  })

  test("goes to a chapter's start from the chapters", async () => {
    const { view, posted } = await openPlayer()
    // A wide player opens on its chapters; a narrower one opens them from its bar.
    if (!view.queryByRole("complementary", { name: "Chapters" })) {
      fireEvent.click(view.getByRole("button", { name: "Chapters" }))
    }
    const chapters = view.getByRole("complementary", { name: "Chapters" })
    fireEvent.click(within(chapters).getByText("Thanks"))
    expect(posted.at(-1)).toMatchObject({ action: "seek", timeSeconds: 5.5 })
  })

  test("drags the playhead through the frames, and lands where it is let go", async () => {
    const { view, posted } = await openPlayer()
    const track = view.getByRole("slider", { name: "Position" })
    track.getBoundingClientRect = () => ({ left: 0, width: 700, top: 0, height: 20 }) as DOMRect
    posted.length = 0

    fireEvent.pointerDown(track, { button: 0, clientX: 175, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 350, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 350, pointerId: 1 })

    const seeks = posted.filter((message) => message.action === "seek")
    expect(seeks.map(({ timeSeconds, seekMode }) => [timeSeconds, seekMode])).toEqual([
      [1.75, "drag"],
      [3.5, "drag"],
      [3.5, "commit"],
    ])
  })

  test("says it could not start, and tries again, when the runtime never builds the timeline", async () => {
    jest.useFakeTimers()
    const view = render(
      <Wrap cache={frameCache()}>
        <VideoRenderer version={FILM} />
      </Wrap>
    )
    const target = view.container.querySelector("iframe")?.contentWindow
    target!.postMessage = (() => {}) as never
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, event: "ready", params: {} },
          source: target as never,
        })
      )
    })
    act(() => {
      jest.advanceTimersByTime(20_000)
    })

    expect(view.getByRole("alert").textContent).toContain("This video couldn’t start")
    const before = view.container.querySelector("iframe")
    fireEvent.click(view.getByRole("button", { name: "Try again" }))
    expect(view.queryByRole("alert")).toBeNull()
    expect(view.container.querySelector("iframe")).not.toBe(before)
  })

  test("says at once it could not start when the frame says HyperFrames' runtime did not load", async () => {
    // Reproduce by dropping the `failed` event in player.tsx's `onEvent`: no alert shows until the
    // start timeout.
    const view = render(
      <Wrap cache={frameCache()}>
        <VideoRenderer version={FILM} />
      </Wrap>
    )
    const target = view.container.querySelector("iframe")?.contentWindow
    target!.postMessage = (() => {}) as never
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, event: "failed", params: {} },
          source: target as never,
        })
      )
    })

    expect(view.getByRole("alert").textContent).toContain("This video couldn’t start")
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy()
  })

  test("opens on a poster from its first scene, and plays from its start", async () => {
    // Reproduce by dropping `playback.cue` from the effect that starts the video in player.tsx: no
    // seek is posted, and the stage shows the opening's first, often blank, frame.
    const { view, posted, runtime } = await openPlayer()
    // 70% into the opening's 2 seconds, where it has come in.
    expect(posted.filter((message) => message.action === "seek")).toMatchObject([
      { timeSeconds: 1.4 },
    ])

    // The poster's frame is not where the playhead is.
    await runtime({ ...RUNTIME, type: "state", currentTime: 1.4, isPlaying: false })
    const track = view.getByRole("slider", { name: "Position" })
    expect(track.getAttribute("aria-valuetext")).toBe("0:00 of 0:07, Opening")

    posted.length = 0
    fireEvent.click(view.getAllByRole("button", { name: "Play" })[0] as HTMLElement)
    expect(posted.map(({ action, timeSeconds }) => [action, timeSeconds])).toEqual([
      ["seek", 0],
      ["play", undefined],
    ])
  })

  test("opens on the instant its root's data-poster names", async () => {
    // Reproduce by dropping the `posterMs` read from `posterAt` in player.tsx.
    const outline = { ...OUTLINE, posterMs: 4200 }
    const view = render(
      <Wrap cache={frameCache()}>
        <VideoRenderer version={{ ...FILM, outline }} />
      </Wrap>
    )
    const target = view.container.querySelector("iframe")?.contentWindow
    const posted: Record<string, unknown>[] = []
    target!.postMessage = ((message: Record<string, unknown>) => posted.push(message)) as never
    for (const data of [
      { protocol: FRAME_PROTOCOL, event: "ready", params: {} },
      { ...RUNTIME, type: "ready" },
      { ...RUNTIME, type: "timeline", durationSeconds: 7 },
    ]) {
      await act(async () => {
        browser.dispatchEvent(
          new browser.MessageEvent("message", { data, source: target as never })
        )
      })
    }

    expect(posted.find((message) => message.action === "seek")).toMatchObject({ timeSeconds: 4.2 })
  })

  test("shows its large play mark before the first play and at the end, never on a pause", async () => {
    // Reproduce by showing `BigPlay` whenever the video is paused in player.tsx.
    const { view, runtime } = await openPlayer()
    const bigPlay = () => view.container.querySelector("[data-video-big-play]")
    expect(bigPlay()?.getAttribute("aria-label")).toBe("Play")

    await runtime({ ...RUNTIME, type: "state", currentTime: 2, isPlaying: true })
    await runtime({ ...RUNTIME, type: "state", currentTime: 3, isPlaying: false })
    expect(bigPlay()).toBeNull()

    await runtime({ ...RUNTIME, type: "state", currentTime: 7, isPlaying: false, ended: true })
    expect(bigPlay()?.getAttribute("aria-label")).toBe("Play again")
  })

  test("leaves the picture clean once the reader moved the playhead, before any play", async () => {
    // Reproduce by dropping `setBegun(true)` from `goTo` in player.tsx.
    const { screen, view } = await openPlayer()
    fireEvent.keyDown(screen, { key: "l" })
    expect(view.container.querySelector("[data-video-big-play]")).toBeNull()
  })

  test("says on the picture when a recording it plays could not load", async () => {
    const { view, runtime } = await openPlayer()
    expect(view.queryByText("A clip in this video couldn’t load")).toBeNull()

    await runtime({
      ...RUNTIME,
      type: "diagnostic",
      code: "runtime_asset_load_failed",
      details: { tagName: "video", assetUrl: "media/clip.mp4" },
    })
    expect(view.getByText("A clip in this video couldn’t load")).toBeTruthy()
  })

  test("says a runtime of another version cannot play the video", async () => {
    const { view, runtime } = await openPlayer()
    await runtime({ ...RUNTIME, protocolVersion: 2, type: "state", currentTime: 0 })
    expect(view.getByRole("alert").textContent).toContain("This video can’t play here")
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull()
  })
})

describe("a video's card and words", () => {
  test("is a dark screen on its card, its scenes along its length", () => {
    const view = render(
      <Wrap cache={new QueryClient()}>
        <ArtifactPreview version={FILM} kind="video" loading={false} />
      </Wrap>
    )
    const scenes = [...view.container.querySelectorAll<HTMLElement>("[style*='left']")]
    expect(scenes.map((scene) => [scene.style.left, scene.style.width])).toEqual([
      ["0%", `${(2 / 7) * 100}%`],
      [`${(2 / 7) * 100}%`, `${(3 / 7) * 100}%`],
      [`${(5.5 / 7) * 100}%`, `${(1.5 / 7) * 100}%`],
    ])
  })

  test("is summed up by its length and its scenes", () => {
    expect(versionSummary(FILM, en, "en")).toBe("Video · 0:07 · 3 scenes")
    expect(versionSummary(FILM, fr, "fr")).toBe("Vidéo · 0:07 · 3 scènes")
  })

  test("is counted and missed in the gallery, in the feminine in French", () => {
    expect(en.gallery.count(1, "video")).toBe("1 video")
    expect(en.gallery.emptyKind("video")).toBe("No videos yet")
    expect(fr.gallery.count(2, "video")).toBe("2 vidéos")
    expect(fr.gallery.emptyKind("video")).toBe("Aucune vidéo pour l’instant")
  })
})
