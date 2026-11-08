import {
  CANVAS_FIT_PADDING,
  CANVAS_TEXT_PIXELS,
  type Canvas,
  type CanvasEnd,
  type CanvasItem,
  canvasNoteFontSize,
  canvasShapeFontSize,
} from "@sixb/core/artifacts"

// The whole canvas as the app opens it, for the Agent to judge what reads at that zoom: fitted to
// everything in a laptop's window, with the boards as the check pictured them and every other item
// drawn at the app's sizes. It is an approximation: the app measures notes and texts once drawn,
// and these are reckoned from their words.

/** The window the canvas opens in: a laptop's. */
export const OVERVIEW_VIEWPORT = { width: 1440, height: 900 } as const

/** The canvas opens no closer than its actual size, and no further than this. */
const MAX_ZOOM = 1
const MIN_ZOOM = 0.04
/** An item's name shows above it from this zoom, at most this much larger, on so wide an item. */
const NAMES_FROM_ZOOM = 0.35
const MAX_NAME_SCALE = 2
const NAMED_FROM_WIDTH = 120

/** Colors a tone names that the frame's themes do not hold. */
const TONES: Readonly<Record<string, string>> = {
  neutral: "var(--muted-foreground)",
  positive: "#16a34a",
  warning: "#f59e0b",
  negative: "#dc2626",
}

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The page the check screenshots as `overview.png`: the canvas fitted to the viewport as the
 * app's opening fit does, in the theme's tokens, each board its picture at `image(id)`.
 */
