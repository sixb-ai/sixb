import { isArtifactAddress } from "./address"
import { ARTIFACT_LIMITS } from "./limits"
import { ARTIFACT_TONES, type ArtifactTone, isArtifactTone } from "./tones"

/**
 * A canvas artifact is `canvas.json`, its items on an endless board, and the HTML files its boards
 * show beside it. Items draw in the order listed, sections behind everything else.
 */
export const CANVAS_FILE = "canvas.json"

export const CANVAS_ITEM_TYPES = [
  "board",
  "section",
  "note",
  "text",
  "shape",
  "arrow",
  "embed",
] as const
export type CanvasItemType = (typeof CANVAS_ITEM_TYPES)[number]

export const CANVAS_SHAPES = ["rect", "ellipse", "diamond"] as const
export type CanvasShape = (typeof CANVAS_SHAPES)[number]

export const CANVAS_TEXT_SIZES = ["s", "m", "l", "xl"] as const
export type CanvasTextSize = (typeof CANVAS_TEXT_SIZES)[number]

/** Where an item sits, from the canvas's origin, in pixels; and how large it is. */
interface Placed {
  readonly id: string
  readonly x: number
  readonly y: number
}
interface Sized extends Placed {
  readonly w: number
  readonly h: number
}

/** An HTML file of the canvas, shown live as a page `w` by `h`: a screen, a mockup, a poster. */
export interface CanvasBoard extends Sized {
  readonly type: "board"
  readonly file: string
  readonly title?: string
}

/** A titled region drawn behind what it holds: a flow, a cluster of notes. */
export interface CanvasSection extends Sized {
  readonly type: "section"
  readonly title?: string
}

/** A sticky note of plain text; its height follows its text unless it is given one. */
export interface CanvasNote extends Placed {
  readonly type: "note"
  readonly w: number
  readonly h?: number
  readonly text: string
  readonly tone?: ArtifactTone
}

/** A label or a heading on the canvas, wrapped at `w` when given. */
export interface CanvasText extends Placed {
  readonly type: "text"
  readonly text: string
  readonly size: CanvasTextSize
  readonly w?: number
}

/** A rectangle, ellipse, or diamond, with text inside: for diagrams. */
export interface CanvasShapeItem extends Sized {
  readonly type: "shape"
  readonly shape: CanvasShape
  readonly text?: string
  readonly tone?: ArtifactTone
}

/** Another artifact, or a part of one, shown in place: a chart, a range, a slide, a page. */
export interface CanvasEmbed extends Sized {
  readonly type: "embed"
  readonly src: string
  readonly title?: string
}

/** One end of an arrow: an item, by its id, or a point on the canvas. */
export type CanvasEnd = string | { readonly x: number; readonly y: number }

/** An arrow from one item, or point, to another. */
export interface CanvasArrow {
  readonly id: string
  readonly type: "arrow"
  readonly from: CanvasEnd
  readonly to: CanvasEnd
  readonly label?: string
  readonly dashed: boolean
}

export type CanvasItem =
  | CanvasBoard
  | CanvasSection
  | CanvasNote
  | CanvasText
  | CanvasShapeItem
  | CanvasEmbed
  | CanvasArrow

/** A canvas's items. It opens fitted to all of them. */
export interface Canvas {
  readonly items: readonly CanvasItem[]
}

class CanvasError extends Error {}

/**
 * Reads `canvas.json` into its full form, with defaults filled, or says what is wrong in words the
 * author can act on, naming the item and the key. Whether a board's file exists is checked against
 * the version's files.
 */
export function parseCanvas(
  text: string
): { readonly canvas: Canvas } | { readonly error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: `${CANVAS_FILE} is not valid JSON.` }
  }
  try {
    return { canvas: readCanvas(value) }
  } catch (error) {
    if (error instanceof CanvasError) return { error: `${CANVAS_FILE}: ${error.message}` }
    throw error
  }
}

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const TEXT_MAX = ARTIFACT_LIMITS.maxCanvasTextLength
const LABEL_MAX = ARTIFACT_LIMITS.maxCanvasLabelLength

