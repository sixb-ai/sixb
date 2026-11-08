import { afterEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { FRAME_PROTOCOL, parseFrameEvent } from "../src/artifacts/frames/protocol"
import { frameRuntime } from "../src/artifacts/frames/runtime"
import {
  annotateBoard,
  applyBoardEdit,
  boardFramePatches,
  setBoardText,
} from "../src/artifacts/live"

// The frame runtime's editing, run in a DOM: a board served for editing, and the app around it
// as the frame's parent, which posts requests and hears events.

const BOARD = `<!doctype html><html><head></head><body>
<main>
  <h1>Welcome</h1>
  <p>Pick a <b>region</b>.</p>
  <ul><li>Live total: 0</li></ul>
  <div id="chart"></div>
  <a href="https://example.com">Docs</a>
</main>
</body></html>`

const windows: Window[] = []
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close()
})

function frame(source: string) {
  const window = new Window({ url: "https://frame.test/boards/welcome.html" })
  windows.push(window)
  window.document.write(annotateBoard(source))
  const document = window.document

  // The app: what the frame posts to its parent, and requests it sends the frame.
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
  script.setAttribute("data-sixb-layout", "page")
  const frameWindow = proxy(window, { parent })
  const frameDocument = proxy(document, { currentScript: script })

  // The runtime is served as its own source: it runs here the same, against this DOM.
  new Function(
    "window",
    "document",
    "requestAnimationFrame",
    "ResizeObserver",
    "getComputedStyle",
    "CustomEvent",
    "Element",
    "HTMLElement",
    "Node",
    "CSS",
    `(${frameRuntime.toString()})()`
  )(
    frameWindow,
    frameDocument,
    (callback: () => void) => window.setTimeout(callback),
    window.ResizeObserver,
    window.getComputedStyle.bind(window),
    window.CustomEvent,
    window.Element,
    window.HTMLElement,
    window.Node,
    window.CSS
  )

  let id = 0
  const request = (method: string, params: Record<string, unknown>) => {
    id += 1
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { protocol: FRAME_PROTOCOL, id, method, params },
        source: parent as never,
      })
    )
    return posted.find((message) => message.id === id)
  }
  const events = (name: string) =>
    posted.filter((message) => message.event === name).map((message) => parseFrameEvent(message))
  const at = (address: string) =>
    document.querySelector(`[data-sixb-at="${address}"]`) as unknown as HTMLElement
  const fire = (target: unknown, type: string) =>
    (target as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
      new window.MouseEvent(type, { bubbles: true, cancelable: true })
    )
  return { window, document, posted, request, events, at, fire }
}

describe("a board's frame, editing", () => {
  // Guard proof: drop the capturing click handler's `preventDefault`/`stopPropagation`; the link
  // is then followed, and the frame posts a `link` event.
  test("reports what the reader points at and picks by address, and follows nothing", () => {
    const { request, events, at, fire, posted } = frame(BOARD)
    expect(request("edit", { on: true })).toEqual({ protocol: FRAME_PROTOCOL, id: 1 })

    fire(at("body>main:0>p:0").querySelector("b"), "mouseover")
    expect(events("edit.hover").at(-1)?.params).toEqual({
      target: {
        address: "body>main:0>p:0",
        kind: "text",
        label: "Pick a region.",
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    })

    fire(at("body>main:0>a:0"), "click")
    expect(events("edit.select").at(-1)?.params).toMatchObject({
      target: { address: "body>main:0>a:0", kind: "text", label: "Docs" },
    })
    expect(posted.some((message) => message.event === "link")).toBe(false)
  })

  test("lets the reader type into a text element, and posts its words", () => {
    const { request, events, at, fire, window } = frame(BOARD)
    request("edit", { on: true })

    const heading = at("body>main:0>h1:0")
    fire(heading, "click")
    expect(heading.getAttribute("contenteditable")).toBe("plaintext-only")

    heading.textContent = "Welcome back"
    heading.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event)
    expect(events("edit.text").at(-1)?.params).toEqual({
      address: "body>main:0>h1:0",
      text: "Welcome back",
    })

    // Editing off, nothing is editable any more.
    request("edit", { on: false })
    expect(heading.hasAttribute("contenteditable")).toBe(false)
  })

  // Guard proof: drop the hash check in the runtime's editTarget; the total a script rewrote is
  // then editable, and the reader's words would overwrite the source's.
  test("reports what scripts built or rewrote as scripted, and lets nobody type into it", () => {
    const { request, events, at, fire, document } = frame(BOARD)
    request("edit", { on: true })

    const chart = at("body>main:0>div:0")
    const bar = document.createElement("span")
    chart.append(bar as unknown as Node)
    fire(bar, "mouseover")
    expect(events("edit.hover").at(-1)?.params).toMatchObject({
      target: { address: null, kind: "scripted", within: "body>main:0>div:0" },
    })

    const total = at("body>main:0>ul:0>li:0")
    total.textContent = "Live total: 42"
    fire(total, "click")
    expect(events("edit.select").at(-1)?.params).toMatchObject({
      target: { address: null, kind: "scripted", within: "body>main:0>ul:0>li:0" },
    })
    expect(total.hasAttribute("contenteditable")).toBe(false)
  })

  // Guard proof: apply every patch at once in `edit.patch`; the heading the reader types in is
  // rewritten under their caret.
  test("takes what others changed, keeping the element the reader types in until they leave it", () => {
    const { request, at, fire, window } = frame(BOARD)
    request("edit", { on: true })
    const heading = at("body>main:0>h1:0")
    fire(heading, "click")
    heading.textContent = "Welcome back"

    // Someone else changes the paragraph, and the heading too.
    let source = BOARD
    source = applyBoardEdit(source, setBoardText(source, "body>main:0>p:0", "Pick a region now."))
    source = applyBoardEdit(source, setBoardText(source, "body>main:0>h1:0", "Hello"))
    const patches = boardFramePatches(BOARD, source)
    expect(request("edit.patch", { patches })).toEqual({ protocol: FRAME_PROTOCOL, id: 2 })

    expect(at("body>main:0>p:0").innerHTML).toBe("Pick a <b>region now</b>.")
    expect(heading.textContent).toBe("Welcome back")

    heading.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event)
    expect(heading.textContent).toBe("Hello")
    expect(heading.hasAttribute("contenteditable")).toBe(false)
  })
})
