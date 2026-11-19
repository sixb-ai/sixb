import { describe, expect, test } from "bun:test"
import { act, fireEvent, render } from "@testing-library/react"
import { artifactFileSource } from "../src/artifacts/file-source"
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

describe("a video's first frame on a card", () => {
  // Reproduce by rendering the <video> before the card nears the screen in VideoPoster: every card
  // of a long list reads its clip at once.
  test("is read only once the card nears the screen", () => {
    const view = render(
      <VideoPoster source={source("walkthrough.mp4", "video/mp4")} fallback={null} />
    )
    expect(view.container.querySelector("video")).toBeNull()
    expect(view.container.querySelector(".sixb-media-developing")).not.toBeNull()

    act(() => observers.at(-1)?.callback([{ isIntersecting: true }]))
    expect(view.container.querySelector("video")?.getAttribute("src")).toEndWith("#t=0.001")
  })
})

// Reproduce by dropping revealDuration from the video's metadata handler: the browser's own
// controls cannot seek a screen recording until it has played to its end.
test("a screen recording's length is found before it plays", () => {
  const view = render(
    <VideoPlayer source={source("screen.webm", "video/webm")} name="screen.webm" layout="stage" />
  )
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
    const view = render(<AudioPlayer source={source("call.webm", "audio/webm")} name="call.webm" />)
    const audio = view.container.querySelector("audio") as HTMLAudioElement

    playAs(audio, { duration: 83.4, header: Number.POSITIVE_INFINITY })

    expect(audio.currentTime).toBe(0)
    expect(view.getByText("1:23")).toBeTruthy()
    expect(view.getByRole("slider").getAttribute("aria-valuemax")).toBe("83.4")
  })

  // Reproduce by dropping onKeyDown from the player's slider: each arrow moves a tenth of a second.
  test("seeks a few seconds at a key, more with Shift, within the clip", () => {
    const view = render(<AudioPlayer source={source("call.mp3", "audio/mpeg")} name="call.mp3" />)
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