function readCanvas(value: unknown): Canvas {
  const input = record(value, "the canvas", ["items"])
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new CanvasError('"items" must list at least one item.')
  }
  if (input.items.length > ARTIFACT_LIMITS.maxCanvasItems) {
    throw new CanvasError(
      `a canvas holds at most ${ARTIFACT_LIMITS.maxCanvasItems} items; this one has ${input.items.length}.`
    )
  }
  const items = input.items.map((item, index) => readItem(item, index))
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new CanvasError(`two items have the id '${item.id}'.`)
    ids.add(item.id)
  }
  const boards = items.filter((item) => item.type === "board").length
  if (boards > ARTIFACT_LIMITS.maxCanvasBoards) {
    throw new CanvasError(
      `a canvas holds at most ${ARTIFACT_LIMITS.maxCanvasBoards} boards; this one has ${boards}.`
    )
  }
  for (const item of items) {
    if (item.type !== "arrow") continue
    for (const [key, end] of [
      ["from", item.from],
      ["to", item.to],
    ] as const) {
      if (typeof end !== "string") continue
      const target = items.find((candidate) => candidate.id === end)
      if (!target) {
        throw new CanvasError(
          `arrow '${item.id}' "${key}" names '${end}', which the canvas does not have.`
        )
      }
      if (target.type === "arrow") {
        throw new CanvasError(
          `arrow '${item.id}' "${key}" names arrow '${end}'; an arrow joins items, not arrows.`
        )
      }
    }
    if (item.from === item.to) {
      throw new CanvasError(`arrow '${item.id}' starts and ends at '${String(item.from)}'.`)
    }
  }
  return { items }
}

const KEYS: Readonly<Record<CanvasItemType, readonly string[]>> = {
  board: ["file", "x", "y", "w", "h", "title"],
  section: ["x", "y", "w", "h", "title"],
  note: ["x", "y", "w", "h", "text", "tone"],
  text: ["x", "y", "w", "text", "size"],
  shape: ["shape", "x", "y", "w", "h", "text", "tone"],
  arrow: ["from", "to", "label", "dashed"],
  embed: ["src", "x", "y", "w", "h", "title"],
}

