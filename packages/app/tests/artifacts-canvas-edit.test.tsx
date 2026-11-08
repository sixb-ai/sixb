import { describe, expect, test } from "bun:test"
import { ARTIFACT_LIMITS, type Canvas, formatCanvas, parseCanvas } from "@sixb/core/artifacts"
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
  moveItems,
  newItemId,
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

describe("saving a canvas", () => {
  test("keeps every text size as it reads it, xxl among them", () => {
    // Reproduce by leaving xxl out of the sizes parseCanvas takes: the saved canvas is refused.
    const sized = canvasOf({
      items: (["s", "m", "l", "xl", "xxl"] as const).map((size, index) => ({
        id: `t-${size}`,
        type: "text",
        x: 0,
        y: index * 200,
        text: size,
        size,
      })),
    })

    expect(
      JSON.parse(formatCanvas(sized)).items.map((item: { size?: string }) => item.size)
    ).toEqual(["s", undefined, "l", "xl", "xxl"])
    expect(saved(sized)).toEqual(sized)
  })
})

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

  test("adds items under ids nobody else adding at once picks, and connects them", () => {
    // Two people editing live add their notes at once: each gets an id of its own. Reproduce by
    // naming items by the next free number, as the draft did: both are `note`, and one is lost.
    const note = addItem("note", { x: 100, y: 700 }, "")
    expect(note.id).toMatch(/^note-[a-z0-9]{6}$/)
    expect(addItem("note", { x: 100, y: 700 }, "").id).not.toBe(note.id)
    const added = note.change(CANVAS)
    const typed = setItemText(note.id, "Ship it")(added)
    const linked = connectItems(note.id, "ask")(typed)
    expect(linked.items.at(-1)).toEqual({
      id: expect.stringMatching(/^arrow-[a-z0-9]{6}$/),
      type: "arrow",
      from: note.id,
      to: "ask",
      dashed: false,
    })
    // An arrow already there, or from an item to itself, is no change.
    expect(connectItems(note.id, "ask")(linked)).toBe(linked)
    expect(connectItems(note.id, note.id)(linked)).toBe(linked)
    expect(saved(linked)).toEqual(linked)
  })

  test("names a copy after what it copies, within the ids canvas.json takes", () => {
    expect(newItemId("home")).toMatch(/^home-[a-z0-9]{6}$/)
    // A copy of a copy drops the suffix its original was given, not a word of the id.
    expect(newItemId("note-k3m9q2")).toMatch(/^note-[a-z0-9]{6}$/)
    expect(newItemId("home-screen")).toMatch(/^home-screen-[a-z0-9]{6}$/)
    expect(newItemId("x".repeat(40))).toHaveLength(40)
  })

  test("throws away a note left empty, and drops a shape's text to none", () => {
    const empty = setItemText("ask", "  ")(CANVAS)
    expect(ids(empty)).not.toContain("ask")
    const shape = addItem("shape", { x: 0, y: 0 }, "Paid?")
    const blank = setItemText(shape.id, "")(shape.change(CANVAS))
    expect(blank.items.find((item) => item.id === shape.id)).not.toHaveProperty("text")
  })

  test("removes items with the arrows they hold up, and copies a flow with its arrows", () => {
    const removed = removeItems(new Set(["pay"]))(CANVAS)
    expect(ids(removed)).toEqual(["flow", "home", "ask", "title"])
    const copies = duplicateItems(new Set(["home", "pay"]))
    const [home, pay] = copies.copies(CANVAS)
    expect(home).toMatch(/^home-[a-z0-9]{6}$/)
    expect(pay).toMatch(/^pay-[a-z0-9]{6}$/)
    const copied = copies.change(CANVAS)
    expect(copied.items.slice(-3)).toEqual([
      expect.objectContaining({ id: home, x: 32, y: 32 }),
      expect.objectContaining({ id: pay, x: 662, y: 32 }),
      expect.objectContaining({ id: expect.stringMatching(/^next-/), from: home, to: pay }),
    ])
    // The copies it names are the ones it makes, however often it is asked.
    expect(copies.copies(CANVAS)).toEqual([home as string, pay as string])
    expect(saved(copied)).toEqual(copied)
  })

  test("keeps what publishing requires: one item at least, and words within its limits", () => {
    // Reproduce by removing and storing as asked: the canvas saves with no items, or a label of
    // 150 characters, and publishing refuses both.
    const all = new Set(ids(CANVAS))
    expect(removeItems(all)(CANVAS)).toBe(CANVAS)
    const lone = canvasOf({ items: [{ id: "ask", type: "note", x: 0, y: 0, w: 260, text: "Hi" }] })
    expect(setItemText("ask", "")(lone)).toBe(lone)

    const long = "x".repeat(ARTIFACT_LIMITS.maxCanvasTextLength + 50)
    const typed = setItemText("ask", long)(CANVAS)
    const titled = setItemText("flow", long)(typed)
    const labelled = setItemText("next", long)(titled)
    const item = (id: string) => labelled.items.find((entry) => entry.id === id)
    expect(item("ask")).toMatchObject({ text: "x".repeat(ARTIFACT_LIMITS.maxCanvasTextLength) })
    expect(item("flow")).toMatchObject({ title: "x".repeat(ARTIFACT_LIMITS.maxCanvasLabelLength) })
    expect(item("next")).toMatchObject({ label: "x".repeat(ARTIFACT_LIMITS.maxCanvasLabelLength) })
    expect(saved(labelled)).toEqual(labelled)
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
    // Select everything, copy it, and the draft holds the copies to save.
    await act(async () => {
      fireEvent.keyDown(board, { key: "a", metaKey: true })
    })
    await act(async () => {
      fireEvent.keyDown(board, { key: "d", metaKey: true })
    })
    const reported = draft as ArtifactDraft | null
    expect(reported?.changed).toBe(true)
    // Each item copied, and the arrow between the two boards copied.
    const copied = canvasOf(JSON.parse(reported?.files().get("canvas.json") ?? ""))
    expect(copied.items).toHaveLength(CANVAS.items.length * 2)
    // ⌘Z takes the copies back: nothing left to save.
    await act(async () => {
      fireEvent.keyDown(board, { key: "z", metaKey: true })
    })
    expect((draft as ArtifactDraft | null)?.changed).toBe(false)
    // Deleting everything is refused: a canvas publishes with one item at least.
    await act(async () => {
      fireEvent.keyDown(board, { key: "a", metaKey: true })
    })
    await act(async () => {
      fireEvent.keyDown(board, { key: "Delete" })
    })
    expect((draft as ArtifactDraft | null)?.changed).toBe(false)
    view.unmount()
  })
})
