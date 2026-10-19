import { describe, expect, test } from "bun:test"
import { type Canvas, parseCanvas } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { Suspense } from "react"
import { type ArtifactDraft, EditSessionProvider } from "../src/artifacts/edit-session"
import { recordChange, redoChange, startHistory, undoChange } from "../src/artifacts/history"
import {
  addItem,
  canvasFiles,
  connectItems,
  duplicateItems,
  formatCanvas,
  moveItems,
  removeItems,
  resizeItem,
  setItemText,
  styleItems,
} from "../src/artifacts/renderers/canvas/draft"
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
  "KeyboardEvent",
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
    { id: "flow", type: "section", x: 0, y: -120, w: 1000, h: 600, title: "Flow" },
    { id: "home", type: "board", file: "boards/home.html", x: 0, y: 0, w: 390, h: 400 },
    { id: "pay", type: "board", file: "boards/pay.html", x: 630, y: 0, w: 390, h: 400 },
    { id: "next", type: "arrow", from: "home", to: "pay", label: "Continue" },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, text: "Annual first?" },
    { id: "title", type: "text", x: 0, y: -260, text: "Checkout", size: "xl" },
  ],
})

/** The canvas as saved, read back: what a save publishes must publish. */
function saved(canvas: Canvas): Canvas {
  return canvasOf(JSON.parse(formatCanvas(canvas)))
}

const ids = (canvas: Canvas) => canvas.items.map((item) => item.id)

describe("arranging a canvas", () => {
  test("moves and resizes items in whole pixels, a text by its width alone", () => {
    const moved = moveItems(new Map([["ask", { x: 400.4, y: 600 }]]))(CANVAS)
    expect(moved.items.find((item) => item.id === "ask")).toMatchObject({ x: 400, y: 600 })
    // A position an item already has changes nothing.
    expect(moveItems(new Map([["ask", { x: 0, y: 560 }]]))(CANVAS)).toBe(CANVAS)
    const resized = resizeItem("title", { x: 0, y: -260, w: 480.6, h: 300 })(CANVAS)
    expect(resized.items.find((item) => item.id === "title")).toEqual({
      id: "title",
      type: "text",
      x: 0,
      y: -260,
      text: "Checkout",
      size: "xl",
      w: 481,
    })
    // Never smaller than an item may be.
    const tiny = resizeItem("home", { x: 0, y: 0, w: 4, h: 4 })(CANVAS)
    expect(tiny.items.find((item) => item.id === "home")).toMatchObject({ w: 40, h: 40 })
    expect(saved(resized)).toEqual(resized)
  })

  test("adds items under free ids, and connects them", () => {
    const note = addItem("note", { x: 100, y: 700 }, "")
    expect(note.id(CANVAS)).toBe("note")
    const added = note.change(CANVAS)
    const typed = setItemText("note", "Ship it")(added)
    const linked = connectItems("note", "ask")(typed)
    expect(linked.items.at(-1)).toEqual({
      id: "arrow",
      type: "arrow",
      from: "note",
      to: "ask",
      dashed: false,
    })
    // An arrow already there, or from an item to itself, is no change.
    expect(connectItems("note", "ask")(linked)).toBe(linked)
    expect(connectItems("note", "note")(linked)).toBe(linked)
    expect(addItem("note", { x: 0, y: 0 }, "").id(linked)).toBe("note-2")
    expect(saved(linked)).toEqual(linked)
  })

  test("throws away a note left empty, and drops a shape's text to none", () => {
    const empty = setItemText("ask", "  ")(CANVAS)
    expect(ids(empty)).not.toContain("ask")
    const shaped = addItem("shape", { x: 0, y: 0 }, "Paid?").change(CANVAS)
    const blank = setItemText("shape", "")(shaped)
    expect(blank.items.find((item) => item.id === "shape")).not.toHaveProperty("text")
  })

  test("removes items with the arrows they hold up, and copies a flow with its arrows", () => {
    const removed = removeItems(new Set(["pay"]))(CANVAS)
    expect(ids(removed)).toEqual(["flow", "home", "ask", "title"])
    const copies = duplicateItems(new Set(["home", "pay"]))
    expect(copies.copies(CANVAS)).toEqual(["home-2", "pay-2"])
    const copied = copies.change(CANVAS)
    expect(copied.items.slice(-3)).toEqual([
      expect.objectContaining({ id: "home-2", x: 32, y: 32 }),
      expect.objectContaining({ id: "pay-2", x: 662, y: 32 }),
      expect.objectContaining({ id: "next-2", from: "home-2", to: "pay-2" }),
    ])
    expect(saved(copied)).toEqual(copied)
  })

  test("styles what takes a style, and leaves the rest", () => {
    const styled = styleItems(new Set(["ask", "title", "next"]), {
      tone: "positive",
      size: "l",
      dashed: true,
      label: "Then",
    })(CANVAS)
    expect(styled.items.find((item) => item.id === "ask")).toMatchObject({ tone: "positive" })
    expect(styled.items.find((item) => item.id === "title")).toMatchObject({ size: "l" })
    expect(styled.items.find((item) => item.id === "next")).toMatchObject({
      dashed: true,
      label: "Then",
    })
    // A note's default tone is none, not amber written out.
    const plain = styleItems(new Set(["ask"]), { tone: null })(styled)
    expect(plain.items.find((item) => item.id === "ask")).not.toHaveProperty("tone")
  })

  test("undoes and redoes each change, and saves only the canvas and the boards it drops", () => {
    let history = startHistory(CANVAS)
    history = recordChange(
      history,
      moveItems(new Map([["ask", { x: 80, y: 600 }]]))(history.present)
    )
    history = recordChange(history, removeItems(new Set(["pay"]))(history.present))
    expect(ids(history.present)).not.toContain("pay")
    history = undoChange(history)
    expect(ids(history.present)).toContain("pay")
    history = undoChange(history)
    expect(history.present).toBe(CANVAS)
    history = redoChange(redoChange(history))
    // The boards' files are the version's, carried over; one no board shows any more is dropped.
    const files = canvasFiles(CANVAS, history.present)
    expect([...files.keys()]).toEqual(["canvas.json", "boards/pay.html"])
    expect(files.get("boards/pay.html")).toBeNull()
    expect(canvasOf(JSON.parse(files.get("canvas.json") ?? ""))).toEqual(history.present)
    // Written as an author writes it: no defaults.
    expect(files.get("canvas.json")).not.toContain('"dashed": false')
    expect(files.get("canvas.json")).not.toContain('"size": "m"')
  })
})

