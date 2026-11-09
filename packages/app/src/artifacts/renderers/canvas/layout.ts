import type { Canvas, CanvasArrow, CanvasEnd, CanvasItem, CanvasNote } from "@sixb/core/artifacts"
import { ARTIFACT_LIMITS, CANVAS_TEXT_PIXELS, canvasNoteFontSize } from "@sixb/core/artifacts"
import type { Edge, Node } from "@xyflow/react"

/** What a node on the board draws: one of the canvas's items, or an arrow's end at a point. */
export type CanvasNodeData =
  | { readonly item: Exclude<CanvasItem, CanvasArrow> }
  | { readonly item: null }

/** What an arrow draws besides its ends. */
export interface CanvasEdgeData extends Record<string, unknown> {
  readonly label?: string
  readonly dashed: boolean
}

export type CanvasFlowNode = Node<CanvasNodeData & Record<string, unknown>>
export type CanvasFlowEdge = Edge<CanvasEdgeData>

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Over every item: an arrow to a point on a board shows on it. */
const ARROW_Z_INDEX = ARTIFACT_LIMITS.maxCanvasItems + 1

/** What an item drew as, at the place it had in the canvas's order. */
interface Drawn {
  readonly order: number
  readonly nodes: readonly CanvasFlowNode[]
  readonly edges: readonly CanvasFlowEdge[]
}

const drawn = new WeakMap<CanvasItem, Drawn>()

/**
 * The canvas as React Flow's nodes and edges. Each item is a node of its type at its place and
 * size; a note and a text without a width are measured once drawn. Sections draw
 * behind everything, the rest in the order the canvas lists them. An arrow is an edge between two
 * items, drawn over them all, and its end at a bare point is an invisible node there.
 *
 * An item that is the same object as before, at the same place in the order, draws as the same
 * nodes and edge: React Flow draws again only what changed.
 */
export function canvasGraph(canvas: Canvas): {
  readonly nodes: CanvasFlowNode[]
  readonly edges: CanvasFlowEdge[]
} {
  const nodes: CanvasFlowNode[] = []
  const edges: CanvasFlowEdge[] = []
  canvas.items.forEach((item, order) => {
    let entry = drawn.get(item)
    if (!entry || entry.order !== order) {
      entry = { order, ...itemGraph(item, order) }
      drawn.set(item, entry)
    }
    nodes.push(...entry.nodes)
    edges.push(...entry.edges)
  })
  return { nodes, edges }
}

/** One item's nodes and edges. */
function itemGraph(
  item: CanvasItem,
  order: number
): { readonly nodes: CanvasFlowNode[]; readonly edges: CanvasFlowEdge[] } {
  const nodes: CanvasFlowNode[] = []
  const edges: CanvasFlowEdge[] = []
  if (item.type === "arrow") {
    const end = (side: "from" | "to", value: CanvasEnd) => {
      if (typeof value === "string") return value
      const id = `${item.id}:${side}`
      nodes.push({
        id,
        type: "point",
        position: { x: value.x, y: value.y },
        width: 1,
        height: 1,
        data: { item: null },
        selectable: false,
        focusable: false,
      })
      return id
    }
    edges.push({
      id: item.id,
      type: "floating",
      source: end("from", item.from),
      target: end("to", item.to),
      data: { ...(item.label ? { label: item.label } : {}), dashed: item.dashed },
      zIndex: ARROW_Z_INDEX,
      focusable: false,
      selectable: false,
    })
    return { nodes, edges }
  }
  // A note grows to hold its text, its height only the least it takes: it is measured.
  const height = "h" in item && item.type !== "note" ? item.h : undefined
  const width = "w" in item ? item.w : undefined
  nodes.push({
    id: item.id,
    type: item.type,
    position: { x: item.x, y: item.y },
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    data: { item },
    zIndex: item.type === "section" ? -1 : order,
    draggable: false,
    connectable: false,
    selectable: false,
    // Boards are the items a reader opens; the rest are read where they lie. React Flow lets an
    // item it can't select or drag take no pointer, so a board takes it back: a double-click
    // reaches it, and a drag across it still pans.
    focusable: item.type === "board",
    ...(item.type === "board" ? { style: { pointerEvents: "all" } } : {}),
  })
  return { nodes, edges }
}

/**
 * The extent of every item with a size, for a picture of the whole canvas. Notes without a
 * height count as tall as their words, and texts as a line of their size, near enough for a
 * thumbnail.
 */
export function canvasExtent(canvas: Canvas): Box {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const item of canvas.items) {
    const box = approximateBox(item)
    if (!box) continue
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return left <= right
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: 0, y: 0, width: 1, height: 1 }
}

/** An item's box as a thumbnail draws it, before anything is measured. */
export function approximateBox(item: CanvasItem): Box | null {
  switch (item.type) {
    case "arrow":
      return null
    case "text": {
      const size = CANVAS_TEXT_PIXELS[item.size]
      return {
        x: item.x,
        y: item.y,
        width: item.w ?? Math.min(item.text.length * size * 0.55, 1600),
        height: size * 1.3,
      }
    }
    case "note":
      return { x: item.x, y: item.y, width: item.w, height: item.h ?? noteHeight(item) }
    default:
      return { x: item.x, y: item.y, width: item.w, height: item.h }
  }
}

/** Roughly how wide a character of a note's words is, against its type's size. */
const NOTE_CHARACTER_WIDTH = 0.55

/**
 * How tall a note without a height draws: as many lines as its words take at its width, inside
 * its padding, and never shorter than the least a note is. A thumbnail can't measure it.
 */
function noteHeight(note: CanvasNote): number {
  const size = canvasNoteFontSize(note.w)

  // The note's own padding: 1em on each side, 0.85em above and below.
  const perLine = Math.max(1, Math.floor((note.w - size * 2) / (size * NOTE_CHARACTER_WIDTH)))
  const lines = note.text
    .split("\n")
    .reduce((count, paragraph) => count + Math.max(1, Math.ceil(paragraph.length / perLine)), 0)

  return Math.max(Math.min(note.w, 112), lines * size * 1.4 + size * 1.7)
}
