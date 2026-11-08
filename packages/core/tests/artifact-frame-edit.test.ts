import { afterEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { FRAME_PROTOCOL, parseFrameEvent } from "../src/artifacts/frames/protocol"
import { frameRuntime } from "../src/artifacts/frames/runtime"
import {
  annotateBoard,
  applyBoardEdit,
  boardFramePatches,
  setBoardText,
} from "../src/artifacts/live/board"

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

  // The app: what the frame posts to its parent, what it posts on the port the app hands over with
  // `edit`, and requests it sends the frame. The port is one the test reads at once.
  const posted: Record<string, unknown>[] = []
  const throughPort: Record<string, unknown>[] = []
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  class TestPort {
    postMessage(message: Record<string, unknown>) {
      throughPort.push(message)
    }
  }
  const port = new TestPort()
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
    "MessagePort",
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
    window.CSS,
    TestPort
  )

  let id = 0
  /** A request from the app; `edit` hands the port over, as the app's first one does. */
  const request = (
    method: string,
    params: Record<string, unknown>,
    { withPort = method === "edit" }: { withPort?: boolean } = {}
  ) => {
    id += 1
    const event = new window.MessageEvent("message", {
      data: { protocol: FRAME_PROTOCOL, id, method, params },
      source: parent as never,
    })
    if (withPort) Object.defineProperty(event, "ports", { value: [port] })
    window.dispatchEvent(event)
    return posted.find((message) => message.id === id)
  }
  /** What editing reported, through the port. */
  const events = (name: string) =>
    throughPort
      .filter((message) => message.event === name)
      .map((message) => parseFrameEvent(message))
  const at = (address: string) =>
    document.querySelector(`[data-sixb-at="${address}"]`) as unknown as HTMLElement
  /** An event as the reader's own, trusted as a browser marks it, or as a page's script's. */
  const fire = (
    target: unknown,
    type: string,
    { trusted = true, kind = "mouse" }: { trusted?: boolean; kind?: "mouse" | "input" } = {}
  ) => {
    const event =
      kind === "input"
        ? new window.Event(type, { bubbles: true })
        : new window.MouseEvent(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, "isTrusted", { value: trusted })
    return (target as { dispatchEvent(event: unknown): boolean }).dispatchEvent(event)
  }
  return { window, document, posted, throughPort, request, events, at, fire }
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
    const { request, events, at, fire } = frame(BOARD)
    request("edit", { on: true })

    const heading = at("body>main:0>h1:0")
    fire(heading, "click")
    expect(heading.getAttribute("contenteditable")).toBe("plaintext-only")

    heading.textContent = "Welcome back"
    fire(heading, "input", { kind: "input" })
    expect(events("edit.text").at(-1)?.params).toEqual({
      address: "body>main:0>h1:0",
      base: "Welcome",
      text: "Welcome back",
    })

    // Each change starts from the words last posted.
    heading.textContent = "Welcome back!"
    fire(heading, "input", { kind: "input" })
    expect(events("edit.text").at(-1)?.params).toEqual({
      address: "body>main:0>h1:0",
      base: "Welcome back",
      text: "Welcome back!",
    })

    // Editing off, nothing is editable any more.
    request("edit", { on: false })
    expect(heading.hasAttribute("contenteditable")).toBe(false)
  })

  // Guard proof: drop `typable` from the runtime's click handler; the heading picked to comment on
  // takes the reader's typing.
  test("picks without typing when the app asks so, and says where the reader clicked", () => {
    const { request, events, at, fire } = frame(BOARD)
    request("edit", { on: true, typing: false })

    const heading = at("body>main:0>h1:0")
    fire(heading, "click")
    expect(events("edit.select").at(-1)?.params).toEqual({
      target: {
        address: "body>main:0>h1:0",
        kind: "text",
        label: "Welcome",
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
      at: { x: 0, y: 0 },
    })
    expect(heading.hasAttribute("contenteditable")).toBe(false)

    // Typing again, the next pick takes it.
    request("edit", { on: true })
    fire(heading, "click")
    expect(heading.getAttribute("contenteditable")).toBe("plaintext-only")
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

  // Guard proof: drop `commentable` from the runtime's click handler; what a script wrote is not
  // outlined as what the comment is about. Drop `label` from editTarget's scripted target; the
  // comment cannot quote its words.
  test("picking what to comment on, outlines and quotes what a script wrote, as it does an element", () => {
    const { request, events, at, fire } = frame(BOARD)
    request("edit", { on: true, typing: false })

    const total = at("body>main:0>ul:0>li:0")
    total.textContent = "Live total: 42"
    fire(total, "click")
    expect(events("edit.select").at(-1)?.params).toMatchObject({
      target: { address: null, kind: "scripted", label: "Live total: 42" },
    })
    expect(total.hasAttribute("data-sixb-picked")).toBe(true)
  })

  // Guard proof: drop the runtime's `mouseout` listener; the heading stays outlined, and named in
  // the app, once the pointer has left the page.
  test("picking what to comment on, leaves nothing outlined once the pointer leaves the page", () => {
    const { request, events, at, fire } = frame(BOARD)
    request("edit", { on: true, typing: false })

    const heading = at("body>main:0>h1:0")
    fire(heading, "mouseover")
    expect(heading.hasAttribute("data-sixb-hover")).toBe(true)

    fire(heading, "mouseout")
    expect(heading.hasAttribute("data-sixb-hover")).toBe(false)
    expect(events("edit.hover").at(-1)).toMatchObject({ params: { target: null } })
  })

  // Guard proof: drop the `script, style, template` removal from spokenWords; the box's label
  // quotes the script's source. Drop the `start !== root` check from editTarget; the page itself
  // is quoted as what is pointed at.
  test("picking what to comment on, quotes no script's source, and nothing of the page itself", () => {
    const { request, events, at, fire, document } = frame(BOARD)
    request("edit", { on: true, typing: false })

    const main = at("body>main:0")
    const code = document.createElement("script")
    code.textContent = "window.secret = 1"
    main.append(code as unknown as Node)
    fire(main, "mouseover")
    expect(JSON.stringify(events("edit.hover").at(-1))).not.toContain("secret")

    fire(document.documentElement as unknown as Element, "mouseover")
    expect(events("edit.hover").at(-1)).toMatchObject({ params: { target: { kind: "scripted" } } })
    expect(JSON.stringify(events("edit.hover").at(-1))).not.toContain('"label"')
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

  // Guard proof: post edit events with `post` again, to the window's parent; they then reach the
  // parent, where the page's scripts post too. Drop `stopImmediatePropagation` from the runtime's
  // listener; the page's own listener hears the request that hands the port over.
  test("reports editing only through the port the app hands over, which the page never sees", () => {
    const { window, request, posted, throughPort, at, fire } = frame(BOARD)
    const heard: unknown[] = []
    window.addEventListener("message", (event) => heard.push("data" in event ? event.data : event))

    // Without a port, nothing of editing is reported.
    request("edit", { on: true }, { withPort: false })
    fire(at("body>main:0>h1:0"), "click")
    expect(throughPort).toEqual([])

    request("edit", { on: true })
    fire(at("body>main:0>p:0"), "click")
    expect(throughPort.map((message) => message.event)).toEqual(["edit.select"])
    expect(posted.some((message) => String(message.event).startsWith("edit."))).toBe(false)
    expect(heard).toEqual([])
  })

  // Guard proof: drop the `isTrusted` check from the runtime's click handler; the page's script
  // picks the heading and makes it editable.
  test("acts on the reader's own clicks only, never a page script's", () => {
    const { request, events, at, fire } = frame(BOARD)
    request("edit", { on: true })

    const heading = at("body>main:0>h1:0")
    fire(heading, "click", { trusted: false })
    fire(heading, "mouseover", { trusted: false })
    expect(events("edit.select")).toEqual([])
    expect(events("edit.hover")).toEqual([])
    expect(heading.hasAttribute("contenteditable")).toBe(false)
  })
})
