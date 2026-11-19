import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as renderInDom, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  type DerivedMedia,
  derivedMediaQueryKey,
  useDerivedMedia,
} from "../src/artifacts/derived-media"
import { artifactFileSource, type FileSource } from "../src/artifacts/file-source"
import { formatClock } from "../src/artifacts/playback"
import { AudioPlayer, VideoPlayer, VideoPoster } from "../src/artifacts/renderers/media"
import { installDom } from "./helpers/dom"

/** Every observer a test made, to bring what it watches near the screen. */
const observers: NearScreenObserver[] = []
class NearScreenObserver {
  constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
    observers.push(this)
  }
  observe() {}
  disconnect() {}
}

installDom(
  [
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    // The slider keeps its value in a hidden input, for a form around it.
    "HTMLFormElement",
    "HTMLInputElement",
    "Event",
    "KeyboardEvent",
    "EventTarget",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ],
  { values: { IntersectionObserver: NearScreenObserver } }
)

/**
 * Renders `ui` with the query cache knowing what is derived of each of `derived`'s files, as the
 * server answered it: nothing derived yet, unless a test says otherwise.
 */
function render(ui: ReactNode, derived: readonly (readonly [FileSource, DerivedMedia])[] = []) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [file, media] of derived) cache.setQueryData(derivedMediaQueryKey(file), media)
  return renderInDom(<QueryClientProvider client={cache}>{ui}</QueryClientProvider>)
}

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })
afterEach(() => client.setConfig({ fetch: originalConfig.fetch }))
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const source = (path: string, mediaType: string) =>
  artifactFileSource({
    artifactId: "art_0123456789",
    version: 1,
    path,
    fileRef: {
      blobId: `blob_${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: 9,
      mediaType,
    },
    baseUrl: "https://api.sixb.test",
  })

/**
 * A media element as a browser loads a file, its metadata read: `duration` is what the header says
 * until a seek past the end makes the browser read the end, and a seek stops at the end. A
 * recording written as it was captured says `Infinity`.
 */
function playAs(
  element: HTMLMediaElement,
  file: { readonly duration: number; readonly header: number }
) {
  let duration = file.header
  let position = 0
  Object.defineProperty(element, "duration", { get: () => duration })
  Object.defineProperty(element, "currentTime", {
    get: () => position,
    set(value: number) {
      const readsTheEnd = value > file.duration && duration !== file.duration
      if (readsTheEnd) duration = file.duration
      position = Math.min(value, duration)
      if (readsTheEnd) element.dispatchEvent(new Event("durationchange"))
    },
  })
  act(() => {
    element.dispatchEvent(new Event("loadedmetadata"))
  })
}

describe("a video's poster on a card", () => {
  // Reproduce by rendering the <video> before the card nears the screen in VideoPoster: every card
  // of a long list reads its clip at once.
  test("is its first frame, read only once the card nears the screen", () => {
    const clip = source("walkthrough.mp4", "video/mp4")
    const view = render(<VideoPoster source={clip} fallback={null} />, [[clip, {}]])
    expect(view.container.querySelector("video")).toBeNull()
    expect(view.container.querySelector(".sixb-media-developing")).not.toBeNull()

    act(() => observers.at(-1)?.callback([{ isIntersecting: true }]))
    expect(view.container.querySelector("video")?.getAttribute("src")).toEndWith("#t=0.001")
  })

  // Reproduce by leaving `derived.poster` out of Poster: every card reads its clip to draw its
  // first frame, black for a clip that fades in.
  test("is the poster Sixb derived, once there is one, without reading the clip", () => {
    const clip = source("walkthrough.mp4", "video/mp4")
    const poster =
      "https://api.sixb.test/api/artifacts/art_0123456789/versions/1/media/content?part=poster"
    const view = render(<VideoPoster source={clip} fallback={null} />, [[clip, { poster }]])

    act(() => observers.at(-1)?.callback([{ isIntersecting: true }]))
    expect(view.container.querySelector("video")).toBeNull()
    const picture = view.container.querySelector("img")
    expect(picture?.getAttribute("src")).toBe(poster)

    act(() => {
      picture?.dispatchEvent(new Event("load"))
    })
    expect(picture?.className).toContain("sixb-media-in")
  })
})

describe("a video in the viewer", () => {
  // Reproduce by playing `firstFrameUrl(source)` alone in Video: a 2 GB original streams to seek.
  test("plays from its proxy once one is derived, under its poster", () => {
    const clip = source("launch.mov", "video/quicktime")
    const proxy = "https://api.sixb.test/proxy.mp4"
    const poster = "https://api.sixb.test/poster.jpg"
    const view = render(<VideoPlayer source={clip} name="launch.mov" layout="stage" />, [
      [clip, { proxy, poster }],
    ])

    const video = view.container.querySelector("video")
    expect(video?.getAttribute("src")).toBe(proxy)
    expect(video?.getAttribute("poster")).toBe(poster)
  })

  test("plays the original until then, once it is known there is no proxy", async () => {
    const clip = source("launch.mov", "video/quicktime")
    const asked: string[] = []
    client.setConfig({
      fetch: (async (request: Request) => {
        const { pathname, search } = new URL(request.url)
        asked.push(`${pathname}${search}`)
        const pending = { status: "pending" }
        return Response.json({
          path: "launch.mov",
          version: 1,
          parts: {
            probe: pending,
            proxy: pending,
            poster: pending,
            filmstrip: pending,
            waveform: pending,
            cuts: pending,
            transcript: pending,
          },
        })
      }) as typeof fetch,
    })
    const view = render(<VideoPlayer source={clip} name="launch.mov" layout="stage" />)

    // Nothing plays until it is known what: a player that swapped its source would stop.
    expect(view.container.querySelector("video")).toBeNull()
    await waitFor(() => expect(view.container.querySelector("video")).not.toBeNull())
    expect(view.container.querySelector("video")?.getAttribute("src")).toBe(
      `${clip.inlineUrl}#t=0.001`
    )
    expect(asked).toEqual(["/api/artifacts/art_0123456789/versions/1/media?path=launch.mov"])
  })
})

