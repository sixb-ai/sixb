import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactVersionResponse } from "@sixb/client"
import { type CanvasBoard, FRAME_PROTOCOL, type FrameEditTarget } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import * as Y from "yjs"
import { frameLinkKey } from "../src/artifacts/frame"
import { liveBoardSource } from "../src/artifacts/live/boards"
import { LiveCanvas } from "../src/artifacts/live/canvas"
import { LiveArtifact } from "../src/artifacts/live/session"
import { fileTextQueryKey, versionFileSource } from "../src/artifacts/queries"
import {
  BoardStage,
  type CommentPick,
  type StageMode,
} from "../src/artifacts/renderers/canvas/board-editor"
import { installDom } from "./helpers/dom"
import { canvasOf, storedDocument } from "./helpers/live-server"

// Editing what a board shows, as an opened board does it: the frame, played here by the test,
// reports what the reader picks and types; the stage writes it into the canvas's live document.

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "MessageEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "DOMRect",
])

// Radix picks its layout effect when it loads, a no-op without a `document`, and its popovers then
// never mount: it is given React's own for this file, as agent-context-meter.test.tsx does.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })
afterEach(() => client.setConfig({ fetch: originalConfig.fetch }))
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const ARTIFACT_ID = "art_b0ardedit"
const FILE = "boards/home.html"
const SOURCE = `<!doctype html><html><head></head><body><main><h1>Welcome</h1><p>Total: 0</p><img src="hero.png" alt="Hero"></main></body></html>`

const HEADING = "body>main:0>h1:0"
const TOTAL = "body>main:0>p:0"
const IMAGE = "body>main:0>img:0"

const BOARD: CanvasBoard = {
  id: "home",
  type: "board",
  title: "Home",
  file: FILE,
  x: 0,
  y: 0,
  w: 400,
  h: 800,
}

const fileRef = (name: string) => ({
  blobId: `blob_${name}`,
  digest: `sha256:${name.padEnd(64, "0").slice(0, 64)}`,
  sizeBytes: 10,
})

const VERSION = {
  artifactId: ARTIFACT_ID,
  version: 1,
  title: "Onboarding",
  entry: "canvas.json",
  files: [
    { path: "canvas.json", file: fileRef("canvas") },
    { path: FILE, file: fileRef("home") },
    { path: "boards/hero.png", file: fileRef("hero") },
  ],
  outline: { kind: "canvas", items: [] },
  references: [],
  author: { type: "user", id: "usr_bob" },
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
  revision: 1,
  frozen: false,
} satisfies GetArtifactVersionResponse

/** A canvas held live, its board's page in its document, and what edits it under undo. */
function liveCanvas() {
  const live = new LiveArtifact(ARTIFACT_ID, () => false, {
    list: () => [],
    write: () => {},
    remove: () => {},
  })
  Y.applyUpdate(live.doc, Y.encodeStateAsUpdate(storedDocument(canvasOf({ items: [BOARD] }))))
  live.doc.getMap<unknown>(LIVE_FILES).set(FILE, new Y.Text(SOURCE))
  const canvas = new LiveCanvas(live.doc)
  return { live, canvas, source: () => liveBoardSource(live.doc, FILE) ?? "" }
}

function stage(mode: StageMode, options: { readonly onPick?: (pick: CommentPick) => void } = {}) {
  const { live, canvas, source } = liveCanvas()
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  queries.setQueryData(frameLinkKey(VERSION), {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-11-08T10:00:00.000Z",
  })
  queries.setQueryData(fileTextQueryKey(versionFileSource(VERSION, FILE)), SOURCE)

  const view = render(
    <QueryClientProvider client={queries}>
      <BoardStage
        version={VERSION}
        board={BOARD}
        title="Home"
        scale={1}
        live={live}
        canvas={canvas}
        mode={mode}
        pins={[]}
        activePin={null}
        draft={null}
        onPress={() => {}}
        onPick={options.onPick ?? (() => {})}
        onOpenPin={() => {}}
        onSubmitDraft={async () => {}}
        onCancelDraft={() => {}}
      />
    </QueryClientProvider>
  )

  const frame = view.container.querySelector("iframe")?.contentWindow
  if (!frame) throw new Error("Expected the board's frame.")
  // What the stage asks of the frame.
  const asked: { method: string; params: Record<string, unknown> }[] = []
  frame.postMessage = ((message: { method: string; params: Record<string, unknown> }) => {
    asked.push(message)
  }) as typeof frame.postMessage

  /** The frame says something, as its runtime posts it. */
  const post = async (event: string, params: Record<string, unknown>) => {
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, event, params },
          source: frame as never,
        })
      )
    })
  }
  const target = (address: string, kind: "text" | "image", label: string): FrameEditTarget => ({
    address,
    kind,
    label,
    rect: { x: 40, y: 120, width: 320, height: 48 },
  })
  return { view, live, canvas, source, post, target, asked }
}

