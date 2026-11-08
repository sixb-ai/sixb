import { CANVAS_FILE, type Canvas, type CanvasItem } from "@sixb/core/artifacts"
import { documentCanvas, LIVE_FILES, patchText } from "@sixb/core/artifacts/live"
import * as Y from "yjs"
import type { CanvasChange } from "../renderers/canvas/draft"
import type { LiveArtifact } from "./session"

// A canvas as its live document holds it, read as the board draws it and changed as the board
// edits it.
//
// Reading: the canvas is kept as one `Canvas`, rebuilt at each change of the document, in which
// an item nobody changed is the same object as before. The board draws an item again only when
// its object changes, so a change someone makes to one note draws that note, not the canvas.
//
// Writing: an edit stays a `CanvasChange`, one function from a canvas to the next, as the draft
// had it. What it changed is written into the document, key by key and word by word, in one
// transaction under this canvas's own origin: only those are this reader's to undo.

/** The item types the board draws: anything else in a document is left out. */
const ITEM_TYPES: ReadonlySet<string> = new Set<CanvasItem["type"]>([
  "board",
  "section",
  "note",
  "text",
  "shape",
  "embed",
  "arrow",
])
/** The item keys held as `Y.Text`: words that people type. */
const TEXT_KEYS: ReadonlySet<string> = new Set(["text", "title", "label"])

/** How long changes made one after the other are one step for undo, as typing a word is. */
const UNDO_CAPTURE_MS = 400

type ItemMap = Y.Map<unknown>

const EMPTY: Canvas = { items: [] }

export class LiveCanvas {
  private canvas: Canvas = EMPTY
  private readonly cache = new Map<string, { readonly map: ItemMap; item: CanvasItem }>()
  private structure: ReturnType<typeof documentCanvas> = null
  private undoManager: Y.UndoManager | null = null
  private readonly listeners = new Set<() => void>()
  private history = { undo: false, redo: false }
  /** The origin of this reader's own changes: the only ones its undo takes back. */
  readonly origin = Symbol("sixb-live-canvas")

  constructor(private readonly doc: Y.Doc) {
    doc.getMap<unknown>(LIVE_FILES).observe(this.onFiles)
    this.bind()
  }

  /** The canvas now, or null while the document holds none: not synced yet, or not a canvas. */
  getCanvas = (): Canvas | null => (this.structure ? this.canvas : null)

  getHistory = (): { readonly undo: boolean; readonly redo: boolean } => this.history

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Makes an edit, as one step of this reader's undo; one that changes nothing writes nothing. */
  apply(change: CanvasChange): void {
    if (!this.structure) return

    const before = this.canvas
    const after = change(before)
    if (after === before) return

    const { items, order } = this.structure
    this.doc.transact(() => write(items, order, before, after), this.origin)
  }

  undo(): void {
    this.undoManager?.undo()
  }

  redo(): void {
    this.undoManager?.redo()
  }

  /** Ends the undo step being made: what comes next, such as a new drag, is a step of its own. */
  stopCapturing(): void {
    this.undoManager?.stopCapturing()
  }

  destroy(): void {
    this.doc.getMap<unknown>(LIVE_FILES).unobserve(this.onFiles)
    this.unbind()
    this.listeners.clear()
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** Follows the canvas's structure: it is replaced when someone writes `canvas.json` whole. */
  private onFiles = (event: Y.YMapEvent<unknown>): void => {
    if (event.keysChanged.has(CANVAS_FILE)) this.bind()
  }

  private bind(): void {
    this.unbind()
    this.structure = documentCanvas(this.doc)
    this.cache.clear()
    if (this.structure) {
      this.structure.items.observeDeep(this.onItems)
      this.structure.order.observe(this.onOrder)
      this.undoManager = new Y.UndoManager([this.structure.items, this.structure.order], {
        trackedOrigins: new Set([this.origin]),
        captureTimeout: UNDO_CAPTURE_MS,
      })
      this.undoManager.on("stack-item-added", this.onHistory)
      this.undoManager.on("stack-item-popped", this.onHistory)
      this.undoManager.on("stack-cleared", this.onHistory)
    }
    this.rebuild(null)
  }

  private unbind(): void {
    if (this.structure) {
      this.structure.items.unobserveDeep(this.onItems)
      this.structure.order.unobserve(this.onOrder)
    }
    this.undoManager?.destroy()
    this.undoManager = null
    this.onHistory()
  }

  private onItems = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const changed = new Set<string>()
    for (const event of events) {
      // The items map itself: items added or deleted; else a change inside one item, its path
      // starting at its id.
      if (event.path.length === 0) {
        for (const key of event.changes.keys.keys()) changed.add(key)
      } else {
        const id = event.path[0]
        if (typeof id === "string") changed.add(id)
      }
    }
    this.rebuild(changed)
  }

