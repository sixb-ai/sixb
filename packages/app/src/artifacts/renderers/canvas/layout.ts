import type { Canvas, CanvasArrow, CanvasEnd, CanvasItem } from "@sixb/core/artifacts"
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

/**
 * The canvas as React Flow's nodes and edges. Each item is a node of its type at its place and
 * size; a note and a text without a width are measured once drawn. Sections draw
 * behind everything, the rest in the order the canvas lists them. An arrow is an edge between two
 * items, drawn over them all, and its end at a bare point is an invisible node there.
 */
export function canvasGraph(canvas: Canvas): {
  readonly nodes: CanvasFlowNode[]
  readonly edges: CanvasFlowEdge[]
} {
  const nodes: CanvasFlowNode[] = []
  const edges: CanvasFlowEdge[] = []
  canvas.items.forEach((item, order) => {
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
        // Over every item: an arrow to a point on a board shows on it.
        zIndex: canvas.items.length,
        focusable: false,
        selectable: false,
      })
      return
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
      // Boards are the items a reader opens; the rest are read where they lie.
      focusable: item.type === "board",
    })
  })
  return { nodes, edges }
}

/**
 * The extent of every item with a size, for a picture of the whole canvas. Notes without a
 * height count as square, and texts as a line of their size, near enough for a thumbnail.
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

/** The size a text of each size draws at, in pixels. */
export const TEXT_SIZES = { s: 14, m: 18, l: 28, xl: 44 } as const

/** An item's box as a thumbnail draws it, before anything is measured. */
export function approximateBox(item: CanvasItem): Box | null {
  switch (item.type) {
    case "arrow":
      return null
    case "text": {
      const size = TEXT_SIZES[item.size]
      return {
        x: item.x,
        y: item.y,
        width: item.w ?? Math.min(item.text.length * size * 0.55, 1600),
        height: size * 1.3,
      }
    }
    case "note":
      return { x: item.x, y: item.y, width: item.w, height: item.h ?? item.w }
    default:
      return { x: item.x, y: item.y, width: item.w, height: item.h }
  }
}
