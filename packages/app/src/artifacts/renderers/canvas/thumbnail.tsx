import type { Canvas, CanvasItem } from "@sixb/core/artifacts"
import { TONE_COLORS } from "../../tones"
import { approximateBox, type Box, canvasExtent } from "./layout"

/**
 * A canvas drawn small, as a card previews it: boards, embeds, notes, and shapes as their shapes in
 * the theme's colors, texts and sections' headings as lines, arrows between what they join. Plain
 * SVG, so a card never loads the board.
 */
export function CanvasThumbnail({ canvas }: { readonly canvas: Canvas }) {
  const extent = canvasExtent(canvas)
  // A margin around everything, a twentieth of the larger side.
  const margin = Math.max(extent.width, extent.height) / 20
  const view = {
    x: extent.x - margin,
    y: extent.y - margin,
    width: extent.width + margin * 2,
    height: extent.height + margin * 2,
  }
  const boxes = new Map(
    canvas.items.flatMap((item): [string, Box][] => {
      const box = approximateBox(item)
      return box ? [[item.id, box]] : []
    })
  )
  const stroke = Math.max(view.width, view.height) / 400
  return (
    <svg
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 size-full bg-background"
      aria-hidden="true"
    >
      {canvas.items.map((item) => (
        <Shape key={item.id} item={item} boxes={boxes} stroke={stroke} />
      ))}
    </svg>
  )
}

function Shape({
  item,
  boxes,
  stroke,
}: {
  readonly item: CanvasItem
  readonly boxes: ReadonlyMap<string, Box>
  readonly stroke: number
}) {
  const box = boxes.get(item.id)
  const line = "color-mix(in oklab, var(--foreground) 30%, transparent)"
  switch (item.type) {
    case "arrow": {
      const center = (end: typeof item.from) => {
        if (typeof end !== "string") return end
        const target = boxes.get(end)
        return target ? { x: target.x + target.width / 2, y: target.y + target.height / 2 } : null
      }
      const from = center(item.from)
      const to = center(item.to)
      return from && to ? (
        <line
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          style={{ stroke: line }}
          strokeWidth={stroke * 1.5}
          strokeDasharray={item.dashed ? `${stroke * 4} ${stroke * 4}` : undefined}
        />
      ) : null
    }
    case "section": {
      // A heading, as the board draws it: a line of its title's length at the top left.
      const height = stroke * 7
      return box && item.title ? (
        <rect
          x={box.x}
          y={box.y}
          width={Math.min(box.width, item.title.length * height * 0.55)}
          height={height}
          rx={height / 2}
          style={{ fill: "color-mix(in oklab, var(--foreground) 55%, transparent)" }}
        />
      ) : null
    }
    case "board":
    case "embed":
      return box ? (
        <rect
          {...rect(box)}
          rx={stroke * 2}
          style={{
            fill: "var(--card)",
            stroke: "color-mix(in oklab, var(--foreground) 14%, transparent)",
          }}
          strokeWidth={stroke}
        />
      ) : null
    case "note":
      // A neutral note is plain paper, edged as a board is.
      return box ? (
        <rect
          {...rect(box)}
          rx={stroke * 3}
          style={
            item.tone === "neutral"
              ? {
                  fill: "var(--card)",
                  stroke: "color-mix(in oklab, var(--foreground) 14%, transparent)",
                }
              : {
                  fill: `color-mix(in oklab, ${TONE_COLORS[item.tone ?? "warning"]} 32%, var(--card))`,
                }
          }
          strokeWidth={item.tone === "neutral" ? stroke : undefined}
        />
      ) : null
    case "shape":
      return box ? (
        <rect
          {...rect(box)}
          rx={item.shape === "rect" ? stroke * 6 : Math.min(box.width, box.height) / 2}
          style={{ fill: "var(--card)", stroke: line }}
          strokeWidth={stroke * 1.2}
        />
      ) : null
    case "text":
      return box ? (
        <rect
          x={box.x}
          y={box.y + box.height * 0.2}
          width={box.width}
          height={box.height * 0.6}
          rx={box.height * 0.3}
          style={{ fill: "color-mix(in oklab, var(--foreground) 55%, transparent)" }}
        />
      ) : null
  }
}

function rect(box: Box) {
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}