describe("what is derived of an artifact's media", () => {
  // Reproduce by returning the API's relative URLs in useDerivedMedia: an <img> on the app's
  // origin asks the app for the poster, not the API.
  test("is read as addresses on the API, with a shared link's grant", async () => {
    const clip = source("launch.mov", "video/quicktime")
    const url = (part: string) =>
      `/api/artifacts/art_0123456789/versions/1/media/content?path=launch.mov&part=${part}&v=aaaa`
    client.setConfig({
      fetch: (async (_request: Request) =>
        Response.json({
          path: "launch.mov",
          version: 1,
          parts: {
            probe: { status: "failed", reason: "It could not be read." },
            proxy: { status: "ready", url: url("proxy"), mediaType: "video/mp4", sizeBytes: 9 },
            poster: {
              status: "ready",
              url: url("poster"),
              mediaType: "image/jpeg",
              sizeBytes: 9,
              atMs: 1520,
            },
            filmstrip: { status: "pending" },
            waveform: { status: "pending" },
            cuts: { status: "pending" },
            transcript: { status: "unavailable", reason: "No model." },
          },
        })) as typeof fetch,
    })
    let derived: DerivedMedia | undefined
    function Read() {
      derived = useDerivedMedia(clip)
      return null
    }
    render(<Read />)

    await waitFor(() => expect(derived).toBeDefined())
    expect(derived).toEqual({
      proxy: `https://api.sixb.test${url("proxy")}`,
      poster: `https://api.sixb.test${url("poster")}`,
    })
  })
})

// Reproduce by dropping revealDuration from the video's metadata handler: the browser's own
// controls cannot seek a screen recording until it has played to its end.
test("a screen recording's length is found before it plays", () => {
  const screen = source("screen.webm", "video/webm")
  const view = render(<VideoPlayer source={screen} name="screen.webm" layout="stage" />, [
    [screen, {}],
  ])
  const video = view.container.querySelector("video") as HTMLVideoElement
  Object.defineProperty(video, "videoWidth", { value: 1280 })
  Object.defineProperty(video, "videoHeight", { value: 720 })

  playAs(video, { duration: 41.2, header: Number.POSITIVE_INFINITY })

  expect(video.duration).toBe(41.2)
  expect(video.currentTime).toBe(0)
})

describe("the sound player", () => {
  // Reproduce by dropping revealDuration from the player's metadata handler: the position stays
  // disabled and the length unknown until the recording has played to its end.
  test("finds the length of a recording whose header holds none, and starts it from the top", () => {
    const call = source("call.webm", "audio/webm")
    const view = render(<AudioPlayer source={call} name="call.webm" />, [[call, {}]])
    const audio = view.container.querySelector("audio") as HTMLAudioElement

    playAs(audio, { duration: 83.4, header: Number.POSITIVE_INFINITY })

    expect(audio.currentTime).toBe(0)
    expect(view.getByText("1:23")).toBeTruthy()
    expect(view.getByRole("slider").getAttribute("aria-valuemax")).toBe("83.4")
  })

  // Reproduce by dropping onKeyDown from the player's slider: each arrow moves a tenth of a second.
  test("seeks a few seconds at a key, more with Shift, within the clip", () => {
    const call = source("call.mp3", "audio/mpeg")
    const view = render(<AudioPlayer source={call} name="call.mp3" />, [[call, {}]])
    const audio = view.container.querySelector("audio") as HTMLAudioElement
    playAs(audio, { duration: 60, header: 60 })
    const position = view.getByRole("slider")

    fireEvent.keyDown(position, { key: "ArrowRight" })
    expect(audio.currentTime).toBe(5)
    fireEvent.keyDown(position, { key: "ArrowRight", shiftKey: true })
    expect(audio.currentTime).toBe(20)
    fireEvent.keyDown(position, { key: "PageDown" })
    expect(audio.currentTime).toBe(5)
    fireEvent.keyDown(position, { key: "ArrowLeft" })
    fireEvent.keyDown(position, { key: "ArrowLeft" })
    expect(audio.currentTime).toBe(0)
  })
})

describe("a player's clock", () => {
  test("counts the whole seconds played, with hours past an hour", () => {
    expect(formatClock(2.6)).toBe("0:02")
    expect(formatClock(59.99)).toBe("0:59")
    expect(formatClock(3725)).toBe("1:02:05")
    expect(formatClock(Number.NaN)).toBe("0:00")
  })
})
