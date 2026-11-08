import { ARTIFACT_LIMITS, type CanvasBox, canvasArrowLine } from "@sixb/core/artifacts"
import {
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
  useInternalNode,
} from "@xyflow/react"
import { memo } from "react"
import { NAME_SCALE_VALUE, useNamesShown } from "./items"
import type { CanvasFlowEdge } from "./layout"

export const CANVAS_EDGE_TYPES: EdgeTypes = { floating: memo(FloatingArrow) }

const HEAD_LENGTH = 13
const HEAD_WIDTH = 11
/**
 * Where labels stack: over the arrows, which sit over every item a canvas can hold. React Flow
 * draws the labels in a layer of their own, under the arrows unless raised.
 */
const LABEL_LAYER = ARTIFACT_LIMITS.maxCanvasItems + 1
/** The most of its arrow a label covers, so the line still shows on both sides of it. */
const LABEL_SHARE = 0.7

function rectOf(node: InternalNode): CanvasBox {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  }
}

/**
 * An arrow between two items, straight from the side of one that faces the other, its head drawn
 * in the theme's color, dashed when the canvas says so, and its label on the line, kept readable
 * as names are.
 */
function FloatingArrow({ id, source, target, data, selected }: EdgeProps<CanvasFlowEdge>) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  const shown = useNamesShown()
  if (!from || !to) return null
  const a = rectOf(from)
  const b = rectOf(to)
  const { start, end } = canvasArrowLine(a, b)
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
  const labelScale = `min(${NAME_SCALE_VALUE}, ${Math.max(1, room)})`
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
      {data?.label && shown ? (
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