export function canvasOverviewHtml(input: {
  readonly canvas: Canvas
  readonly tokens: Readonly<Record<string, string>>
  /** Where each board's picture is, relative to the page. */
  readonly image: (boardId: string) => string
}): string {
  const { canvas, tokens } = input
  const boxes = new Map(
    canvas.items.flatMap((item) => {
      const box = itemBox(item)
      return box ? [[item.id, box] as const] : []
    })
  )

  const view = fitView([...boxes.values(), ...pointEnds(canvas)])
  const nameScale =
    view.zoom >= NAMES_FROM_ZOOM ? Math.min(MAX_NAME_SCALE, Math.max(1, 1 / view.zoom)) : null

  // Sections behind everything, then the rest in the canvas's order, arrows over them all.
  const items = [
    ...canvas.items.filter((item) => item.type === "section"),
    ...canvas.items.filter((item) => item.type !== "section" && item.type !== "arrow"),
  ]
  const drawn = items
    .map((item) => drawItem(item, boxes.get(item.id), { ...input, zoom: view.zoom, nameScale }))
    .join("\n")

  const style = Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ")

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root { ${style} }
* { box-sizing: border-box; }
html, body { margin: 0; width: ${OVERVIEW_VIEWPORT.width}px; height: ${OVERVIEW_VIEWPORT.height}px; overflow: hidden; }
body { background: var(--background); color: var(--foreground); font-family: var(--font-sans, system-ui, sans-serif); }
.canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: translate(${view.x}px, ${view.y}px) scale(${view.zoom}); }
.item { position: absolute; }
.surface { border-radius: 6px; background: var(--card); overflow: hidden; box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 9%, transparent), 0 1px 2px rgb(0 0 0 / 0.05), 0 20px 44px -28px rgb(0 0 0 / 0.35); }
.surface img { display: block; width: 100%; }
.name { position: absolute; left: 0; bottom: 100%; height: 28px; padding-bottom: 6px; display: flex; align-items: center; transform-origin: bottom left; font-size: 13px; font-weight: 500; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.heading { position: absolute; left: 0; top: 0; margin: 0; transform-origin: top left; font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { border-radius: 4px; padding: 0.85em 1em; line-height: 1.4; font-weight: 500; white-space: pre-wrap; box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 10px 24px -14px rgb(0 0 0 / 0.28); }
.text { white-space: pre-wrap; }
.shape { display: flex; align-items: center; justify-content: center; }
.shape svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.shape span { position: relative; text-align: center; line-height: 1.375; font-weight: 500; }
.arrows { position: absolute; left: 0; top: 0; overflow: visible; }
.label { position: absolute; transform: translate(-50%, -50%); border-radius: 999px; border: 1px solid var(--border); background: var(--background); padding: 2px 10px; font-size: 12px; font-weight: 500; white-space: nowrap; }
</style></head>
<body><div class="canvas">
${drawn}
${drawArrows(canvas, boxes)}
</div></body></html>
`
}

/** Where the canvas sits in the window, as the app's fit puts it: centered, with its margin. */
function fitView(boxes: readonly Box[]): { x: number; y: number; zoom: number } {
  const bounds = union(boxes)
  const { width, height } = OVERVIEW_VIEWPORT
  const zoom = clamp(
    Math.min(
      width / (bounds.width * (1 + CANVAS_FIT_PADDING)),
      height / (bounds.height * (1 + CANVAS_FIT_PADDING))
    ),
    MIN_ZOOM,
    MAX_ZOOM
  )

  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  }
}

/** An item's box before anything is measured: a note's height and a text's width are reckoned. */
function itemBox(item: CanvasItem): Box | null {
  switch (item.type) {
    case "arrow":
      return null
    case "text": {
      const size = CANVAS_TEXT_PIXELS[item.size]
      const width = item.w ?? Math.min(longestLine(item.text) * size * 0.55, 1600)
      const lineHeight = size * (item.size === "xl" || item.size === "l" ? 1.15 : 1.45)
      return { x: item.x, y: item.y, width, height: lineHeight * lines(item.text, width, size) }
    }
    case "note": {
      const size = canvasNoteFontSize(item.w)
      const padding = size * 1.7
      const written = size * 1.4 * lines(item.text, item.w - size * 2, size) + padding
      const height = item.h ?? Math.max(Math.min(item.w, 112), written)
      return { x: item.x, y: item.y, width: item.w, height }
    }
    default:
      return { x: item.x, y: item.y, width: item.w, height: item.h }
  }
}

/** The ends of arrows at a bare point, which the app's fit counts as one pixel there. */
function pointEnds(canvas: Canvas): Box[] {
  return canvas.items.flatMap((item) =>
    item.type === "arrow"
      ? [item.from, item.to].flatMap((end) =>
          typeof end === "string" ? [] : [{ x: end.x, y: end.y, width: 1, height: 1 }]
        )
      : []
  )
}

function drawItem(
  item: CanvasItem,
  box: Box | undefined,
  context: {
    readonly image: (boardId: string) => string
    readonly zoom: number
    readonly nameScale: number | null
  }
): string {
  if (!box) return ""
  const place = `left: ${box.x}px; top: ${box.y}px; width: ${box.width}px; height: ${box.height}px;`
  const named = (width: number) =>
    context.nameScale !== null && width * context.zoom >= NAMED_FROM_WIDTH

  switch (item.type) {
    case "arrow":
      return ""
    case "board":
    case "embed": {
      const title = item.title ?? (item.type === "board" ? item.id : "")
      const name =
        title && named(box.width)
          ? `<div class="name" style="width: ${box.width / (context.nameScale ?? 1)}px; transform: scale(${context.nameScale})">${escapeHtml(title)}</div>`
          : ""
      const inside =
        item.type === "board"
          ? `<img src="${escapeHtml(context.image(item.id))}" alt="">`
          : `<div style="height: 100%; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground); font-size: 14px">${escapeHtml(item.src)}</div>`
      return `<div class="item" style="${place}">${name}<div class="surface" style="width: 100%; height: 100%">${inside}</div></div>`
    }
    case "section":
      return item.title && context.nameScale !== null
        ? `<div class="item" style="${place}"><h3 class="heading" style="max-width: ${box.width / context.nameScale}px; transform: scale(${context.nameScale})">${escapeHtml(item.title)}</h3></div>`
        : ""
    case "note": {
      const tone = item.tone ?? "warning"
      const background =
        tone === "neutral"
          ? "var(--card)"
          : `color-mix(in oklab, ${toneColor(tone)} 20%, var(--card))`
      return `<div class="item note" style="${place} font-size: ${canvasNoteFontSize(item.w)}px; background: ${background}">${escapeHtml(item.text)}</div>`
    }
    case "text": {
      const weight = item.size === "xl" ? 700 : item.size === "l" ? 600 : 400
      const color = item.size === "s" ? "var(--muted-foreground)" : "var(--foreground)"
      const lineHeight = item.size === "xl" || item.size === "l" ? 1.15 : 1.45
      return `<div class="item text" style="${place} font-size: ${CANVAS_TEXT_PIXELS[item.size]}px; font-weight: ${weight}; line-height: ${lineHeight}; color: ${color}">${escapeHtml(item.text)}</div>`
    }
    case "shape": {
      const fill = item.tone
        ? `color-mix(in oklab, ${toneColor(item.tone)} 16%, var(--card))`
        : "var(--card)"
      const stroke = "color-mix(in oklab, var(--foreground) 32%, transparent)"
      const paint = `style="fill: ${fill}; stroke: ${stroke}" stroke-width="1.5"`
      const { w, h } = item
      const outline =
        item.shape === "ellipse"
          ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${paint}/>`
          : item.shape === "diamond"
            ? `<polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}" ${paint} stroke-linejoin="round"/>`
            : `<rect width="${w}" height="${h}" rx="10" ${paint}/>`
      const words = item.text
        ? `<span style="font-size: ${canvasShapeFontSize(w, h)}px; max-width: ${item.shape === "diamond" ? 60 : 80}%">${escapeHtml(item.text)}</span>`
        : ""
      return `<div class="item shape" style="${place}"><svg viewBox="0 0 ${w} ${h}">${outline}</svg>${words}</div>`
    }
  }
}