describe("a canvas in the viewer, edited", () => {
  test("reports its draft to the header: what changed, and what a save publishes", async () => {
    const { CanvasRenderer } = await import("../src/artifacts/renderers/canvas/renderer")
    const { artifactFileSource } = await import("../src/artifacts/file-source")
    const queries = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
    })
    const file = {
      blobId: "blob_canvas",
      digest: `sha256:${"0".repeat(64)}` as const,
      sizeBytes: 10,
      mediaType: "application/json",
    }
    const version = {
      artifactId: "art_c4nv4s0000",
      version: 1,
      title: "Checkout",
      entry: "canvas.json",
      files: [{ path: "canvas.json", file }],
      outline: { kind: "canvas", items: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-18T12:00:00.000Z",
    } as never
    const source = artifactFileSource({
      artifactId: "art_c4nv4s0000",
      version: 1,
      path: "canvas.json",
      fileRef: file,
    })
    queries.setQueryData([...source.queryKey, "text"], formatCanvas(CANVAS))
    let draft: ArtifactDraft | null = null
    const view = render(
      <QueryClientProvider client={queries}>
        <EditSessionProvider editing report={(next) => (draft = next)}>
          <Suspense fallback={null}>
            <CanvasRenderer version={version} />
          </Suspense>
        </EditSessionProvider>
      </QueryClientProvider>
    )
    // The board's code loads apart, as the viewer loads it.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50))
    })
    const board = view.getByRole("region")
    expect(view.getByRole("toolbar").getAttribute("aria-label")).toBe("Canvas tools")
    expect((draft as ArtifactDraft | null)?.changed).toBe(false)
    // Select everything, delete it, and the draft holds an empty canvas to save.
    await act(async () => {
      fireEvent.keyDown(board, { key: "a", metaKey: true })
    })
    await act(async () => {
      fireEvent.keyDown(board, { key: "Delete" })
    })
    const reported = draft as ArtifactDraft | null
    expect(reported?.changed).toBe(true)
    expect(reported?.files().get("canvas.json")).toBe(`${JSON.stringify({ items: [] }, null, 2)}\n`)
    // ⌘Z takes the delete back: nothing left to save.
    await act(async () => {
      fireEvent.keyDown(board, { key: "z", metaKey: true })
    })
    expect((draft as ArtifactDraft | null)?.changed).toBe(false)
    view.unmount()
  })
})
