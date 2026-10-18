import { describe, expect, test } from "bun:test"
import { type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { act, render } from "@testing-library/react"
import { canvasExtent, canvasGraph } from "../src/artifacts/renderers/canvas/layout"
import { CanvasThumbnail } from "../src/artifacts/renderers/canvas/thumbnail"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "DOMMatrixReadOnly",
])

function canvasOf(value: unknown): Canvas {
  const parsed = parseCanvas(JSON.stringify(value))
  if (!("canvas" in parsed)) throw new Error(parsed.error)
  return parsed.canvas
}

const CANVAS = canvasOf({
  items: [
    { id: "flow", type: "section", x: -40, y: -80, w: 1000, h: 600, title: "Flow" },
    {
      id: "home",
      type: "board",
      file: "boards/home.html",
      x: 0,
      y: 0,
      w: 390,
      h: 400,
      title: "Home",
    },
    { id: "pay", type: "board", file: "boards/pay.html", x: 520, y: 0, w: 390, h: 400 },
    { id: "next", type: "arrow", from: "home", to: "pay", label: "Continue" },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, text: "Annual first?" },
    { id: "title", type: "text", x: 0, y: -200, text: "Checkout", size: "xl" },
    { id: "paid", type: "shape", shape: "diamond", x: 1100, y: 100, w: 160, h: 120, text: "Paid?" },
    {
      id: "chart",
      type: "embed",
      src: "artifact:art_k3m9q2x7tp#chart=revenue",
      x: 1100,
      y: 300,
      w: 320,
      h: 200,
    },
    { id: "hint", type: "arrow", from: { x: 1180, y: 600 }, to: "paid", dashed: true },
  ],
})

describe("a canvas's layout", () => {
  test("puts each item at its place and size, sections behind, arrows between what they join", () => {
    const { nodes, edges } = canvasGraph(CANVAS)
    const node = (id: string) => nodes.find((entry) => entry.id === id)
    expect(node("home")).toMatchObject({
      type: "board",
      position: { x: 0, y: 0 },
      width: 390,
      height: 400,
      focusable: true,
    })
    // Sections draw behind everything; the rest in the order the canvas lists them.
    expect(node("flow")?.zIndex).toBe(-1)
    expect(node("pay")?.zIndex).toBeLessThan(node("ask")?.zIndex ?? 0)
    // A note without a height, and a text, are measured once drawn.
    expect(node("ask")).not.toHaveProperty("height")
    expect(node("title")).not.toHaveProperty("width")
    expect(node("ask")?.focusable).toBe(false)
    expect(edges).toEqual([
      expect.objectContaining({
        id: "next",
        source: "home",
        target: "pay",
        data: { label: "Continue", dashed: false },
      }),
      expect.objectContaining({
        id: "hint",
        source: "hint:from",
        target: "paid",
        data: { dashed: true },
      }),
    ])
    // An arrow's end at a bare point is an invisible node there.
    expect(node("hint:from")).toMatchObject({ type: "point", position: { x: 1180, y: 600 } })
    // Arrows draw over every item, so one to a point on a board shows on it. Reproduce by
    // dropping the edges' zIndex: React Flow draws them under the nodes.
    const top = Math.max(...nodes.map((entry) => entry.zIndex ?? 0))
    for (const edge of edges) expect(edge.zIndex ?? 0).toBeGreaterThan(top)
  })

  test("measures everything it holds", () => {
    expect(canvasExtent(CANVAS)).toMatchObject({ x: -40, y: expect.any(Number), width: 1460 })
  })
})

describe("a canvas's card", () => {
  test("draws its items small, sections as their headings, with the arrows between them", () => {
    const view = render(<CanvasThumbnail canvas={CANVAS} />)
    const svg = view.container.querySelector("svg")
    const extent = canvasExtent(CANVAS)
    const margin = Math.max(extent.width, extent.height) / 20
    expect(svg?.getAttribute("viewBox")).toBe(
      `${extent.x - margin} ${extent.y - margin} ${extent.width + margin * 2} ${extent.height + margin * 2}`
    )
    // Section, two boards, note, text, shape, embed: seven shapes; then two arrows as lines.
    expect(svg?.querySelectorAll("rect")).toHaveLength(7)
    expect(svg?.querySelectorAll("line")).toHaveLength(2)
    // The section is its heading, a line at its top left, not the 1000-pixel region it names.
    const heading = svg?.querySelector("rect")
    expect(heading?.getAttribute("x")).toBe("-40")
    expect(Number(heading?.getAttribute("width"))).toBeLessThan(100)
    view.unmount()
  })
})

describe("a canvas's board", () => {
  async function mount(mode: "light" | "dark") {
    // Imported here, as the viewer loads it: the board's module brings React Flow.
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<CanvasBoard canvas={CANVAS} title="Checkout" mode={mode} />)
    })
    if (!view) throw new Error("The board did not render.")
    return view
  }

  test("draws each item as what it is", async () => {
    const view = await mount("light")
    const node = (id: string) => view.container.querySelector(`.react-flow__node[data-id="${id}"]`)
    expect(node("flow")?.textContent).toBe("Flow")
    expect(node("home")?.textContent).toContain("Home")
    // A board without a title is named by its id.
    expect(node("pay")?.textContent).toBe("pay")
    expect(node("ask")?.textContent).toBe("Annual first?")
    expect(node("title")?.textContent).toBe("Checkout")
    expect(node("paid")?.querySelector("polygon")).not.toBeNull()
    expect(node("chart")?.textContent).toContain("Embedded artifact")
    // A board takes focus from the keyboard; a note is read where it lies.
    expect(node("home")?.getAttribute("tabindex")).toBe("0")
    expect(node("ask")?.getAttribute("tabindex")).toBeNull()
    expect(view.getByRole("region").getAttribute("aria-label")).toBe("Canvas Checkout")
    view.unmount()
  })

  test("draws in the mode it is given, not React Flow's light default", async () => {
    // The app's light tokens answer to `.light`: a board left at React Flow's default draws
    // light in dark mode. Reproduce by dropping colorMode from the board.
    const view = await mount("dark")
    const flow = view.container.querySelector(".react-flow")
    expect(flow?.classList.contains("dark")).toBe(true)
    expect(flow?.classList.contains("light")).toBe(false)
    view.unmount()
  })
})
