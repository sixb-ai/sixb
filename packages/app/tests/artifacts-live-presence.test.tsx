import { describe, expect, test } from "bun:test"
import { type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { AGENT_AWARENESS_FIELD, USER_AWARENESS_FIELD } from "@sixb/core/artifacts/live"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"
import { LiveAvatars, LiveSaveStatus, liveSaveLabel } from "../src/artifacts/live/header"
import { LiveArtifact, type LiveArtifactState } from "../src/artifacts/live/session"
import { installDom } from "./helpers/dom"

// React Flow measures its view and its items by their offset size, which happy-dom leaves at 0:
// here the view is 1600 by 1000, and an item the size its style sets.
const VIEW = { width: 1600, height: 1000 }

function sizeOf(element: Element): { width: number; height: number } {
  if (element.classList.contains("react-flow__renderer")) return VIEW
  const style = (element as HTMLElement).style
  return {
    width: Number.parseFloat(style.width) || 0,
    height: Number.parseFloat(style.height) || 0,
  }
}

interface ResizeEntry {
  readonly target: Element
  readonly contentRect: { readonly width: number; readonly height: number }
}

/**
 * Reports the elements it observes once, together, as a browser does after a layout: React Flow
 * measures the items then, and fits the view to them.
 */
class ReportingResizeObserver {
  readonly #report: (entries: ResizeEntry[]) => void
  #pending: Element[] = []

  constructor(report: (entries: ResizeEntry[]) => void) {
    this.#report = report
  }

  observe(target: Element) {
    this.#pending.push(target)
    if (this.#pending.length > 1) return

    queueMicrotask(() => {
      const targets = this.#pending
      this.#pending = []
      this.#report(targets.map((element) => ({ target: element, contentRect: sizeOf(element) })))
    })
  }

  unobserve() {}

  disconnect() {}
}

const browser = installDom(
  [
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLIFrameElement",
    "SVGElement",
    "Event",
    "MessageEvent",
    "MouseEvent",
    "PointerEvent",
    "EventTarget",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
    "DOMMatrixReadOnly",
  ],
  { values: { ResizeObserver: ReportingResizeObserver } }
)

for (const [axis, side] of [
  ["offsetWidth", "width"],
  ["offsetHeight", "height"],
] as const) {
  Object.defineProperty(browser.HTMLElement.prototype, axis, {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this)[side]
    },
  })
}

// An opened board fits the room it is given, which happy-dom lays out at nothing: 1200 by 700.
const ROOM = { width: 1200, height: 700 }
for (const [axis, side] of [
  ["clientWidth", "width"],
  ["clientHeight", "height"],
] as const) {
  Object.defineProperty(browser.HTMLElement.prototype, axis, {
    configurable: true,
    get() {
      return ROOM[side]
    },
  })
}

function canvasOf(value: unknown): Canvas {
  const parsed = parseCanvas(JSON.stringify(value))
  if (!("canvas" in parsed)) throw new Error(parsed.error)
  return parsed.canvas
}

const CANVAS = canvasOf({
  items: [
    { id: "home", type: "board", file: "boards/home.html", x: 0, y: 0, w: 390, h: 400 },
    { id: "pay", type: "board", file: "boards/pay.html", x: 520, y: 0, w: 390, h: 400 },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, h: 120, text: "Annual first?" },
  ],
})

/** Someone else on the artifact, or the server's own state, as their awareness reaches it. */
function hear(live: LiveArtifact, clientID: number, state: Record<string, unknown> | null) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  const other = new awarenessProtocol.Awareness(doc)
  other.setLocalState(state)
  other.setLocalState(state === null ? null : { ...state })
  const update = awarenessProtocol.encodeAwarenessUpdate(other, [clientID])
  awarenessProtocol.applyAwarenessUpdate(live.awareness, update, "server")
  other.destroy()
}

const person = (id: string, name: string, color: string) => ({
  [USER_AWARENESS_FIELD]: { id, name, color },
})