describe("an opened board, edited in place", () => {
  // Guard proof: drop the `chosen.address !== address` check in BoardStage's edit.text handler;
  // the words posted for the heading, picked or not, land in the page.
  test("takes typed words only for the text element the reader picked", async () => {
    const { source, post, target } = stage("edit")
    await post("ready", {})

    // Nothing picked: a script posting words for the heading changes nothing.
    await post("edit.text", { address: HEADING, base: "Welcome", text: "Hacked" })
    expect(source()).toContain("<h1>Welcome</h1>")

    // Another element picked: still nothing.
    await post("edit.select", { target: target(IMAGE, "image", "Hero") })
    await post("edit.text", { address: HEADING, base: "Welcome", text: "Hacked" })
    expect(source()).toContain("<h1>Welcome</h1>")

    await post("edit.select", { target: target(HEADING, "text", "Welcome") })
    await post("edit.text", { address: HEADING, base: "Welcome", text: "Welcome back" })
    expect(source()).toContain("<h1>Welcome back</h1>")
  })

  // Guard proof: write `text` whole in place of `mergeBoardText` in the edit.text handler; the
  // words someone else added meanwhile are lost.
  test("merges typed words with what someone else changed in the element since", async () => {
    const { live, source, post, target } = stage("edit")
    await post("ready", {})
    await post("edit.select", { target: target(HEADING, "text", "Welcome") })

    // Someone else adds a word before, then the frame posts the reader's typing from what it
    // showed them.
    const text = live.doc.getMap<unknown>(LIVE_FILES).get(FILE)
    if (!(text instanceof Y.Text)) throw new Error("Expected the board's page.")
    text.insert(source().indexOf("Welcome"), "Oh, ")
    await post("edit.text", { address: HEADING, base: "Welcome", text: "Welcome!" })

    expect(source()).toContain("<h1>Oh, Welcome!</h1>")
  })

  // Guard proof: drop the `scripted` branch in ElementTools; the style tool shows for what a
  // script rewrote. Drop the kind check in edit.text; its words are taken.
  test("says what a script built or rewrote, and takes no words for it", async () => {
    const { view, source, post } = stage("edit")
    await post("ready", {})
    await post("edit.select", {
      target: {
        address: null,
        kind: "scripted",
        within: TOTAL,
        rect: { x: 40, y: 200, width: 320, height: 24 },
      },
    })

    expect(view.getByText("Built by the page")).toBeTruthy()
    expect(view.queryByRole("button", { name: "Style" })).toBeNull()

    await post("edit.text", { address: TOTAL, base: "Total: 0", text: "Total: 9" })
    expect(source()).toContain("<p>Total: 0</p>")
  })

  // Guard proof: drop `setBoardStyle` from StyleTool's change; the color never reaches the page.
  test("sets a style the reader picks in the element's inline style, for everyone", async () => {
    const { view, source, post, target } = stage("edit")
    await post("ready", {})
    await post("edit.select", { target: target(HEADING, "text", "Welcome") })

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Style" }))
    })
    const swatch = await waitFor(() => view.getAllByRole("button", { name: "Use #db2777" })[0])
    await act(async () => {
      fireEvent.click(swatch as HTMLElement)
    })

    expect(source()).toContain('<h1 style="color: #db2777">Welcome</h1>')
  })

  // Guard proof: drop the `files` argument from ImageTool's `show`; the page points at a picture
  // the canvas does not hold.
  test("replaces an image with an upload: the file joins the canvas, the page points at it, and undo takes both back", async () => {
    const uploads: string[] = []
    client.setConfig({
      fetch: Object.assign(
        async (input: Request) => {
          uploads.push(`${input.method} ${new URL(input.url).pathname}`)
          return Response.json(
            { blobId: "blob_new", digest: `sha256:${"2".repeat(64)}`, sizeBytes: 3 },
            { status: 201 }
          )
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })

    const { view, live, canvas, source, post, target } = stage("edit")
    await post("ready", {})
    await post("edit.select", { target: target(IMAGE, "image", "Hero") })
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Replace image" }))
    })

    const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error("Expected the image's file input.")
    Object.defineProperty(input, "files", {
      value: [new File(["png"], "Autumn Sale.png", { type: "image/png" })],
    })
    await act(async () => {
      fireEvent.change(input)
    })

    const files = live.doc.getMap<unknown>(LIVE_FILES)
    await waitFor(() => expect(source()).toMatch(/src="images\/autumn-sale-[a-z]{6}\.png"/))
    const path = `boards/${/src="(images\/[^"]+)"/.exec(source())?.[1]}`
    expect(uploads).toEqual(["POST /api/files"])
    expect(files.get(path)).toMatchObject({ blobId: "blob_new" })

    canvas.undo()
    expect(source()).toContain('src="hero.png"')
    expect(files.has(path)).toBe(false)
  })

  // Guard proof: send `typing: true` in comment mode from BoardStage; the frame lets the reader
  // type into what they pick to comment on.
  test("picking what to comment on, takes no typing and gives the element and where it was clicked", async () => {
    const picks: CommentPick[] = []
    const { asked, post, target, source } = stage("comment", { onPick: (pick) => picks.push(pick) })
    await post("ready", {})

    expect(asked.at(-1)).toMatchObject({ method: "edit", params: { on: true, typing: false } })

    await post("edit.select", {
      target: target(HEADING, "text", "Welcome"),
      at: { x: 100, y: 200 },
    })
    expect(picks).toEqual([{ element: HEADING, label: "Welcome", point: { x: 0.25, y: 0.25 } }])

    // Nothing is typed in while commenting.
    await post("edit.text", { address: HEADING, base: "Welcome", text: "Typed" })
    expect(source()).toContain("<h1>Welcome</h1>")
  })
})
