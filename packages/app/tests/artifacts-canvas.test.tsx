import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import {
  BOARD_PREVIEW_WAIT_MS,
  type Canvas,
  type CanvasArrow,
  type CanvasBoard,
  FRAME_PROTOCOL,
  parseCanvas,
} from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { AppWindow } from "lucide-react"
import { frameLinkKey } from "../src/artifacts/frame"
import {
  ItemTile,
  LiveBoard,
  LiveBoardsProvider,
  liveBoards,
  MAX_LIVE_BOARDS,
} from "../src/artifacts/renderers/canvas/board"
import { BoardFocus, followedArrow } from "../src/artifacts/renderers/canvas/focus"
import { canvasExtent, canvasGraph } from "../src/artifacts/renderers/canvas/layout"
import {
  boardPreviewSize,
  boardPreviewsQuery,
  nextPreviewCheck,
} from "../src/artifacts/renderers/canvas/previews"
import { CanvasThumbnail } from "../src/artifacts/renderers/canvas/thumbnail"
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

const board = (id: string, x = 0) => ({
  id,
  type: "board",
  file: `boards/${id}.html`,
  x,
  y: 0,
  w: 390,
  h: 400,
})

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

describe("a canvas's card, with its boards' pictures", () => {
  // Guard proof: draw every board as its shape in thumbnail.tsx; the card shows Home as an empty
  // box though its picture is ready.
  test("draws each board whose picture is ready as its small picture, the others as their shapes", async () => {
    const { ArtifactPreview } = await import("../src/artifacts/card-preview")
    const { artifactFileSource } = await import("../src/artifacts/file-source")
    const file = {
      blobId: "blob_canvas",
      digest: `sha256:${"0".repeat(64)}` as const,
      sizeBytes: 10,
      mediaType: "application/json",
    }
    const version = {
      artifactId: "art_c4nv4s0000",
      version: 2,
      title: "Checkout",
      entry: "canvas.json",
      files: [{ path: "canvas.json", file }],
      outline: { kind: "canvas", items: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-18T12:00:00.000Z",
      boardPreviews: { home: "ready", pay: "pending" },
    } as never

    const queries = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
    })
    const source = artifactFileSource({
      artifactId: "art_c4nv4s0000",
      version: 2,
      path: "canvas.json",
      fileRef: file,
    })
    queries.setQueryData([...source.queryKey, "text"], JSON.stringify(CANVAS))

    const view = render(
      <QueryClientProvider client={queries}>
        <ArtifactPreview version={version} kind="canvas" loading={false} />
      </QueryClientProvider>
    )

    const images = [...view.container.querySelectorAll("svg image")]
    expect(images.map((image) => image.getAttribute("href"))).toEqual([
      expect.stringContaining(
        "/api/artifacts/art_c4nv4s0000/versions/2/boards/home/preview?theme=light&size=small"
      ),
    ])
    view.unmount()
  })

  // Guard proof: picture every board whatever their number; a card of a hundred boards fetches a
  // hundred pictures for a box 124 pixels tall.
  test("draws a canvas of many boards as their shapes: each is a few pixels on a card", () => {
    const many: Canvas = {
      items: Array.from({ length: 25 }, (_, index) => ({
        id: `b${index}`,
        type: "board" as const,
        file: `boards/b${index}.html`,
        x: index * 400,
        y: 0,
        w: 390,
        h: 844,
      })),
    }
    const pictures = new Map(many.items.map((item) => [item.id, `${item.id}.webp`]))

    const view = render(<CanvasThumbnail canvas={many} pictures={pictures} />)
    expect(view.container.querySelectorAll("svg image")).toHaveLength(0)
    view.rerender(<CanvasThumbnail canvas={{ items: many.items.slice(1) }} pictures={pictures} />)
    expect(view.container.querySelectorAll("svg image")).toHaveLength(24)
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

  test("draws an xxl title at 120 pixels, bold, over full-size boards", async () => {
    // Reproduce by drawing xxl at xl's 44 pixels: a canvas of seven 1280-wide boards opens near
    // 15%, where its title is 6 pixels tall.
    const titled = canvasOf({
      items: [
        { id: "storyboard", type: "text", x: 0, y: -240, text: "Launch film", size: "xxl" },
        { id: "shot", type: "board", file: "boards/shot.html", x: 0, y: 0, w: 1280, h: 720 },
      ],
    })
    const view = await mount("light", titled)
    const title = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="storyboard"] > div'
    )

    expect(title?.style.fontSize).toBe("120px")
    expect(title?.className).toContain("font-bold")
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

  test("shows another artifact once the view shows it large enough, as a board runs", async () => {
    // Fitted to a shape far away, the embed is under half its size: it is its tile. Reproduce by
    // drawing every embed live, or by working out what runs before the view is fitted: either
    // way the page runs at under a quarter of its size, the second because it ran at 100% first.
    const canvas = canvasOf({
      items: [
        { id: "plan", type: "embed", src: "artifact:art_p4gep4n000", x: 0, y: 0, w: 480, h: 300 },
        { id: "far", type: "shape", shape: "rect", x: 6000, y: 0, w: 240, h: 120 },
      ],
    })
    const view = await mount("light", canvas)
    const plan = view.container.querySelector(`.react-flow__node[data-id="plan"]`)
    expect(plan?.querySelector(".lucide-link2")).not.toBeNull()
    expect(plan?.textContent).not.toContain("Unavailable")
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

  test("start a board with a picture only once it shows at half its size", () => {
    // Its picture shows as much as its page smaller than that: a laptop's board, 1280 wide, waits
    // for 50% when it has one, and starts at 30%, 384 wide, when it has none. Reproduce by
    // dropping `pictured` from liveBoards' rule: the pictured board runs at 30%.
    const laptop = { id: "laptop", x: 0, y: 0, w: 1280, h: 800 }
    const pictured = { ...laptop, pictured: true }
    expect(liveBoards([laptop], view(0, 0.3)).size).toBe(1)
    expect(liveBoards([pictured], view(0, 0.3)).size).toBe(0)
    expect(liveBoards([pictured], view(0, 0.5)).size).toBe(1)
  })

  test("start a board once it shows at half its size, or 360 pixels wide", () => {
    // A phone screen, 390 wide, starts at 50%; a laptop's, 1280 wide, once it is 360 pixels
    // wide, at 28%. Smaller, a page's text can't be read, and its tile shows as much. Reproduce
    // by starting boards at a fixed width, as 48 pixels once did: both run at 20%.
    const phone = { id: "phone", x: 0, y: 0, w: 390, h: 844 }
    const laptop = { id: "laptop", x: 0, y: 0, w: 1280, h: 800 }
    expect(liveBoards([phone], view(0, 0.5)).size).toBe(1)
    expect(liveBoards([phone], view(0, 0.45)).size).toBe(0)
    expect(liveBoards([laptop], view(0, 0.3)).size).toBe(1)
    expect(liveBoards([laptop], view(0, 0.2)).size).toBe(0)
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

  test("run at most eight, those nearest the middle of the view", () => {
    // Twenty boards in four rows of five, all on screen at 50%: eight run, the corners don't.
    const grid = Array.from({ length: 20 }, (_, index) => ({
      id: `g${index}`,
      x: (index % 5) * 420,
      y: Math.floor(index / 5) * 560,
      w: 390,
      h: 520,
    }))
    const view = { transform: [40, 20, 0.5] as const, width: 1000, height: 1000 }
    const live = liveBoards(grid, view)
    expect(live.size).toBe(MAX_LIVE_BOARDS)
    expect(MAX_LIVE_BOARDS).toBe(8)
    for (const corner of ["g0", "g4", "g15", "g19"]) expect(live.has(corner)).toBe(false)
    expect(live.has("g7")).toBe(true)
    // A corner already running keeps its place over a board nearer the middle.
    expect(liveBoards(grid, view, new Set(["g0"]))).toContain("g0")
  })
})

describe("board previews", () => {
  /** An `Image` whose pictures decode when the test says, which happy-dom has none of. */
  function decodedImages() {
    const decoding: { src: string; done: () => void; fail: () => void }[] = []
    const Image = class {
      src = ""
      decode() {
        return new Promise<void>((resolve, reject) => {
          decoding.push({ src: this.src, done: resolve, fail: reject })
        })
      }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Image")
    Object.defineProperty(globalThis, "Image", { configurable: true, value: Image })

    const restore = () => {
      if (previous) Object.defineProperty(globalThis, "Image", previous)
      else Reflect.deleteProperty(globalThis, "Image")
    }
    return { decoding, restore }
  }

  const version = (boardPreviews?: Record<string, "ready" | "pending" | "none">) =>
    ({
      artifactId: "art_0nb0ard1ng",
      version: 3,
      title: "Onboarding",
      entry: "canvas.json",
      files: [],
      outline: { kind: "canvas", items: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-18T12:00:00.000Z",
      ...(boardPreviews ? { boardPreviews } : {}),
    }) as unknown as GetArtifactVersionResponse

  async function mount(previewed: GetArtifactVersionResponse, mode: "light" | "dark") {
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={cache}>
          <CanvasBoard canvas={CANVAS} version={previewed} title="Checkout" mode={mode} />
        </QueryClientProvider>
      )
    })
    if (!view) throw new Error("The board did not render.")
    return view
  }

  test("show a board's picture in the reader's mode once it is ready, its outline until then", async () => {
    // Reproduce by drawing every tile as its outline: no picture shows.
    const view = await mount(version({ home: "ready", pay: "pending" }), "dark")
    const node = (id: string) =>
      view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)

    // Drawn 370 pixels wide, it shows the small picture. Reproduce by asking for the full one
    // whatever the board's size: a canvas fitted to a hundred boards decodes a hundred screens.
    const picture = node("home")?.querySelector("img")
    expect(picture?.getAttribute("src")).toEndWith(
      "/api/artifacts/art_0nb0ard1ng/versions/3/boards/home/preview?theme=dark&size=small"
    )
    // At its width from its top. Reproduce with object-cover: a board taller than its picture,
    // which stops 4000 pixels down, shows it zoomed in and cut at its sides.
    expect(picture?.className).toContain("object-contain")
    expect(picture?.className).toContain("object-top")
    // While it is rendered, the outline says it is on its way.
    expect(node("pay")?.querySelector("img")).toBeNull()
    expect(node("pay")?.querySelector('[aria-busy="true"]')).not.toBeNull()
    view.unmount()

    // A version without previews, or past their wait, shows outlines at rest.
    const bare = await mount(version({ home: "none", pay: "none" }), "light")
    expect(bare.container.querySelector(".react-flow__node img")).toBeNull()
    expect(bare.container.querySelector('[aria-busy="true"]')).toBeNull()
    bare.unmount()
  })

  test("keep a changed board's last picture while its new one is rendered", async () => {
    // Reproduce by dropping the shown picture when the next one is not ready: the board turns
    // into its outline as soon as it changes, and stays blank until the worker renders it.
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    const board = (previewed: GetArtifactVersionResponse) => (
      <QueryClientProvider client={cache}>
        <CanvasBoard canvas={CANVAS} version={previewed} title="Checkout" mode="light" />
      </QueryClientProvider>
    )
    const { restore } = decodedImages()
    try {
      let view: ReturnType<typeof render> | undefined
      await act(async () => {
        view = render(board(version({ home: "ready", pay: "ready" })))
      })
      if (!view) throw new Error("The board did not render.")
      const home = () =>
        view?.container.querySelector<HTMLElement>('.react-flow__node[data-id="home"] img')

      // Version 4 changed Home: its picture is on its way, and the last one stays, breathing.
      await act(async () => {
        view?.rerender(board({ ...version({ home: "pending", pay: "ready" }), version: 4 }))
      })
      expect(home()?.getAttribute("src")).toContain("/versions/3/boards/home/preview")
      expect(home()?.getAttribute("aria-busy")).toBe("true")

      // Version 5 changed it again, and no picture will come: the outline, at rest.
      await act(async () => {
        view?.rerender(board({ ...version({ home: "none", pay: "ready" }), version: 5 }))
      })
      expect(home()).toBeNull()
      view.unmount()
    } finally {
      restore()
    }
  })

  test("keep the picture under a board's frame as it starts, so it never flashes blank", async () => {
    // The frame fades in over the picture once its page is ready. Reproduce by giving the frame
    // the tile as its fallback again: the picture is drawn anew as the board starts.
    const previewed = version({ home: "ready" })
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    cache.setQueryData(frameLinkKey(previewed), {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-10-18T13:00:00.000Z",
    })
    let running = false
    const listeners = new Set<() => void>()
    const live = {
      has: () => running,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const picture = <img src="home.png" alt="" />
    const view = render(
      <QueryClientProvider client={cache}>
        <LiveBoardsProvider value={{ version: previewed, live, previews: {}, mode: "light" }}>
          <LiveBoard id="home" file="boards/home.html" title="Home" tile={picture} />
        </LiveBoardsProvider>
      </QueryClientProvider>
    )
    const before = view.container.querySelector("img")
    expect(view.container.querySelector("iframe")).toBeNull()

    await act(async () => {
      running = true
      for (const listener of listeners) listener()
    })
    expect(view.container.querySelector("iframe")).not.toBeNull()
    expect(view.container.querySelector("img")).toBe(before)
    view.unmount()
  })

  test("show the small picture while it covers the board pixel for pixel, the full one past it", () => {
    expect(boardPreviewSize(390 * 0.5, 2)).toBe("small")
    expect(boardPreviewSize(480, 1)).toBe("small")
    expect(boardPreviewSize(390, 2)).toBe("full")
    expect(boardPreviewSize(1280 * 0.4, 1)).toBe("full")
  })

  test("keep the picture shown until the next has decoded, and fall back when one fails", async () => {
    // A sharper picture, or one in the other mode, takes the shown one's place once it can be
    // drawn. Reproduce by showing each new source at once: the tile shows the one still loading.
    const { decoding, restore } = decodedImages()
    try {
      const view = render(<ItemTile icon={AppWindow} preview="small.png" fallback="full.png" />)
      const shown = () => view.container.querySelector("img")?.getAttribute("src")
      expect(shown()).toBe("small.png")

      view.rerender(<ItemTile icon={AppWindow} preview="full.png" />)
      expect(shown()).toBe("small.png")
      await act(async () => decoding.at(-1)?.done())
      expect(shown()).toBe("full.png")

      // A picture that can't be had gives way to its fallback, then to the outline.
      view.rerender(<ItemTile icon={AppWindow} preview="missing.png" fallback="full.png" />)
      await act(async () => decoding.at(-1)?.fail())
      expect(shown()).toBe("full.png")
      const image = view.container.querySelector("img")
      if (!image) throw new Error("Expected the picture.")
      fireEvent.error(image)
      expect(view.container.querySelector("img")).toBeNull()
      view.unmount()
    } finally {
      restore()
    }
  })

  test("are asked for when the version does not say, and read from it when it does", async () => {
    // Reproduce by starting from no pictures whatever the version holds: a version seeded from a
    // save's answer, which held none, never asks, and every board stays an outline.
    const answered = version({ home: "ready" })
    const asked = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let fetched = 0
    const query = (previewed: GetArtifactVersionResponse) => ({
      ...boardPreviewsQuery(previewed),
      queryFn: async () => {
        fetched += 1
        return { home: "pending" as const }
      },
    })

    expect(await asked.ensureQueryData(query(answered))).toEqual({ home: "ready" })
    expect(fetched).toBe(0)
    expect(await asked.ensureQueryData(query({ ...answered, version: 4 }))).toEqual({
      home: "ready",
    })
    const seeded = { ...answered, version: 5 }
    delete (seeded as { boardPreviews?: unknown }).boardPreviews
    expect(await asked.ensureQueryData(query(seeded))).toEqual({ home: "pending" })
    expect(fetched).toBe(1)
  })

  test("ask the version again while pictures are rendered, less often each time, and no longer than the server waits", () => {
    // An open version waits from its last write. Reproduce by counting from when it was opened:
    // a version opened long ago and written a minute ago asks no more.
    const published = {
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-18T12:00:00.000Z",
    }
    const at = (minutes: number) => Date.parse(published.updatedAt) + minutes * 60_000

    expect(nextPreviewCheck({ home: "pending" }, published, 0, at(1))).toBe(2_000)
    expect(nextPreviewCheck({ home: "pending" }, published, 2, at(1))).toBe(4_500)
    expect(nextPreviewCheck({ home: "pending" }, published, 20, at(1))).toBe(30_000)
    // Reproduce by dropping either stop: it asks for good.
    expect(nextPreviewCheck({ home: "ready", pay: "none" }, published, 0, at(1))).toBe(false)
    const waited = BOARD_PREVIEW_WAIT_MS / 60_000
    expect(nextPreviewCheck({ home: "pending" }, published, 3, at(waited - 1))).toBe(6_750)
    expect(nextPreviewCheck({ home: "pending" }, published, 3, at(waited))).toBe(false)
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
  const arrows = CANVAS.items.filter((item) => item.type === "arrow")
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })

  test("opens a board at its own size, scaled to fit, over its picture until its page is ready", async () => {
    // As the canvas and its picture show it: a page laid out at 390 by 400, here 1.75 times as
    // large to fit 700 pixels of height. Reproduce by laying the page out at the viewer's height
    // again: the board opens as a page as tall as the viewer, blank until it is ready.
    const view = render(
      <QueryClientProvider client={client()}>
        <BoardFocus
          version={version}
          boards={boards}
          arrows={arrows}
          id="home"
          pictureOf={(id) => `/previews/${id}.png`}
          onOpen={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    await act(async () => {})

    const page = view.container.querySelector<HTMLElement>('[style*="scale("]')
    expect(page?.style.width).toBe("390px")
    expect(page?.style.height).toBe("400px")
    expect(page?.style.transform).toBe("scale(1.75)")
    expect(page?.parentElement?.style.width).toBe("682.5px")
    expect(page?.parentElement?.style.height).toBe("700px")
    expect(page?.querySelector("img")?.getAttribute("src")).toBe("/previews/home.png")
    view.unmount()
  })

  test("steps through the boards with ← and →, and goes back with Esc", async () => {
    const opened: string[] = []
    let closed = 0
    const view = render(
      <QueryClientProvider client={client()}>
        <BoardFocus
          version={version}
          boards={boards}
          arrows={arrows}
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

  test("goes where the arrow points whose label the reader pressed in the board", async () => {
    // "Continue" leads from home to pay. Reproduce by dropping BoardFocus's onEvent: the press
    // opens nothing.
    const cache = client()
    cache.setQueryData(frameLinkKey(version), {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-10-18T13:00:00.000Z",
    })
    const opened: string[] = []
    const view = render(
      <QueryClientProvider client={cache}>
        <BoardFocus
          version={version}
          boards={boards}
          arrows={arrows}
          id="home"
          onOpen={(id) => opened.push(id)}
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    const frame = view.container.querySelector("iframe")?.contentWindow
    if (!frame) throw new Error("Expected the board's frame.")
    const press = async (text: string) => {
      await act(async () => {
        browser.dispatchEvent(
          new browser.MessageEvent("message", {
            data: { protocol: FRAME_PROTOCOL, event: "press", params: { text } },
            source: frame as never,
          })
        )
      })
    }

    await press("Save draft")
    expect(opened).toEqual([])
    await press("continue")
    expect(opened).toEqual(["pay"])
    view.unmount()
  })

  test("follows an arrow by its label, case and spaces aside, only from the board and to one", () => {
    const flow = canvasOf({
      items: [
        board("home"),
        board("pay", 520),
        board("done", 1040),
        { id: "paid", type: "shape", shape: "diamond", x: 0, y: 900, w: 160, h: 120 },
        { id: "go", type: "arrow", from: "home", to: "pay", label: "Get  started" },
        { id: "check", type: "arrow", from: "home", to: "paid", label: "Check" },
        { id: "back", type: "arrow", from: "pay", to: "home", label: "Back" },
        { id: "aside", type: "arrow", from: "home", to: { x: 0, y: 2000 }, label: "Aside" },
        { id: "again", type: "arrow", from: "home", to: "done", label: "get started" },
      ],
    })
    const arrows = flow.items.filter((item): item is CanvasArrow => item.type === "arrow")
    const boards = flow.items.filter((item): item is CanvasBoard => item.type === "board")
    const follow = (from: string, text: string) => followedArrow(arrows, boards, from, text)

    // The first the canvas lists wins.
    expect(follow("home", " GET STARTED ")).toBe("pay")
    expect(follow("pay", "back")).toBe("home")
    // An arrow from another board, to a shape, or to a point leads nowhere.
    expect(follow("pay", "Get started")).toBeNull()
    expect(follow("home", "Check")).toBeNull()
    expect(follow("home", "Aside")).toBeNull()
  })

  test("opens a board the reader double-clicks", async () => {
    // React Flow lets an item it can't select or drag take no pointer, so in a browser the
    // double-click went to the pane, which zoomed. Reproduce by dropping the board's pointer
    // style from canvasGraph: the board takes no pointer, as a note doesn't.
    const { default: CanvasBoard } = await import("../src/artifacts/renderers/canvas/canvas")
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(
        <QueryClientProvider client={client()}>
          <CanvasBoard canvas={CANVAS} version={version} title="Checkout" mode="light" />
        </QueryClientProvider>
      )
    })
    const node = (id: string) =>
      view?.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
    expect(node("home")?.style.pointerEvents).toBe("all")
    // The rest are read where they lie: a press on them reaches the pane, which pans.
    expect(node("ask")?.style.pointerEvents).toBe("none")
    expect(node("home")?.classList.contains("selectable")).toBe(false)

    const home = node("home")
    if (!home) throw new Error("Expected the board.")
    await act(async () => {
      fireEvent.doubleClick(home)
    })
    expect(view?.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Home, opened from the canvas"
    )
    view?.unmount()
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
