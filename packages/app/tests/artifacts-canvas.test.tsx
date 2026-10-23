import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { liveBoards, MAX_LIVE_BOARDS } from "../src/artifacts/renderers/canvas/board"
import { BoardFocus } from "../src/artifacts/renderers/canvas/focus"
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
  async function mount(
    mode: "light" | "dark",
    canvas: Canvas = CANVAS,
    seed: (cache: QueryClient) => void = () => {}
  ) {
    // Imported here, as the viewer loads it: the board's module brings React Flow.
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    seed(cache)
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={cache}>
          <CanvasBoard canvas={canvas} title="Checkout" mode={mode} />
        </QueryClientProvider>
      )
    })
    if (!view) throw new Error("The board did not render.")
    return view
  }

  test("draws each item as what it is", async () => {
    const view = await mount("light")
    const node = (id: string) => view.container.querySelector(`.react-flow__node[data-id="${id}"]`)
    expect(node("flow")?.textContent).toBe("Flow")
    expect(node("home")?.textContent).toContain("Home")
    // A board without a title is named by its id; until its page runs, it is a bare outline.
    expect(node("pay")?.textContent).toBe("pay")
    expect(node("ask")?.textContent).toBe("Annual first?")
    expect(node("title")?.textContent).toBe("Checkout")
    expect(node("paid")?.querySelector("polygon")).not.toBeNull()
    // The chart it embeds can't be read here: the item says so in place.
    expect(node("chart")?.textContent).toContain("Unavailable")
    // A board takes focus from the keyboard; a note is read where it lies.
    expect(node("home")?.getAttribute("tabindex")).toBe("0")
    expect(node("ask")?.getAttribute("tabindex")).toBeNull()
    expect(view.getByRole("region").getAttribute("aria-label")).toBe("Canvas Checkout")
    view.unmount()
  })

  test("shows another artifact at the item's size, and says so where the reader can't open it", async () => {
    const plan = "art_p4gep4n000"
    const canvas = canvasOf({
      items: [
        {
          id: "plan",
          type: "embed",
          src: `artifact:${plan}`,
          x: 0,
          y: 0,
          w: 480,
          h: 300,
          title: "Plan",
        },
        {
          id: "gone",
          type: "embed",
          src: "artifact:art_g0neg0ne00#chart=x",
          x: 600,
          y: 0,
          w: 480,
          h: 300,
        },
      ],
    })
    const view = await mount("light", canvas, (cache) =>
      cache.setQueryData(
        getArtifactVersionQueryKey({ path: { artifactId: plan, version: "latest" } }),
        {
          artifactId: plan,
          version: 2,
          title: "Q4 crew capacity planner",
          entry: "index.html",
          files: [],
          outline: { kind: "page", title: "Q4 crew capacity planner" },
          references: [],
          author: { type: "user", id: "user-1" },
          createdAt: "2026-10-18T12:00:00.000Z",
        }
      )
    )
    const node = (id: string) =>
      view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
    // Reproduce by drawing embeds as tiles: neither shows the artifact or the notice. A page
    // runs live, filling the item.
    expect(node("plan")?.querySelector("[data-sixb-page-embed]")).not.toBeNull()
    expect(node("plan")?.style.width).toBe("480px")
    expect(node("gone")?.textContent).toContain("It may have been deleted.")
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

describe("live boards", () => {
  const row = Array.from({ length: 8 }, (_, index) => ({
    id: `b${index}`,
    x: index * 500,
    y: 0,
    w: 390,
    h: 844,
  }))
  const view = (panX: number, zoom: number) => ({
    transform: [panX, 0, zoom] as const,
    width: 1600,
    height: 1000,
  })

  test("run the boards on screen, and keep running those that are as the view zooms out", () => {
    // At 100% from the origin, boards 0 to 3 are on screen; board 4 starts past the right edge.
    const near = liveBoards(row, view(0, 1))
    expect([...near].sort()).toEqual(["b0", "b1", "b2", "b3"])
    // Panned along, the ones that left the screen stop and the ones that came on start.
    expect([...liveBoards(row, view(-2000, 1))].sort()).toEqual(["b4", "b5", "b6", "b7"])
    // At 10%, a board is 39 pixels wide on screen: none starts there, but those running keep
    // running, so zooming out never reloads a page. Reproduce by dropping the running set.
    expect(liveBoards(row, view(0, 0.1)).size).toBe(0)
    expect([...liveBoards(row, view(0, 0.1), near)].sort()).toEqual(["b0", "b1", "b2", "b3"])
  })

  test("run at most twelve, those nearest the middle of the view", () => {
    // Twenty boards in four rows of five, all on screen at 42%: twelve run, the corners don't.
    const grid = Array.from({ length: 20 }, (_, index) => ({
      id: `g${index}`,
      x: (index % 5) * 420,
      y: Math.floor(index / 5) * 560,
      w: 390,
      h: 520,
    }))
    const live = liveBoards(grid, { transform: [40, 20, 0.42], width: 1000, height: 1000 })
    expect(live.size).toBe(MAX_LIVE_BOARDS)
    for (const corner of ["g0", "g4", "g15", "g19"]) expect(live.has(corner)).toBe(false)
    expect(live.has("g7")).toBe(true)
    // A corner already running keeps its place over a board nearer the middle.
    expect(
      liveBoards(grid, { transform: [40, 20, 0.42], width: 1000, height: 1000 }, new Set(["g0"]))
    ).toContain("g0")
  })
})

describe("a board opened over its canvas", () => {
  const version = {
    artifactId: "art_0nb0ard1ng",
    version: 1,
    title: "Onboarding",
    entry: "canvas.json",
    files: [],
    outline: { kind: "canvas", items: [] },
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-18T12:00:00.000Z",
  } as unknown as GetArtifactVersionResponse
  const boards = CANVAS.items.filter((item) => item.type === "board")
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })

  test("steps through the boards with ← and →, and goes back with Esc", async () => {
    const opened: string[] = []
    let closed = 0
    const view = render(
      <QueryClientProvider client={client()}>
        <BoardFocus
          version={version}
          boards={boards}
          id="home"
          onOpen={(id) => opened.push(id)}
          onClose={() => {
            closed += 1
          }}
        />
      </QueryClientProvider>
    )
    expect(view.getByRole("dialog").getAttribute("aria-label")).toBe("Home, opened from the canvas")
    expect(view.getByText("1 of 2")).toBeTruthy()
    // The first board has nothing before it.
    fireEvent.keyDown(window, { key: "ArrowLeft" })
    fireEvent.keyDown(window, { key: "ArrowRight" })
    fireEvent.keyDown(window, { key: "Escape" })
    expect(opened).toEqual(["pay"])
    expect(closed).toBe(1)
    view.unmount()
  })

  test("opens focused when an address names a board", async () => {
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={client()}>
          <CanvasBoard
            canvas={CANVAS}
            version={version}
            title="Checkout"
            mode="light"
            focus="pay"
          />
        </QueryClientProvider>
      )
    })
    expect(view?.getByRole("dialog").getAttribute("aria-label")).toBe("pay, opened from the canvas")
    view?.unmount()
    // A section an address names opens the board on it, with nothing over it.
    await act(async () => {
      view = render(
        <QueryClientProvider client={client()}>
          <CanvasBoard
            canvas={CANVAS}
            version={version}
            title="Checkout"
            mode="light"
            focus="flow"
          />
        </QueryClientProvider>
      )
    })
    expect(view?.queryByRole("dialog")).toBeNull()
    view?.unmount()
  })
})