  private onOrder = (): void => this.rebuild(new Set())

  private onHistory = (): void => {
    const next = {
      undo: (this.undoManager?.undoStack.length ?? 0) > 0,
      redo: (this.undoManager?.redoStack.length ?? 0) > 0,
    }
    if (next.undo === this.history.undo && next.redo === this.history.redo) return
    this.history = next
    this.notify()
  }

  /**
   * The canvas again, its items in order, then any the order misses, and without an arrow whose
   * item someone deleted meanwhile, as `canvas.json` is written. Only the items in `changed` are
   * read again, all of them when it is null.
   */
  private rebuild(changed: ReadonlySet<string> | null): void {
    const structure = this.structure
    if (!structure) {
      this.canvas = EMPTY
      this.notify()
      return
    }

    const { items, order } = structure
    const ids: string[] = []
    const seen = new Set<string>()
    for (const id of [...order.toArray(), ...[...items.keys()].sort()]) {
      if (seen.has(id) || !items.has(id)) continue
      seen.add(id)
      ids.push(id)
    }

    const next: CanvasItem[] = []
    for (const id of ids) {
      const map = items.get(id) as ItemMap
      const cached = this.cache.get(id)
      if (cached && cached.map === map && changed !== null && !changed.has(id)) {
        next.push(cached.item)
        continue
      }
      const item = readItem(map)
      if (!item) continue
      this.cache.set(id, { map, item })
      next.push(item)
    }
    for (const id of this.cache.keys()) {
      if (!seen.has(id)) this.cache.delete(id)
    }

    const kept = next.filter(
      (item) => item.type !== "arrow" || (joined(item.from, seen) && joined(item.to, seen))
    )
    const same =
      kept.length === this.canvas.items.length &&
      kept.every((item, index) => item === this.canvas.items[index])
    if (same && this.canvas !== EMPTY) return

    this.canvas = { items: kept }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function joined(end: unknown, ids: ReadonlySet<string>): boolean {
  return typeof end !== "string" || ids.has(end)
}

/** An item as the board reads it; null for one that is not an item of a known type. */
function readItem(map: ItemMap): CanvasItem | null {
  const item: Record<string, unknown> = {}
  map.forEach((value, key) => {
    item[key] = value instanceof Y.Text ? value.toString() : value
  })
  if (typeof item.id !== "string" || typeof item.type !== "string" || !ITEM_TYPES.has(item.type)) {
    return null
  }
  return item as unknown as CanvasItem
}

// ── Writing ─────────────────────────────────────────────────────────────

/** Writes into the structure what changed from `before` to `after`. */
function write(items: Y.Map<ItemMap>, order: Y.Array<string>, before: Canvas, after: Canvas): void {
  const previous = new Map(before.items.map((item) => [item.id, item]))
  const next = new Set<string>()

  for (const item of after.items) {
    next.add(item.id)
    const was = previous.get(item.id)
    if (was === item) continue

    const map = items.get(item.id)
    if (!was || !map) {
      items.set(item.id, itemMap(item))
      continue
    }
    writeItem(map, was, item)
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) items.delete(id)
  }

  // An edit adds at the end and removes anywhere: the order follows, someone else's additions kept.
  const ids = order.toArray()
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index] as string
    if (previous.has(id) && !next.has(id)) order.delete(index, 1)
  }
  const ordered = new Set(order.toArray())
  const added = after.items.map((item) => item.id).filter((id) => !ordered.has(id))
  if (added.length > 0) order.push(added)
}

function writeItem(map: ItemMap, was: CanvasItem, item: CanvasItem): void {
  const before = was as unknown as Record<string, unknown>
  const after = item as unknown as Record<string, unknown>

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = after[key]
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue

    if (value === undefined) {
      map.delete(key)
      continue
    }

    const words = map.get(key)
    if (TEXT_KEYS.has(key) && typeof value === "string" && words instanceof Y.Text) {
      patchText(words, value)
      continue
    }
    map.set(key, TEXT_KEYS.has(key) && typeof value === "string" ? new Y.Text(value) : value)
  }
}

function itemMap(item: CanvasItem): ItemMap {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue
    map.set(key, TEXT_KEYS.has(key) && typeof value === "string" ? new Y.Text(value) : value)
  }
  return map
}

const canvases = new WeakMap<LiveArtifact, LiveCanvas>()

/** The canvas of a live artifact, one per artifact, so the board and the header share its undo. */
export function liveCanvasOf(artifact: LiveArtifact): LiveCanvas {
  let canvas = canvases.get(artifact)
  if (!canvas) {
    canvas = new LiveCanvas(artifact.doc)
    canvases.set(artifact, canvas)
  }
  return canvas
}