function readItem(value: unknown, index: number): CanvasItem {
  const loose = record(value, `item ${index + 1}`, null)
  if (typeof loose.id !== "string" || !ITEM_ID.test(loose.id)) {
    throw new CanvasError(
      `item ${index + 1} needs an "id" of lowercase letters, digits, and hyphens, such as "pricing".`
    )
  }
  const id = loose.id
  if (!(CANVAS_ITEM_TYPES as readonly unknown[]).includes(loose.type)) {
    throw new CanvasError(
      `item '${id}' has type ${JSON.stringify(loose.type)}; use one of ${CANVAS_ITEM_TYPES.join(", ")}.`
    )
  }
  const type = loose.type as CanvasItemType
  const at = `${type} '${id}'`
  const input = record(value, at, ["id", "type", ...KEYS[type]])
  const place = () => ({ id, x: position(input.x, at, "x"), y: position(input.y, at, "y") })
  const size = (key: "w" | "h") => dimension(input[key], at, key)
  const title = () => optionalText(input.title, at, "title", LABEL_MAX)
  const tone = () => {
    if (input.tone === undefined) return {}
    if (!isArtifactTone(input.tone)) {
      throw new CanvasError(
        `${at} has the tone ${JSON.stringify(input.tone)}; use one of ${ARTIFACT_TONES.join(", ")}.`
      )
    }
    return { tone: input.tone }
  }
  switch (type) {
    case "board": {
      if (typeof input.file !== "string" || !/\.html?$/i.test(input.file)) {
        throw new CanvasError(
          `${at} needs a "file", the HTML it shows, such as "boards/${id}.html".`
        )
      }
      return { type, ...place(), w: size("w"), h: size("h"), file: input.file, ...title() }
    }
    case "section":
      return { type, ...place(), w: size("w"), h: size("h"), ...title() }
    case "note":
      return {
        type,
        ...place(),
        w: size("w"),
        ...(input.h === undefined ? {} : { h: size("h") }),
        text: requiredText(input.text, at, "text", TEXT_MAX),
        ...tone(),
      }
    case "text": {
      if (
        input.size !== undefined &&
        !(CANVAS_TEXT_SIZES as readonly unknown[]).includes(input.size)
      ) {
        throw new CanvasError(
          `${at} "size" is ${JSON.stringify(input.size)}; use one of ${CANVAS_TEXT_SIZES.join(", ")}.`
        )
      }
      return {
        type,
        ...place(),
        text: requiredText(input.text, at, "text", TEXT_MAX),
        size: (input.size as CanvasTextSize | undefined) ?? "m",
        ...(input.w === undefined ? {} : { w: size("w") }),
      }
    }
    case "shape": {
      if (!(CANVAS_SHAPES as readonly unknown[]).includes(input.shape)) {
        throw new CanvasError(
          `${at} "shape" is ${JSON.stringify(input.shape)}; use one of ${CANVAS_SHAPES.join(", ")}.`
        )
      }
      return {
        type,
        ...place(),
        w: size("w"),
        h: size("h"),
        shape: input.shape as CanvasShape,
        ...optionalText(input.text, at, "text", LABEL_MAX, "text"),
        ...tone(),
      }
    }
    case "embed": {
      if (typeof input.src !== "string" || !isArtifactAddress(input.src)) {
        throw new CanvasError(
          `${at} needs a "src", another artifact's address, such as "artifact:art_k3m9q2x7tp#chart=revenue".`
        )
      }
      return { type, ...place(), w: size("w"), h: size("h"), src: input.src.trim(), ...title() }
    }
    case "arrow": {
      if (input.dashed !== undefined && typeof input.dashed !== "boolean") {
        throw new CanvasError(`${at} "dashed" must be true or false.`)
      }
      return {
        type,
        id,
        from: end(input.from, at, "from"),
        to: end(input.to, at, "to"),
        ...optionalText(input.label, at, "label", LABEL_MAX, "label"),
        dashed: input.dashed === true,
      }
    }
  }
}

function end(value: unknown, at: string, key: string): CanvasEnd {
  if (typeof value === "string" && value) return value
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const point = record(value, `${at} "${key}"`, ["x", "y"])
    return { x: position(point.x, at, `${key}.x`), y: position(point.y, at, `${key}.y`) }
  }
  throw new CanvasError(
    `${at} needs "${key}": an item's id, or a point such as { "x": 0, "y": 0 }.`
  )
}

function position(value: unknown, at: string, key: string): number {
  const max = ARTIFACT_LIMITS.maxCanvasPosition
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > max) {
    throw new CanvasError(
      `${at} needs "${key}", a number of pixels within ±${max.toLocaleString("en-US")}.`
    )
  }
  return value
}

function dimension(value: unknown, at: string, key: string): number {
  const { minCanvasItemSize: min, maxCanvasItemSize: max } = ARTIFACT_LIMITS
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new CanvasError(`${at} needs "${key}", a size of ${min} to ${max} pixels.`)
  }
  return value
}

function requiredText(value: unknown, at: string, key: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new CanvasError(`${at} needs "${key}", its text.`)
  if (value.length > max)
    throw new CanvasError(`${at} "${key}" is ${value.length} characters; at most ${max}.`)
  return value.trim()
}

function optionalText(
  value: unknown,
  at: string,
  key: string,
  max: number,
  as: string = key
): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== "string" || value.length > max) {
    throw new CanvasError(`${at} "${key}" must be text of at most ${max} characters.`)
  }
  return value.trim() ? { [as]: value.trim() } : {}
}

function record(
  value: unknown,
  at: string,
  keys: readonly string[] | null
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanvasError(`${at} must be an object.`)
  }
  const input = value as Record<string, unknown>
  const unknownKey = keys && Object.keys(input).find((key) => !keys.includes(key))
  if (unknownKey) {
    throw new CanvasError(
      `${at} has '${unknownKey}'; it takes ${keys.map((key) => `"${key}"`).join(", ")}.`
    )
  }
  return input
}
