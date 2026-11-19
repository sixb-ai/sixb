import { afterEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import agentImageTools from "../../../sandboxes/agent-image/tooling/package.json"
import corePackage from "../package.json"
import { FRAME_ASSETS, injectFrameAssets } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import { HYPERFRAMES_RUNTIME, HYPERFRAMES_VERSION } from "../src/artifacts/frames/hyperframes"
import { FRAME_PROTOCOL } from "../src/artifacts/frames/protocol"
import { frameRuntime } from "../src/artifacts/frames/runtime"
import type { VideoOutline } from "../src/artifacts/outline"

// A video plays in its frame with HyperFrames' runtime, the release the agent image renders with,
// served beside the frame's own runtime, which leaves the video's look alone.

const OUTLINE: VideoOutline = {
  kind: "video",
  width: 1280,
  height: 720,
  fps: 30,
  durationMs: 2000,
  scenes: [{ id: "intro", startMs: 0, durationMs: 2000, renderKey: "a" }],
}

describe("a video's frame", () => {
  test("plays the HyperFrames release the agent image renders with", () => {
    // Reproduce by bumping either pin alone: preview and export would play different runtimes.
    expect(agentImageTools.dependencies.hyperframes).toBe(HYPERFRAMES_VERSION)
    expect(corePackage.devDependencies["@hyperframes/core"]).toBe(HYPERFRAMES_VERSION)
    expect(HYPERFRAMES_RUNTIME).toStartWith(`/*! HyperFrames runtime ${HYPERFRAMES_VERSION},`)
  })

  test("serves its entry with both runtimes and no kit, and the runtime is in every render key", () => {
    expect(frameLayout({ outline: OUTLINE })).toBe("video")
    expect(frameEntries({ entry: "index.html", outline: OUTLINE })).toEqual(["index.html"])

    expect(injectFrameAssets("<html><head></head><body></body></html>", "video")).toBe(
      '<html><head><script src="__sixb/runtime.js" data-sixb-layout="video"></script><script src="__sixb/hyperframes.js"></script></head><body></body></html>'
    )
    // `frameKitDigest` hashes the assets' bodies: a new runtime renders every video again.
    expect(FRAME_ASSETS["__sixb/hyperframes.js"]?.body).toBe(HYPERFRAMES_RUNTIME)
  })
})

const windows: Window[] = []
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close()
})

/** The frame's runtime in a video's page, under a browser's name, with the app as its parent. */
function videoFrame(userAgent: string) {
  const window = new Window({
    url: "https://frame.test/index.html",
    settings: { navigator: { userAgent } },
  })
  windows.push(window)
  window.document.write(
    '<!doctype html><html><head></head><body><audio src="media/music.m4a"></audio></body></html>'
  )
  const document = window.document

  const posted: Record<string, unknown>[] = []
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  const proxy = <T extends object>(target: T, overrides: Record<string, unknown>): T =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property === "string" && property in overrides) return overrides[property]
        const value = Reflect.get(object, property, object)
        return typeof value === "function" ? value.bind(object) : value
      },
    })
  const script = document.createElement("script")
  script.setAttribute("data-sixb-layout", "video")
  const frameWindow = proxy(window, { parent })
  const frameDocument = proxy(document, { currentScript: script })

  // The runtime is served as its own source: it runs here the same, against this DOM.
  new Function(
    "window",
    "document",
    "navigator",
    "ResizeObserver",
    "CustomEvent",
    `(${frameRuntime.toString()})()`
  )(frameWindow, frameDocument, window.navigator, window.ResizeObserver, window.CustomEvent)

  const audio = document.querySelector("audio") as unknown as HTMLMediaElement
  const played: string[] = []
  audio.play = () => {
    played.push("play")
    return Promise.resolve()
  }
  audio.pause = () => {
    played.push("pause")
  }

  const send = (data: Record<string, unknown>) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, source: parent as never }))
  return { window, document, posted, played, send }
}

describe("the frame's runtime in a video", () => {
  test("says it is ready, and keeps the video's own colors whatever the app's theme", () => {
    // Reproduce by dropping `if (video) return` from the theme request in runtime.ts: the page
    // takes the app's dark tokens and color scheme, which an export never shows.
    const { document, posted, send } = videoFrame("Mozilla/5.0 (Macintosh)")
    expect(posted).toContainEqual({ protocol: FRAME_PROTOCOL, event: "ready", params: {} })

    send({ protocol: FRAME_PROTOCOL, id: 1, method: "theme", params: { tokens: {}, dark: true } })
    expect(posted).toContainEqual({ protocol: FRAME_PROTOCOL, id: 1 })
    expect(document.getElementById("sixb-theme")).toBeNull()
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("on a phone, starts and stops every recording on the first play, in the reader's tap", () => {
    // Reproduce by dropping the `prime` listener from runtime.ts: nothing is played on the tap,
    // and an iPhone keeps the music silent when its scene comes.
    const phone = videoFrame("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")
    const play = { source: "hf-parent", type: "control", action: "play" }
    phone.send({ ...play, action: "pause" })
    expect(phone.played).toEqual([])
    phone.send(play)
    phone.send(play)
    expect(phone.played).toEqual(["play", "pause"])

    const desktop = videoFrame("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
    desktop.send(play)
    expect(desktop.played).toEqual([])
  })
})
