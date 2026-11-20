import { afterAll, afterEach, describe, expect, jest, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import { versionSummary } from "../src/artifacts/card-details"
import { ArtifactPreview } from "../src/artifacts/card-preview"
import { CommentModeHint } from "../src/artifacts/comments/commenting"
import type { ArtifactComment, CommentThread } from "../src/artifacts/comments/comments"
import { frameLinkKey } from "../src/artifacts/frame"
import { en, fr } from "../src/artifacts/messages"
import { chapterAt, chapterStart } from "../src/artifacts/renderers/video/chapters"
import {
  draftAnchor,
  type VideoCommenting,
  VideoCommentPins,
} from "../src/artifacts/renderers/video/comments"
import {
  controlMessage,
  HYPERFRAMES_PROTOCOL_VERSION,
  initialPlayback,
  playbackAfter,
  readReport,
} from "../src/artifacts/renderers/video/hyperframes"
import { playerKeyAction, typesItself } from "../src/artifacts/renderers/video/keys"
import { startOf, VideoRenderer } from "../src/artifacts/renderers/video/renderer"
import { type ArtifactViewContext, ArtifactViewProvider } from "../src/artifacts/view-context"
import { artifactVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "location",
  "localStorage",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
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

/** The same film, its last scene starting between two of its frames, as a scene often does. */
const BETWEEN_FRAMES = artifactVersion({
  ...FILM,
  outline: {
    ...OUTLINE,
    scenes: OUTLINE.scenes.map((scene) =>
      scene.id === "outro" ? { ...scene, startMs: 5510, durationMs: 1490 } : scene
    ),
  },
})

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

  // Guard proof: return `scene.startMs / 1000` from `chapterStart` in chapters.tsx; the runtime
  // shows the frame at or before 5.51 s, the demo's last, and the chapter reads as the demo.
  test("goes to a chapter's first frame, the next one when it starts between two", () => {
    const outline = BETWEEN_FRAMES.outline.kind === "video" ? BETWEEN_FRAMES.outline : OUTLINE
    const outro = outline.scenes[2]
    if (!outro) throw new Error("Expected the outro.")

    expect(chapterStart(outro, 30)).toBe(166 / 30)
    expect(chapterAt(outline, Math.floor(5.51 * 30) / 30)?.id).toBe("demo")
    expect(chapterAt(outline, chapterStart(outro, 30))?.id).toBe("outro")
    expect(startOf(BETWEEN_FRAMES, outline, "outro")).toBe(166 / 30)

    // A scene starting on a frame starts there.
    expect(chapterStart({ ...outro, startMs: 5500 }, 30)).toBe(5.5)
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
async function openPlayer(part?: string, viewer?: ArtifactViewContext, version = FILM) {
  const player = <VideoRenderer version={version} {...(part ? { part } : {})} />
  const view = render(
    <Wrap cache={frameCache()}>
      {viewer ? <ArtifactViewProvider value={viewer}>{player}</ArtifactViewProvider> : player}
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

/**
 * Lays the player out at these sizes, which the test DOM never computes: the app's root, by its
 * width, the screen's picture, and the bar's height. Returns what puts the DOM's own back.
 */
function stubSizes(sizes: {
  readonly root: number
  readonly screen: readonly [number, number]
  readonly bar: number
}): () => void {
  const prototype = browser.HTMLElement.prototype
  const measured = (element: Element, key: "clientWidth" | "clientHeight") => {
    const width = key === "clientWidth"
    if (element.hasAttribute("data-video-bar")) return width ? sizes.screen[0] : sizes.bar
    if (element.matches("[data-video-screen] > :first-child")) return sizes.screen[width ? 0 : 1]
    if (element.hasAttribute("data-sixb-artifact")) return width ? sizes.root : 0
    return 0
  }
  const keys = ["clientWidth", "clientHeight"] as const
  for (const key of keys) {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get(this: Element) {
        return measured(this, key)
      },
    })
  }
  return () => {
    for (const key of keys) Reflect.deleteProperty(prototype, key)
  }
}

/** Where the picture is on the screen, as the layer over it is laid out. */
function pictureOf(container: HTMLElement): { top: number; height: number } {
  const layer = container.querySelector<HTMLElement>("[data-video-picture]")
  return {
    top: Number.parseFloat(layer?.style.top ?? ""),
    height: Number.parseFloat(layer?.style.height ?? ""),
  }
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

  // Guard proof: go to `scene.startMs / 1000` in `goToChapter` in player.tsx; the seek asks for
  // 5.51 s, which the runtime shows as the demo's last frame.
  test("lands on the first frame of a chapter that starts between two", async () => {
    const { view, posted, runtime } = await openPlayer(undefined, undefined, BETWEEN_FRAMES)
    if (!view.queryByRole("complementary", { name: "Chapters" })) {
      fireEvent.click(view.getByRole("button", { name: "Chapters" }))
    }
    fireEvent.click(
      within(view.getByRole("complementary", { name: "Chapters" })).getByText("Thanks")
    )
    expect(posted.at(-1)).toMatchObject({ action: "seek", timeSeconds: 166 / 30, frame: 166 })

    await runtime({ ...RUNTIME, type: "state", currentTime: 166 / 30, isPlaying: false })
    expect(view.getByRole("slider", { name: "Position" }).getAttribute("aria-valuetext")).toBe(
      "0:05 of 0:07, Thanks"
    )
  })

  test("plays the chapter just picked on Space, rather than picking it again", async () => {
    // Reproduce by dropping the focus from `goToChapter` in player.tsx: Space presses the chapter's
    // button again, which goes back to its start.
    const { view, controls } = await openPlayer()
    if (!view.queryByRole("complementary", { name: "Chapters" })) {
      fireEvent.click(view.getByRole("button", { name: "Chapters" }))
    }
    const chapter = within(view.getByRole("complementary", { name: "Chapters" }))
      .getByText("Thanks")
      .closest("button") as HTMLElement
    chapter.focus()
    fireEvent.click(chapter)

    fireEvent.keyDown(document.activeElement as Element, { key: " " })
    expect(controls().at(-1)).toBe("play")
  })

  test("says on the picture that a link to the instant was copied", async () => {
    // Reproduce by dropping the copied notice from player.tsx: the menu that said it has closed.
    const copied: string[] = []
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    })
    try {
      const { view } = await openPlayer(undefined, {
        access: "owner",
        latestVersion: FILM.version,
        revision: FILM.revision,
      })
      await act(async () => {
        fireEvent.pointerDown(view.getByRole("button", { name: "Settings" }), {
          button: 0,
          ctrlKey: false,
          pointerType: "mouse",
        })
      })
      const item = await view.findByRole("menuitem", { name: "Copy link at 0:00" })
      await act(async () => {
        fireEvent.click(item)
      })

      expect(copied).toEqual([expect.stringContaining("part=t%3D0")])
      expect(view.queryByRole("menu")).toBeNull()
      expect(view.getByText("Link copied")).toBeTruthy()
    } finally {
      Reflect.deleteProperty(navigator, "clipboard")
    }
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

  // Guard proof: leave `room` at 0 in player.tsx, and the paused bar lies over the picture's foot,
  // where the film writes its captions; make `paused` wait for `controls.shown` again, or drop
  // `!playing` from `shown` in `useControlsShown`, and the picture grows each time the mouse leaves
  // it and shrinks as it comes back, a comment's pin moving away from the pointer reaching for it.
  // Drop `playback.playing` from the tap in `onPictureClick`, and a tap on a paused tablet does
  // nothing.
  test("keeps its bar under a paused picture wherever the pointer is, and over it as it plays", async () => {
    // The screen is 1280 by 720, as the video, and its bar 80 high.
    const restore = stubSizes({ root: 1280, screen: [1280, 720], bar: 80 })
    const global = globalThis as { matchMedia?: unknown }
    global.matchMedia = (query: string) => ({ matches: query === "(hover: hover)" })
    try {
      const { view, screen, runtime, controls } = await openPlayer()

      // Opened on its poster, the mouse elsewhere: the bar shows, under the picture.
      const paused = pictureOf(view.container)
      expect(screen.hasAttribute("data-controls")).toBe(true)
      expect(paused.top + paused.height).toBeLessThanOrEqual(720 - 80)

      // The mouse coming and going moves nothing.
      fireEvent.pointerMove(screen, { pointerType: "mouse" })
      expect(pictureOf(view.container)).toEqual(paused)
      fireEvent.pointerLeave(screen, { pointerType: "mouse" })
      expect(pictureOf(view.container)).toEqual(paused)
      expect(screen.hasAttribute("data-controls")).toBe(true)

      // Playing, the picture fills the screen, and the bar leaves with the mouse.
      await runtime({ ...RUNTIME, type: "state", currentTime: 1, isPlaying: true })
      expect(pictureOf(view.container)).toEqual({ top: 0, height: 720 })
      fireEvent.pointerLeave(screen, { pointerType: "mouse" })
      expect(screen.hasAttribute("data-controls")).toBe(false)

      // Paused again, at a key with the mouse elsewhere: the bar is back under the picture.
      await runtime({ ...RUNTIME, type: "state", currentTime: 2, isPlaying: false })
      expect(screen.hasAttribute("data-controls")).toBe(true)
      expect(pictureOf(view.container)).toEqual(paused)

      // A bar that stays has nothing for a tap to hide: a tap plays, as a click does.
      const layer = view.container.querySelector("[data-video-picture] > div")
      fireEvent.pointerUp(layer as Element, { button: 0, pointerType: "touch" })
      expect(controls().at(-1)).toBe("play")
    } finally {
      delete global.matchMedia
      restore()
    }
  })

  // Guard proof: drop `docked` from `room` in player.tsx, or the screen's `paddingBottom`; on a
  // phone the picture then shrinks to make room as it pauses, or the bar lies on it as it plays.
  // Drop `!docked` from the tap in `onPictureClick`: a tap hides a bar that never hides.
  test("on a phone, docks its bar under the picture, which never shrinks or moves", async () => {
    // A phone 390 wide: the 16:9 picture is 219.375 high, and the screen as much as its bar more.
    const restore = stubSizes({ root: 390, screen: [390, 219.375 + 48], bar: 48 })
    try {
      const { view, screen, runtime, controls } = await openPlayer()
      expect(screen.style.paddingBottom).toBe("48px")
      const whole = { top: 0, height: 219.375 }

      expect(pictureOf(view.container)).toEqual(whole)
      await runtime({ ...RUNTIME, type: "state", currentTime: 1, isPlaying: true })
      expect(pictureOf(view.container)).toEqual(whole)

      // With the bar always there, a tap on the picture pauses it, as a click does.
      const layer = view.container.querySelector("[data-video-picture] > div")
      fireEvent.pointerUp(layer as Element, { button: 0, pointerType: "touch" })
      expect(controls().at(-1)).toBe("pause")
      await runtime({ ...RUNTIME, type: "state", currentTime: 2, isPlaying: false })
      expect(pictureOf(view.container)).toEqual(whole)
    } finally {
      restore()
    }
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

describe("a video's comments", () => {
  test("keep the focus a tap on the frame gives the comment field", async () => {
    // Reproduce by dropping `onMouseDown` from the layer over the frame in player.tsx: a tap's
    // mousedown, which comes after its pointer's events, moves the focus off the field it opened.
    const { view } = await openPlayer()
    const layer = view.container.querySelector("[data-video-picture] > div")
    if (!layer) throw new Error("Expected the layer over the frame.")
    expect(fireEvent.mouseDown(layer)).toBe(false)
  })

  test("say how to stop commenting with a key, and under a finger with a close mark", () => {
    // Reproduce by always drawing the Esc key in `CommentModeHint`.
    const hint = () =>
      render(
        <Wrap cache={new QueryClient()}>
          <CommentModeHint hint="Tap the frame to comment on this moment" onExit={() => {}} />
        </Wrap>
      )
    const exit = (view: ReturnType<typeof hint>) =>
      view.getByRole("button", { name: "Stop commenting" }).textContent

    expect(exit(hint())).toBe("Esc")
    cleanup()

    const coarse = (query: string) => ({ matches: query === "(pointer: coarse)" })
    Object.assign(globalThis, { matchMedia: coarse })
    try {
      expect(exit(hint())).toBe("")
    } finally {
      Reflect.deleteProperty(globalThis, "matchMedia")
    }
  })

  test("say a new comment is at its instant, in its scene", () => {
    // Reproduce by passing the instant as the card's `anchor` in `VideoCommentPins`: "On 0:02".
    const heading = (at: number) => {
      const commenting = {
        marked: [],
        active: null,
        draft: { at, point: { x: 0.5, y: 0.5 } },
      } as unknown as VideoCommenting
      const view = render(
        <Wrap cache={new QueryClient()}>
          <VideoCommentPins
            commenting={commenting}
            outline={OUTLINE}
            time={at / 1000}
            width={640}
            onOpen={() => {}}
          />
        </Wrap>
      )
      const text = view.getByRole("dialog").querySelector("p, h2, h3, span")?.textContent
      view.unmount()
      return text
    }
    expect(heading(2500)).toBe("At 0:02 · demo")
    // Between the demo and the outro, no scene plays.
    expect(heading(5200)).toBe("At 0:05")
  })

  // Guard proof: name `chapterAt(outline, draft.at / 1000)` in draftAnchor, as the player once
  // did: the instant between the demo and the outro names the demo, and the API refuses it.
  test("name the scene playing at their instant, and none between two scenes", () => {
    const point = { x: 0.5, y: 0.5 }
    expect(draftAnchor(OUTLINE, { at: 5200, point })).toEqual({ at: 5200, point })
    expect(draftAnchor(OUTLINE, { at: 2500, point })).toEqual({ at: 2500, scene: "demo", point })
  })

  // Guard proof: go to `anchor.at` in openThread in player.tsx, or show it in ThreadInstant: the
  // comment kept 1 s into the outro has no instant to go to, and its card names the scene alone.
  test("go to their instant in the version shown, its scene's start and their offset", async () => {
    const comment = (id: string, anchor: ArtifactComment["anchor"]): ArtifactComment => ({
      artifactId: FILM.artifactId,
      id,
      anchor,
      body: "Hold the logo longer",
      author: { type: "user", id: "alice" },
      authorName: "Alice",
      createdAt: "2026-11-18T12:00:00.000Z",
    })
    const comments = [
      comment("cmt_gone", { scene: "credits", label: "Credits", offset: 0, revision: 1 }),
      comment("cmt_outro", { scene: "outro", label: "Thanks", offset: 1000, revision: 1 }),
    ]
    const config = client.getConfig()
    client.setConfig({
      baseUrl: "https://api.sixb.test",
      fetch: Object.assign(async () => Response.json({ comments }), {
        preconnect: globalThis.fetch.preconnect,
      }) as unknown as typeof fetch,
    })
    try {
      const { view, posted } = await openPlayer(undefined, {
        access: "owner",
        latestVersion: FILM.version,
        revision: FILM.revision,
      })
      fireEvent.click(await view.findByRole("button", { name: "Comments, 2 open" }))
      const panel = view.getByRole("complementary", { name: "Comments" })
      const [outro, gone] = within(panel)
        .getAllByRole("article")
        .map((card) => card.querySelector("button"))

      // The outro starts at 5.5 s in this version: the comment 1 s into it is at 6.5 s.
      expect(outro?.textContent).toBe("0:06Thanks")
      posted.length = 0
      fireEvent.click(outro as HTMLElement)
      expect(posted.at(-1)).toMatchObject({ action: "seek", timeSeconds: 6.5 })

      // One on a scene this version no longer has goes nowhere, and says so.
      expect(gone?.textContent).toBe("“Credits”No longer in the video")
      posted.length = 0
      fireEvent.click(gone as HTMLElement)
      expect(posted.filter((message) => message.action === "seek")).toEqual([])
    } finally {
      client.setConfig({ baseUrl: config.baseUrl, fetch: config.fetch })
    }
  })

  // Reproduce by showing the open comment's pin at any instant in `VideoCommentPins`.
  test("show a pin only around its instant, the open one too", () => {
    const thread = {
      comment: { id: "cmt_1", body: "Make this caption bigger", anchor: { at: 25_000 } },
      replies: [],
      number: 1,
    } as unknown as CommentThread
    const commenting = {
      marked: [{ thread, seconds: 25, label: "Comment 1", excerpt: thread.comment.body }],
      active: "cmt_1",
      draft: null,
    } as unknown as VideoCommenting

    const pins = (time: number) => {
      const view = render(
        <Wrap cache={new QueryClient()}>
          <VideoCommentPins
            commenting={commenting}
            outline={OUTLINE}
            time={time}
            width={640}
            onOpen={() => {}}
          />
        </Wrap>
      )
      const count = view.container.querySelectorAll("[data-comment-pin]").length
      view.unmount()
      return count
    }

    expect(pins(25)).toBe(1)
    expect(pins(26)).toBe(1)
    expect(pins(0)).toBe(0)
    expect(pins(30)).toBe(0)
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
