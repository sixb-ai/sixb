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

describe("an opened board's frame, zooming", () => {
  /** A wheel turn or a key, as the reader's own, or as a page's script's. */
  const dispatch = (
    target: unknown,
    event: InstanceType<Window["WheelEvent"]> | InstanceType<Window["KeyboardEvent"]>,
    trusted = true
  ) => {
    Object.defineProperty(event, "isTrusted", { value: trusted })
    ;(target as { dispatchEvent(event: unknown): boolean }).dispatchEvent(event)
    return event.defaultPrevented
  }
  // happy-dom's wheel takes only its deltas: the keys held and the pointer are set on it.
  const wheel = (
    window: Window,
    init: { deltaY: number; ctrlKey?: boolean; metaKey?: boolean }
  ) => {
    const event = new window.WheelEvent("wheel", { cancelable: true, deltaY: init.deltaY })
    for (const [name, value] of Object.entries({
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      clientX: 120,
      clientY: 340,
    })) {
      Object.defineProperty(event, name, { value })
    }
    return event
  }
  const key = (window: Window, init: Record<string, unknown>) =>
    new window.KeyboardEvent("keydown", { cancelable: true, ...init })

  // Guard proof: drop the wheel handler's `preventDefault`; the browser zooms the whole app, as it
  // did before. Drop the handler itself; nothing reaches the app.
  test("sends a pinch or a ⌘-wheel turn through the port, and keeps the browser from zooming", () => {
    const { window, request, events } = frame(BOARD)
    request("edit", { on: false })

    expect(dispatch(window, wheel(window, { ctrlKey: true, deltaY: -50 }))).toBe(true)
    expect(dispatch(window, wheel(window, { metaKey: true, deltaY: 100 }))).toBe(true)
    const [closer, farther] = events("zoom").map((event) => event?.params)
    expect(closer).toMatchObject({ at: { x: 120, y: 340 } })
    expect((closer as { factor: number }).factor).toBeGreaterThan(1)
    expect((farther as { factor: number }).factor).toBeLessThan(1)

    // A wheel turn alone scrolls the page, as ever.
    expect(dispatch(window, wheel(window, { deltaY: 100 }))).toBe(false)
    expect(events("zoom")).toHaveLength(2)
  })

  // Guard proof: drop `appPort !== null` from `forwards`; a document's frame then takes ⌘-wheel
  // from the browser and zooms nothing. Drop `event.isTrusted`; the page's script zooms the app.
  test("leaves zooming to the browser in a frame handed no port, and hears no page script", () => {
    const { window, request, events, posted } = frame(BOARD)

    expect(dispatch(window, wheel(window, { ctrlKey: true, deltaY: -50 }))).toBe(false)
    expect(dispatch(window, key(window, { metaKey: true, key: "=" }))).toBe(false)
    expect(posted.some((message) => message.event === "zoom")).toBe(false)

    request("edit", { on: false })
    expect(dispatch(window, wheel(window, { ctrlKey: true, deltaY: -50 }), false)).toBe(false)
    expect(dispatch(window, key(window, { metaKey: true, key: "=" }), false)).toBe(false)
    expect(events("zoom")).toEqual([])
  })

  // Guard proof: drop the key handler's `capture`; while the reader types in a text, the typing
  // handler stops the key first, and the browser zooms.
  test("sends ⌘ +, − and 0 as steps, even while the reader types in a text", () => {
    const { window, request, events, at, fire } = frame(BOARD)
    request("edit", { on: true })
    const heading = at("body>main:0>h1:0")
    fire(heading, "click")
    expect(heading.getAttribute("contenteditable")).toBe("plaintext-only")

    const press = (init: Record<string, unknown>) =>
      dispatch(heading, key(window, { bubbles: true, ...init }))
    expect(press({ metaKey: true, key: "=" })).toBe(true)
    expect(press({ ctrlKey: true, key: "-" })).toBe(true)
    expect(press({ metaKey: true, key: "0" })).toBe(true)
    // Without ⌘ or Ctrl, the keys are the text's.
    expect(press({ key: "0" })).toBe(false)
    expect(events("zoom").map((event) => event?.params)).toEqual([
      { step: "in" },
      { step: "out" },
      { step: "actual" },
    ])
  })

  // Guard proof: measure the spread in the frame's pixels; the second move, after the frame grew
  // with the first, zooms out as the fingers spread, and a real pinch shakes.
  test("zooms by a pinch measured on the screen, as the frame grows under the fingers", () => {
    const { window, request, events } = frame(BOARD)
    request("edit", { on: false })

    // Fingers on the screen, and in the frame's pixels, the frame drawn `scale` times its size.
    const pinch = (type: string, scale: number, ...xs: number[]) => {
      const touches: Record<number | "length", unknown> = { length: xs.length }
      xs.forEach((x, index) => {
        touches[index] = { screenX: x, screenY: 100, clientX: x / scale, clientY: 100 / scale }
      })
      const event = new window.Event(type, { cancelable: true })
      Object.defineProperty(event, "touches", { value: touches })
      return dispatch(window, event as never)
    }
    pinch("touchstart", 2, 100, 200)
    expect(pinch("touchmove", 2, 90, 210)).toBe(true)
    // The app zoomed 1.2 times: the frame is drawn larger.
    pinch("touchmove", 2.4, 80, 220)

    const factors = events("zoom").map((event) => (event?.params as { factor: number }).factor)
    expect(factors[0]).toBeCloseTo(1.2)
    expect(factors[1]).toBeCloseTo(140 / 120)
    expect(events("zoom")[0]?.params).toMatchObject({ at: { x: 75, y: 50 } })
  })

  test("takes a zoom as the app can use it: a step it knows, or a finite factor kept in bounds", () => {
    const parse = (params: unknown) =>
      parseFrameEvent({ protocol: FRAME_PROTOCOL, event: "zoom", params })?.params

    expect(parse({ step: "in" })).toEqual({ step: "in" })
    expect(parse({ step: "page" })).toBeUndefined()
    expect(parse({ factor: 1.5, at: { x: 1, y: 2 } })).toEqual({ factor: 1.5, at: { x: 1, y: 2 } })
    expect(parse({ factor: 1000, at: { x: 1, y: 2 } })).toEqual({ factor: 4, at: { x: 1, y: 2 } })
    expect(parse({ factor: 0, at: { x: 1, y: 2 } })).toBeUndefined()
    expect(parse({ factor: Number.NaN, at: { x: 1, y: 2 } })).toBeUndefined()
    expect(parse({ factor: 2 })).toBeUndefined()
  })
})

