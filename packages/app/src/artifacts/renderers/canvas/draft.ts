import {
  ARTIFACT_LIMITS,
  type ArtifactTone,
  CANVAS_FILE,
  type Canvas,
  type CanvasArrow,
  type CanvasItem,
  type CanvasShape,
  type CanvasTextSize,
  formatCanvas,
} from "@sixb/core/artifacts"

/**
 * Everything a canvas edit changes, as one function from a canvas to the next. The canvas a draft
 * starts from never changes; an edit that changes nothing returns it as it was, so undo keeps no
 * step for it.
 */
export type CanvasChange = (canvas: Canvas) => Canvas

/** An item's box on the canvas, as a drag or a resize leaves it. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** What a selection's toolbar sets on the items it can: their tone, text size, shape, or line. */
export interface ItemStyle {
  readonly tone?: ArtifactTone | null
  readonly size?: CanvasTextSize
  readonly shape?: CanvasShape
  readonly dashed?: boolean
  readonly label?: string
}

/** The items a reader adds from the toolbar, as they first appear. */
export type NewItem = "note" | "text" | "shape" | "section"

/** Positions moved by a drag, a nudge, or a snap, by item id. */
export function moveItems(positions: ReadonlyMap<string, { x: number; y: number }>): CanvasChange {
  return (canvas) => {
    let changed = false
    const items = canvas.items.map((item) => {
      const to = positions.get(item.id)
      if (!to || item.type === "arrow") return item
      const x = position(to.x)
      const y = position(to.y)
      if (x === item.x && y === item.y) return item
      changed = true
      return { ...item, x, y }
    })
    return changed ? { ...canvas, items } : canvas
  }
}

/**
 * An item's new box, from its resize handles. A text's height follows its words, so only its width
 * changes; a note's height becomes the least it takes.
 */
export function resizeItem(id: string, box: Box): CanvasChange {
  return (canvas) =>
    replace(canvas, id, (item) => {
      if (item.type === "arrow") return item
      const placed = { ...item, x: position(box.x), y: position(box.y) }
      if (item.type === "text") return { ...placed, w: dimension(box.w) }
      return { ...placed, w: dimension(box.w), h: dimension(box.h) }
    })
}

/** An item added at a point, its top left there, under a new id of its kind. */
export function addItem(
  kind: NewItem,
  at: { x: number; y: number },
  text: string
): {
  readonly change: CanvasChange
  readonly id: string
} {
  const id = newItemId(kind)
  const change: CanvasChange = (canvas) => {
    if (canvas.items.length >= ARTIFACT_LIMITS.maxCanvasItems) return canvas
    if (canvas.items.some((item) => item.id === id)) return canvas
    const place = { id, x: position(at.x), y: position(at.y) }
    const item: CanvasItem =
      kind === "note"
        ? { ...place, type: "note", w: 240, text }
        : kind === "text"
          ? { ...place, type: "text", text, size: "l" }
          : kind === "shape"
            ? { ...place, type: "shape", shape: "rect", w: 200, h: 120, ...(text ? { text } : {}) }
            : { ...place, type: "section", w: 640, h: 400, ...(text ? { title: text } : {}) }
    return { ...canvas, items: [...canvas.items, item] }
  }
  return { change, id }
}

/**
 * Items removed, with the arrows that join them: an arrow needs both its ends. A section is
 * removed alone; what it held stays where it was. A canvas keeps at least one item, as publishing
 * requires: removing every one changes nothing.
 */
export function removeItems(ids: ReadonlySet<string>): CanvasChange {
  return (canvas) => {
    const items = canvas.items.filter(
      (item) =>
        !ids.has(item.id) &&
        !(item.type === "arrow" && (joins(item.from, ids) || joins(item.to, ids)))
    )
    if (items.length === 0) return canvas

    return items.length === canvas.items.length ? canvas : { ...canvas, items }
  }
}

/**
 * Copies of items, a step down and to the right, with the arrows between two of them copied too:
 * a copied flow keeps its arrows. Returns the copies' ids, to select them.
 */
export function duplicateItems(ids: ReadonlySet<string>): {
  readonly change: CanvasChange
  readonly copies: (canvas: Canvas) => readonly string[]
} {
  // Each copy's id, new once and then the same: the change and the copies it names agree.
  const names = new Map<string, string>()
  const copyOf = (id: string) => {
    let name = names.get(id)
    if (!name) {
      name = newItemId(id)
      names.set(id, name)
    }
    return name
  }
  /** Each item copied, by its id, and its copy's. */
  const plan = (canvas: Canvas) => {
    const renamed = new Map<string, string>()
    for (const item of canvas.items) {
      if (!ids.has(item.id) || item.type === "arrow") continue
      renamed.set(item.id, copyOf(item.id))
    }
    return renamed
  }
  const change: CanvasChange = (canvas) => {
    const renamed = plan(canvas)
    if (renamed.size === 0) return canvas
    const copies: CanvasItem[] = []
    for (const item of canvas.items) {
      if (item.type === "arrow") {
        const from = typeof item.from === "string" ? renamed.get(item.from) : undefined
        const to = typeof item.to === "string" ? renamed.get(item.to) : undefined
        if (!from || !to) continue
        copies.push({ ...item, id: copyOf(item.id), from, to })
        continue
      }
      const id = renamed.get(item.id)
      if (id) copies.push({ ...item, id, x: position(item.x + STEP), y: position(item.y + STEP) })
    }
    const room = Math.max(0, ARTIFACT_LIMITS.maxCanvasItems - canvas.items.length)
    return { ...canvas, items: [...canvas.items, ...copies.slice(0, room)] }
  }
  return { change, copies: (canvas) => [...plan(canvas).values()] }
}

