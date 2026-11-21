import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Window } from "happy-dom"
import agentImageTools from "../../../sandboxes/agent-image/tooling/package.json"
import corePackage from "../package.json"
import { FRAME_ASSETS, injectFrameAssets } from "../src/artifacts/frames/assets"
import { frameEntries, frameLayout } from "../src/artifacts/frames/entries"
import { HYPERFRAMES_RUNTIME, HYPERFRAMES_VERSION } from "../src/artifacts/frames/hyperframes"
import { FRAME_DEFAULT_THEMES } from "../src/artifacts/frames/kit"
import { FRAME_PROTOCOL, parseFrameEvent } from "../src/artifacts/frames/protocol"
import { videoFrameRuntime } from "../src/artifacts/frames/video-runtime"
import type { VideoOutline } from "../src/artifacts/outline"
import { frameKitDigest } from "../src/artifacts/publish/previews"
import { VIDEO_ENGINE } from "../src/artifacts/video/export"

// A video plays in its frame with HyperFrames' runtime, the release the agent image renders with,
// served beside a runtime of the frame's own for videos, which leaves the video's look alone.

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

    // Reproduce by bumping both pins with VIDEO_ENGINE a literal: every export and still would
    // then fail, its sandboxes running another release than its keys name.
    expect(VIDEO_ENGINE).toBe(`hyperframes@${agentImageTools.dependencies.hyperframes}`)
  })

  test("serves its entry with its runtimes and no kit", () => {
    expect(frameLayout({ outline: OUTLINE })).toBe("video")
    expect(frameEntries({ entry: "index.html", outline: OUTLINE })).toEqual(["index.html"])

    expect(injectFrameAssets("<html><head></head><body></body></html>", "video")).toBe(
      '<html><head><script src="__sixb/video.js"></script><script src="__sixb/hyperframes.js"></script></head><body></body></html>'
    )
    expect(FRAME_ASSETS["__sixb/hyperframes.js"]?.body).toBe(HYPERFRAMES_RUNTIME)
  })

  test("its runtimes are in a video's render keys, and in no other layout's", () => {
    // Reproduce by hashing every asset in `frameKitDigest` (publish/previews.ts): a HyperFrames
    // release would render every deck's, page's and document's previews again.
    const shared = Object.fromEntries(
      Object.entries(FRAME_ASSETS).filter(([, asset]) => asset.layout === undefined)
    )
    const sharedDigest = createHash("sha256")
      .update(JSON.stringify([shared, FRAME_DEFAULT_THEMES]))
      .digest("hex")

    expect(Object.keys(shared)).not.toContain("__sixb/hyperframes.js")
    for (const layout of ["deck", "page", "document"] as const) {
      expect(frameKitDigest(layout)).toBe(sharedDigest)
    }
    expect(frameKitDigest("video")).not.toBe(sharedDigest)
  })
})

const windows: Window[] = []
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close()
})

/**
 * The frame's runtime in a video's page, under a browser's name, with the app as its parent, and
 * HyperFrames' runtime loaded beside it unless `loaded` is false.
 */
function videoFrame(userAgent: string, { loaded = true }: { readonly loaded?: boolean } = {}) {
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
  // What HyperFrames' runtime leaves on the page: its API once loaded, why its startup stopped.
  const page: Record<string, unknown> = { parent, ...(loaded ? { __hyperframes: {} } : {}) }

  // The runtime is served as its own source: it runs here the same, against this DOM.
  new Function("window", "document", "navigator", `(${videoFrameRuntime.toString()})()`)(
    proxy(window, page),
    document,
    window.navigator
  )

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
  return { window, document, page, posted, played, send }
}