describe("a board's frame running on the canvas", () => {
  /** An event as the reader's own, or a page script's, with what happy-dom leaves out set on it. */
  const dispatch = (
    target: unknown,
    event: Event | InstanceType<Window["Event"]>,
    fields: Record<string, unknown> = {},
    trusted = true
  ) => {
    for (const [name, value] of Object.entries({ ...fields, isTrusted: trusted })) {
      Object.defineProperty(event, name, { value })
    }
    ;(target as { dispatchEvent(event: unknown): boolean }).dispatchEvent(event)
    return event.defaultPrevented
  }
  const wheel = (window: Window, deltaY: number, timeStamp: number, fields = {}) =>
    [
      new window.WheelEvent("wheel", { cancelable: true, bubbles: true, deltaY }),
      {
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        clientX: 120,
        clientY: 340,
        timeStamp,
        ...fields,
      },
    ] as const
  /**
   * Fingers on the screen, as a touch event lists them: in the frame's pixels too, the frame drawn
   * `scale` times its size.
   */
  const fingers = (scale: number, points: readonly (readonly [number, number])[]) => {
    const touches: Record<number | "length", unknown> = { length: points.length }
    points.forEach(([x, y], index) => {
      touches[index] = { screenX: x, screenY: y, clientX: x / scale, clientY: y / scale }
    })
    return touches
  }
  const touch = (
    window: Window,
    type: string,
    points: readonly (readonly [number, number])[] = [],
    scale = 2
  ) =>
    [
      new window.Event(type, { cancelable: true, bubbles: true }),
      { touches: fingers(scale, points) },
    ] as const

  /** A list on the board that scrolls, down to `room` pixels further. */
  const scroller = (document: Window["document"], room: number) => {
    const list = document.createElement("div")
    list.style.overflowY = "auto"
    list.innerHTML = "<p>Row</p>"
    for (const [name, value] of Object.entries({
      scrollHeight: 900,
      clientHeight: 300,
      scrollTop: 600 - room,
    })) {
      Object.defineProperty(list, name, { value, configurable: true })
    }
    document.body.append(list)
    return list.firstElementChild as unknown as Element
  }

  // Guard proof: drop the `!onCanvas` return before panning; an opened board's frame takes every
  // wheel turn from the browser, and its page never scrolls. Drop the `preventDefault`; the page
  // scrolls under the canvas as it pans.
  test("pans the canvas by the wheel and zooms it, and an opened board's frame still scrolls", () => {
    const opened = frame(BOARD)
    opened.request("edit", { on: false })
    expect(dispatch(opened.window, ...wheel(opened.window, 100, 0))).toBe(false)
    expect(opened.events("pan")).toEqual([])

    const { window, request, events } = frame(BOARD)
    request("canvas", { moving: false }, { withPort: true })
    expect(dispatch(window, ...wheel(window, 100, 0))).toBe(true)
    expect(dispatch(window, ...wheel(window, -50, 1000, { shiftKey: true }))).toBe(true)
    expect(dispatch(window, ...wheel(window, -50, 2000, { ctrlKey: true }))).toBe(true)
    expect(events("pan").map((event) => event?.params)).toEqual([
      { x: 0, y: 100, by: "wheel" },
      // Shift turns it sideways, but on a Mac, which does it itself.
      { x: -50, y: 0, by: "wheel" },
    ])
    expect(events("zoom")[0]?.params).toMatchObject({ at: { x: 120, y: 340 } })
  })

  // Guard proof: drop `!canvasMoving` from the gesture's first turn; a page coming under a still
  // pointer as the canvas pans takes the gesture, and the canvas stops. Drop the timestamp check,
  // deciding each turn anew; the gesture that scrolled the list to its end pans the canvas on.
  test("scrolls the page under the pointer for a whole gesture, unless the canvas was panning", () => {
    const { window, document, request, events } = frame(BOARD)
    request("canvas", { moving: false }, { withPort: true })
    const row = scroller(document, 40)

    // The list scrolls: the gesture is the page's, even past the list's end.
    expect(dispatch(row, ...wheel(window, 30, 0))).toBe(false)
    Object.defineProperty(row.parentElement, "scrollTop", { value: 600 })
    expect(dispatch(row, ...wheel(window, 30, 100))).toBe(false)
    expect(events("pan")).toEqual([])

    // The next gesture finds the list at its end, and pans.
    expect(dispatch(row, ...wheel(window, 30, 400))).toBe(true)
    expect(events("pan")).toHaveLength(1)

    // Up, the list scrolls again, unless the canvas was panning as the gesture began.
    request("canvas", { moving: true })
    expect(dispatch(row, ...wheel(window, -30, 800))).toBe(true)
    request("canvas", { moving: false })
    expect(dispatch(row, ...wheel(window, -30, 1200))).toBe(false)
    expect(events("pan")).toHaveLength(2)
  })

  // Guard proof: drop `forwards` from the touchmove handler; a page's script dragging its own
  // fingers moves the canvas. Drop the pan from the pinch; two fingers moving together leave the
  // canvas where it was.
  test("pans by a finger's drag and zooms by a pinch, and leaves a tap to the page", () => {
    const { window, request, events } = frame(BOARD)
    request("canvas", { moving: false }, { withPort: true })

    // A tap, moving less than a few pixels, is the page's.
    dispatch(window, ...touch(window, "touchstart", [[100, 100]]))
    expect(dispatch(window, ...touch(window, "touchmove", [[103, 102]]))).toBe(false)
    dispatch(window, ...touch(window, "touchend"))
    expect(events("pan")).toEqual([])

    // A drag scrolls the canvas the way a page would scroll: the content follows the finger.
    dispatch(window, ...touch(window, "touchstart", [[100, 100]]))
    expect(dispatch(window, ...touch(window, "touchmove", [[110, 90]]))).toBe(true)
    expect(dispatch(window, ...touch(window, "touchmove", [[112, 90]]))).toBe(true)
    expect(events("pan").map((event) => event?.params)).toEqual([
      { x: -10, y: 10, by: "touch" },
      { x: -2, y: 0, by: "touch" },
    ])

    // A page's script moving the reader's finger moves nothing.
    dispatch(window, ...touch(window, "touchmove", [[200, 200]]), false)
    expect(events("pan")).toHaveLength(2)

    // A second finger: the pinch zooms by the fingers' spread, and pans by their middle.
    const fingers = (type: string, ...xs: number[]) =>
      dispatch(
        window,
        ...touch(
          window,
          type,
          xs.map((x) => [x, 100] as const)
        )
      )
    fingers("touchstart", 100, 200)
    expect(fingers("touchmove", 90, 210)).toBe(true)
    expect(fingers("touchmove", 100, 220)).toBe(true)
    const zooms = events("zoom").map((event) => (event?.params as { factor: number }).factor)
    expect(zooms[0]).toBeCloseTo(1.2)
    expect(zooms[1]).toBeCloseTo(1)
    expect(events("zoom")[0]?.params).toMatchObject({ at: { x: 75, y: 50 } })
    expect(events("pan").at(-1)?.params).toEqual({ x: -10, y: 0, by: "touch" })

    // A frame handed no port leaves a drag to the page.
    const alone = frame(BOARD)
    dispatch(alone.window, ...touch(alone.window, "touchstart", [[100, 100]]))
    expect(dispatch(alone.window, ...touch(alone.window, "touchmove", [[200, 200]]))).toBe(false)
  })

  // Guard proof: drop the `SPACE_TAKERS` check; Space typed in a field pans instead. Drop the
  // keyup's `preventDefault`; a button the reader clicked is pressed again as they let go.
  test("holds Space for the canvas to drag, outside what takes Space itself", () => {
    const { window, document, request, events } = frame(BOARD)
    request("canvas", { moving: false }, { withPort: true })
    const key = (type: string) =>
      new window.KeyboardEvent(type, { key: " ", cancelable: true, bubbles: true })

    const button = document.createElement("button")
    document.body.append(button)
    button.focus()
    expect(dispatch(button, key("keydown"))).toBe(true)
    expect(dispatch(button, key("keydown"), { repeat: true })).toBe(true)
    expect(dispatch(button, key("keyup"))).toBe(true)
    expect(events("space").map((event) => event?.params)).toEqual([{ down: true }, { down: false }])

    const field = document.createElement("input")
    document.body.append(field)
    field.focus()
    expect(dispatch(field, key("keydown"))).toBe(false)
    expect(dispatch(field, key("keyup"))).toBe(false)
    expect(events("space")).toHaveLength(2)
  })

  // Guard proof: drop `event.isTrusted` from the press through the port; a page's script clicking
  // its own button at load glides the canvas away.
  test("sends the reader's own presses through the port", () => {
    const { window, document, request, events, posted, fire } = frame(BOARD)
    request("canvas", { moving: false }, { withPort: true })
    const button = document.createElement("button")
    button.textContent = "Continue"
    document.body.append(button)

    fire(button, "click", { trusted: false })
    expect(events("press")).toEqual([])
    fire(button, "click")
    expect(events("press").map((event) => event?.params)).toEqual([{ text: "Continue" }])
    expect(posted.filter((message) => message.event === "press")).toHaveLength(2)
    expect(window.document.getElementById("sixb-canvas")?.textContent).toContain("touch-action")
  })

  test("takes a pan and Space as the app can use them", () => {
    const parse = (event: string, params: unknown) =>
      parseFrameEvent({ protocol: FRAME_PROTOCOL, event, params })?.params

    expect(parse("pan", { x: 1, y: -2, by: "wheel" })).toEqual({ x: 1, y: -2, by: "wheel" })
    expect(parse("pan", { x: 1e9, y: 0, by: "touch" })).toEqual({ x: 4000, y: 0, by: "touch" })
    expect(parse("pan", { x: 1, y: 2, by: "mouse" })).toBeUndefined()
    expect(parse("pan", { x: Number.NaN, y: 2, by: "wheel" })).toBeUndefined()
    expect(parse("space", { down: true })).toEqual({ down: true })
    expect(parse("space", { down: "yes" })).toBeUndefined()
  })
})
