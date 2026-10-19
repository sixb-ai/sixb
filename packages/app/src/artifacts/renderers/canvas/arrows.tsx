import {
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
  useInternalNode,
} from "@xyflow/react"
import { useNameScale } from "./items"
import type { CanvasFlowEdge } from "./layout"

export const CANVAS_EDGE_TYPES: EdgeTypes = { floating: FloatingArrow }

/** Room between an item's edge and the arrow that leaves or meets it. */
const GAP = 10
const HEAD_LENGTH = 13
const HEAD_WIDTH = 11
/**
 * Where labels stack: over the arrows, which sit over every item, of which a canvas holds at most
 * 500. React Flow draws the labels in a layer of their own, under the arrows unless raised.
 */
const LABEL_LAYER = 1000
/** The most of its arrow a label covers, so the line still shows on both sides of it. */
const LABEL_SHARE = 0.7

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function rectOf(node: InternalNode): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  }
}

/**
 * Where the line from a rectangle's center toward a point leaves the rectangle, plus a gap; the
 * center itself for a point, which has no size.
 */
export function exitPoint(rect: Rect, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if ((dx === 0 && dy === 0) || rect.width <= 1) return { x: cx, y: cy }
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(dy)
  )
  const length = Math.hypot(dx, dy)
  const reach = scale * length + GAP
  return { x: cx + (dx / length) * reach, y: cy + (dy / length) * reach }
}

/**
 * An arrow between two items, straight from the side of one that faces the other, its head drawn
 * in the theme's color, dashed when the canvas says so, and its label on the line, kept readable
 * as names are.
 */
function FloatingArrow({ id, source, target, data, selected }: EdgeProps<CanvasFlowEdge>) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  const scale = useNameScale()
  if (!from || !to) return null
  const a = rectOf(from)
  const b = rectOf(to)
  const start = exitPoint(a, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const end = exitPoint(b, { x: a.x + a.width / 2, y: a.y + a.height / 2 })
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  // The line stops where the head begins, so a thick line doesn't poke through its point.
  const stem = {
    x: end.x - Math.cos(angle) * (HEAD_LENGTH - 1),
    y: end.y - Math.sin(angle) * (HEAD_LENGTH - 1),
  }
  const side = (sign: number) => ({
    x: end.x - Math.cos(angle) * HEAD_LENGTH + Math.sin(angle) * (HEAD_WIDTH / 2) * sign,
    y: end.y - Math.sin(angle) * HEAD_LENGTH - Math.cos(angle) * (HEAD_WIDTH / 2) * sign,
  })
  const left = side(1)
  const right = side(-1)
  // A label keeps its size on screen as names do, as far as its arrow has room: a short arrow's
  // label shrinks with the canvas. Its width is reckoned from its letters: 12px type, padded.
  const room =
    (LABEL_SHARE * Math.hypot(end.x - start.x, end.y - start.y)) /
    ((data?.label?.length ?? 0) * 6.6 + 24)
  const labelScale = scale === null ? null : Math.min(scale, Math.max(1, room))
  const color = selected
    ? "var(--primary)"
    : "color-mix(in oklab, var(--foreground) 62%, transparent)"
  return (
    <>
      {/* A wide line no one sees, so an arrow is easy to press while the canvas is edited. */}
      <path
        d={`M${start.x},${start.y} L${end.x},${end.y}`}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="react-flow__edge-interaction"
      />
      <path
        id={id}
        d={`M${start.x},${start.y} L${stem.x},${stem.y}`}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={data?.dashed ? "7 7" : undefined}
      />
      <path
        d={`M${end.x},${end.y} L${left.x},${left.y} L${right.x},${right.y} Z`}
        style={{ fill: color }}
        strokeLinejoin="round"
      />
      {data?.label && labelScale ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute rounded-full border border-border bg-background px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-foreground shadow-sm"
            style={{
              zIndex: LABEL_LAYER,
              transform: `translate(${(start.x + end.x) / 2}px, ${(start.y + end.y) / 2}px) translate(-50%, -50%) scale(${labelScale})`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