describe("who is on a live canvas", () => {
  test("shows each person's selection in their color, and the boards an Agent turn changes", async () => {
    // Reproduce by leaving PresenceLayer out of the board in canvas.tsx: Bob's selection and the
    // Agent's board show nowhere.
    const live = new LiveArtifact("art_c4nv4s0000", () => false)
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={cache}>
          <CanvasBoard canvas={CANVAS} title="Checkout" mode="light" live={live} />
        </QueryClientProvider>
      )
    })
    if (!view) throw new Error("The board did not render.")

    await act(async () => {
      hear(live, 11, { ...person("user:bob", "Bob", "#0090ff"), selection: ["pay"] })
      hear(live, 12, { [AGENT_AWARENESS_FIELD]: [{ runId: "run_1", boards: ["home"] }] })
    })
    const peer = view.container.querySelector('[data-peer-selection="pay"]') as HTMLElement | null
    expect(peer?.textContent).toBe("Bob")
    expect(peer?.style.boxShadow).toContain("#0090ff")
    const agent = view.container.querySelector('[data-agent-board="home"]')
    expect(agent?.textContent).toBe("Agent is changing this board")
    expect(view.container.querySelectorAll("[data-agent-board]")).toHaveLength(1)

    // Bob leaves and the turn ends: nothing is left over the canvas.
    await act(async () => {
      hear(live, 11, null)
      hear(live, 12, null)
    })
    expect(view.container.querySelector("[data-peer-selection], [data-agent-board]")).toBeNull()
    live.destroy()
  })

  test("puts a face in the header for each other person, once, and the Agent while it works", async () => {
    // Reproduce by listing peers rather than people in presence.ts: Bob, in two tabs, shows twice.
    const live = new LiveArtifact("art_c4nv4s0000", () => false)
    const view = render(<LiveAvatars live={live} />)
    expect(view.container.innerHTML).toBe("")

    await act(async () => {
      hear(live, 21, person("user:bob", "Bob Martin", "#0090ff"))
      hear(live, 22, person("user:bob", "Bob Martin", "#0090ff"))
      hear(live, 23, person("user:carol", "Carol", "#46a758"))
      hear(live, 24, { [AGENT_AWARENESS_FIELD]: [{ runId: "run_1", boards: ["home"] }] })
    })
    const group = view.getByRole("group")
    expect(group.getAttribute("aria-label")).toBe("Here now: Bob Martin, Carol, Agent")
    expect(group.textContent).toBe("BMCA")
    expect(group.querySelector("[data-live-agent]")).not.toBeNull()
    live.destroy()
  })

  test("says where the reader's changes are, as a document editor does", () => {
    const state: LiveArtifactState = {
      connection: "online",
      access: "edit",
      synced: true,
      save: { state: "saved", revision: 4 },
      pending: false,
      user: null,
      left: null,
    }
    expect(liveSaveLabel(state)).toBe("saved")
    expect(liveSaveLabel({ ...state, pending: true })).toBe("saving")
    expect(liveSaveLabel({ ...state, save: { state: "unsaved", revision: 4 } })).toBe("saving")
    expect(liveSaveLabel({ ...state, save: { state: "failed", revision: 4, error: "x" } })).toBe(
      "failed"
    )
    expect(liveSaveLabel({ ...state, connection: "offline", pending: true })).toBe("offline")
  })

  test("folds the save state into an icon, its words read out", () => {
    const state: LiveArtifactState = {
      connection: "online",
      access: "edit",
      synced: true,
      save: { state: "failed", revision: 4, error: "storage is down" },
      pending: true,
      user: null,
      left: null,
    }
    const view = render(<LiveSaveStatus state={state} />)
    const status = view.getByRole("status")
    expect(status.getAttribute("data-save")).toBe("failed")
    expect(status.textContent).toBe("Couldn't save — retrying")

    // Saving and saved come and go with every change: they are shown, never announced.
    // Reproduce by giving LiveSaveStatus role="status" whatever its state.
    view.rerender(<LiveSaveStatus state={{ ...state, save: { state: "saving", revision: 4 } }} />)
    expect(view.queryByRole("status")).toBeNull()
    expect(view.container.querySelector("[data-save]")?.getAttribute("data-save")).toBe("saving")
  })
})