/** Each arrow from the edge of one item to the edge of the other, its label on its middle. */
function drawArrows(canvas: Canvas, boxes: ReadonlyMap<string, Box>): string {
  const color = "color-mix(in oklab, var(--foreground) 62%, transparent)"
  const endBox = (end: CanvasEnd): Box | undefined =>
    typeof end === "string" ? boxes.get(end) : { x: end.x, y: end.y, width: 1, height: 1 }

  const lines: string[] = []
  const labels: string[] = []
  for (const item of canvas.items) {
    if (item.type !== "arrow") continue
    const from = endBox(item.from)
    const to = endBox(item.to)
    if (!from || !to) continue

    const start = exitPoint(from, center(to))
    const end = exitPoint(to, center(from))
    lines.push(
      `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" style="stroke: ${color}" stroke-width="2" stroke-linecap="round"${item.dashed ? ' stroke-dasharray="7 7"' : ""} marker-end="url(#head)"/>`
    )
    if (item.label) {
      labels.push(
        `<div class="label" style="left: ${(start.x + end.x) / 2}px; top: ${(start.y + end.y) / 2}px">${escapeHtml(item.label)}</div>`
      )
    }
  }
  if (lines.length === 0) return ""

  return `<svg class="arrows" width="1" height="1"><defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" style="fill: ${color}"/></marker></defs>${lines.join("")}</svg>${labels.join("")}`
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Where the line from a box's center toward `toward` leaves the box. */
function exitPoint(box: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const { x: cx, y: cy } = center(box)
  const dx = toward.x - cx
  const dy = toward.y - cy
  if ((dx === 0 && dy === 0) || box.width <= 1) return { x: cx, y: cy }

  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy)
  )
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function union(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 }

  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** How many lines words take at a width, reckoned from an average letter's width. */
function lines(text: string, width: number, size: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * 0.55)))
  return text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0)
}

function longestLine(text: string): number {
  return Math.max(...text.split("\n").map((line) => line.length))
}

function toneColor(tone: string): string {
  return TONES[tone] ?? `var(--${tone})`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