/**
 * An item's words, as typed in place: a note's, a text's, a shape's, a section's or a board's
 * title, an arrow's label. A note or a text left empty is removed, as a sticky note is thrown away.
 * Words past what publishing takes for the item are cut there.
 */
export function setItemText(id: string, typed: string): CanvasChange {
  return (canvas) => {
    const item = canvas.items.find((candidate) => candidate.id === id)
    if (!item) return canvas

    const words = item.type === "note" || item.type === "text"
    const text = typed.slice(
      0,
      words ? ARTIFACT_LIMITS.maxCanvasTextLength : ARTIFACT_LIMITS.maxCanvasLabelLength
    )
    const trimmed = text.trim()
    if ((item.type === "note" || item.type === "text") && !trimmed) {
      return removeItems(new Set([id]))(canvas)
    }
    return replace(canvas, id, (current) => {
      switch (current.type) {
        case "note":
        case "text":
          return current.text === text ? current : { ...current, text }
        case "shape":
          return withOptional(current, "text", trimmed)
        case "section":
        case "board":
        case "embed":
          return withOptional(current, "title", trimmed)
        case "arrow":
          return withOptional(current, "label", trimmed)
      }
    })
  }
}

/** An arrow from one item to another, under a new id; none when they are one item. */
export function connectItems(from: string, to: string): CanvasChange {
  const id = newItemId("arrow")
  return (canvas) => {
    if (from === to || canvas.items.length >= ARTIFACT_LIMITS.maxCanvasItems) return canvas
    const exists = canvas.items.some(
      (item) => item.type === "arrow" && item.from === from && item.to === to
    )
    if (exists) return canvas
    const arrow: CanvasArrow = {
      id,
      type: "arrow",
      from,
      to,
      dashed: false,
    }
    return { ...canvas, items: [...canvas.items, arrow] }
  }
}

/** A style set on every item of a selection that takes it; the rest are left as they are. */
export function styleItems(ids: ReadonlySet<string>, style: ItemStyle): CanvasChange {
  return (canvas) => {
    let changed = false
    const items = canvas.items.map((item) => {
      if (!ids.has(item.id)) return item
      let next: CanvasItem = item
      if (style.tone !== undefined && (item.type === "note" || item.type === "shape")) {
        const { tone: _, ...rest } = item
        next = style.tone === null ? rest : { ...rest, tone: style.tone }
      }
      if (style.size && next.type === "text") next = { ...next, size: style.size }
      if (style.shape && next.type === "shape") next = { ...next, shape: style.shape }
      if (style.dashed !== undefined && next.type === "arrow")
        next = { ...next, dashed: style.dashed }
      if (style.label !== undefined && next.type === "arrow") {
        next = withOptional(next, "label", style.label.trim())
      }
      if (JSON.stringify(next) !== JSON.stringify(item)) changed = true
      return next
    })
    return changed ? { ...canvas, items } : canvas
  }
}

/**
 * The files a save publishes: `canvas.json`, and the HTML of each board removed, unless another
 * board still shows it. Boards' files are otherwise the version's, carried over.
 */
export function canvasFiles(original: Canvas, canvas: Canvas): Map<string, string | null> {
  const files = new Map<string, string | null>([[CANVAS_FILE, formatCanvas(canvas)]])
  const shown = new Set(canvas.items.flatMap((item) => (item.type === "board" ? [item.file] : [])))
  for (const item of original.items) {
    if (item.type === "board" && !shown.has(item.file)) files.set(item.file, null)
  }
  return files
}

/** How far a copy sits from what it copies, down and to the right. */
const STEP = 32

/** The letters and digits a new id ends in, after a dash, and how many. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const ID_SUFFIX = 6
/** A suffix a new id was given, letters and digits mixed, or a number. */
const RANDOM_SUFFIX = /-(?:(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{6}|\d+)$/

/**
 * A new item's id: what it is or what it copies, then a dash and six random letters and digits,
 * as `note-k3m9q2`, so two people adding at once never name two items alike. A copy of a copy
 * drops the suffix its original was given. Ids stay within what `canvas.json` takes: forty at most.
 */
export function newItemId(base: string): string {
  const stem = base.replace(RANDOM_SUFFIX, "").slice(0, 40 - ID_SUFFIX - 1)
  const bytes = crypto.getRandomValues(new Uint8Array(ID_SUFFIX))
  const suffix = [...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")
  return `${stem || "item"}-${suffix}`
}

function joins(end: CanvasArrow["from"], ids: ReadonlySet<string>): boolean {
  return typeof end === "string" && ids.has(end)
}

function replace(canvas: Canvas, id: string, update: (item: CanvasItem) => CanvasItem): Canvas {
  let changed = false
  const items = canvas.items.map((item) => {
    if (item.id !== id) return item
    const next = update(item)
    if (next !== item && JSON.stringify(next) !== JSON.stringify(item)) changed = true
    return next
  })
  return changed ? { ...canvas, items } : canvas
}

function withOptional<Item extends CanvasItem, Key extends string>(
  item: Item,
  key: Key,
  value: string
): Item {
  const { [key]: _, ...rest } = item as Item & Record<Key, unknown>
  return (value ? { ...rest, [key]: value } : rest) as Item
}

function position(value: number): number {
  const max = ARTIFACT_LIMITS.maxCanvasPosition
  return Math.round(Math.max(-max, Math.min(max, value)))
}

function dimension(value: number): number {
  return Math.round(
    Math.max(ARTIFACT_LIMITS.minCanvasItemSize, Math.min(ARTIFACT_LIMITS.maxCanvasItemSize, value))
  )
}