describe("the frame's runtime in a video", () => {
  test("says it is ready, and keeps the video's own colors whatever the app's theme", () => {
    const { document, posted, send } = videoFrame("Mozilla/5.0 (Macintosh)")
    expect(posted).toContainEqual({ protocol: FRAME_PROTOCOL, event: "ready", params: {} })

    send({ protocol: FRAME_PROTOCOL, id: 1, method: "theme", params: { tokens: {}, dark: true } })
    expect(posted).toContainEqual({ protocol: FRAME_PROTOCOL, id: 1 })
    expect(document.getElementById("sixb-theme")).toBeNull()
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    // What a page's frame does, a video's refuses rather than leave the app waiting.
    send({ protocol: FRAME_PROTOCOL, id: 2, method: "goto", params: { slide: 2 } })
    expect(posted.at(-1)).toEqual({
      protocol: FRAME_PROTOCOL,
      id: 2,
      error: "A video's frame does not answer 'goto'.",
    })
  })

  test("says at once that the video cannot start when HyperFrames' runtime did not load", () => {
    // Reproduce by dropping the `__hyperframes` check from `ready` in video-runtime.ts: the frame says
    // it is ready, and the app waits out its timeout before saying anything.
    const { posted } = videoFrame("Mozilla/5.0 (Macintosh)", { loaded: false })
    expect(posted).toEqual([{ protocol: FRAME_PROTOCOL, event: "failed", params: {} }])
  })

  test("says the video cannot start once HyperFrames' startup stops at an error", () => {
    // Reproduce by dropping the `error` listener from `ready` in video-runtime.ts: nothing is posted.
    const { window, page, posted } = videoFrame("Mozilla/5.0 (Macintosh)")
    const failed = { protocol: FRAME_PROTOCOL, event: "failed", params: {} }

    // A scene's own error, with HyperFrames started, is the scene's to report.
    window.dispatchEvent(new window.ErrorEvent("error", { message: "a scene threw" }))
    expect(posted).not.toContainEqual(failed)

    page.__hfStartupError = "HyperFrames runtime failed: TypeError"
    window.dispatchEvent(new window.ErrorEvent("error", { message: "TypeError" }))
    expect(posted.at(-1)).toEqual(failed)
  })

  test("finds the words under a point of the picture, in their scene, for the editor to retype", () => {
    const { document, posted, send } = videoFrame("Mozilla/5.0 (Macintosh)")
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-composition-id="main"><div data-composition-id="outro">
        <p class="caption">Thank you</p><h2>Thank you</h2>
        <h2 id="picked">Thank <br>you</h2><h2><span>Not</span> alone</h2>
      </div></div>`
    )
    const picked = document.getElementById("picked")
    const outro = document.querySelector('[data-composition-id="outro"]')
    if (!picked || !outro) throw new Error("The scene was not written.")
    picked.getBoundingClientRect = () => ({ left: 192, top: 540, width: 960, height: 108 }) as never
    let under: typeof outro = picked
    document.elementFromPoint = () => under

    send({ protocol: FRAME_PROTOCOL, id: 3, method: "video.pick", params: { x: 0.5, y: 0.55 } })
    expect(posted.at(-2)).toEqual({ protocol: FRAME_PROTOCOL, id: 3 })
    expect(posted.at(-1)).toMatchObject({
      event: "video.picked",
      params: { target: { scene: "outro", tag: "h2", text: "Thank you", occurrence: 1 } },
    })

    // Where it shows, in fractions of the picture: its box over the frame's own size.
    const { rect } = (posted.at(-1)?.params as { target: { rect: Record<string, number> } }).target
    expect(rect.x / rect.width).toBeCloseTo(0.2, 3)
    expect(parseFrameEvent(posted.at(-1))).toEqual(posted.at(-1) as never)

    // A composition holds elements, not words alone: nothing to retype there.
    under = outro
    send({ protocol: FRAME_PROTOCOL, id: 4, method: "video.pick", params: { x: 0.5, y: 0.6 } })
    expect(posted.at(-1)).toMatchObject({ event: "video.picked", params: { target: null } })
  })

  test("on a phone, starts and stops every recording on the first play, in the reader's tap", () => {
    // Reproduce by dropping the `prime` listener from video-runtime.ts: nothing is played on the tap,
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
