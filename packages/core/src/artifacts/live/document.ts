import * as Y from "yjs"
import type { FileRef } from "../../blob-storage/types"
import { CANVAS_FILE, type CanvasItem, formatCanvas, parseCanvas } from "../canvas"
import type { ArtifactKind } from "../kinds"
import { diffSequences, diffText, interleave, mergeSequences, mergeText } from "./diff"

// An artifact's open version as a Yjs document, which everyone editing it changes at once:
//
//   files: Y.Map<path, Y.Text | FileRef | Y.Map>
//
// A text file is a `Y.Text`, a binary file the reference to its stored bytes, which only ever
// changes whole. A kind may hold one file as a structure, so that concurrent changes to it merge
// by what they change rather than by its characters: a canvas holds `canvas.json` as
//
//   items: Y.Map<id, Y.Map<key, value>>   order: Y.Array<id>
//
// with each item's words (`text`, `title`, `label`) as `Y.Text`. Two people moving two items, or
// one moving an item while another types in it, change different keys and never conflict.

/** One file of an artifact as the live layer reads it: its text, or its stored bytes. */
export type LiveFile = { readonly text: string } | { readonly file: FileRef }

/** An artifact's files by path. */
export type LiveFiles = ReadonlyMap<string, LiveFile>

/** The root map of a document, by path. */
export const LIVE_FILES = "files"
/** The root map of what a document is of: its artifact's kind. */
const LIVE_ARTIFACT = "artifact"

/** The extensions whose files are text, edited as `Y.Text`; anything else is stored bytes. */
export const LIVE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "md",
  "markdown",
  "txt",
  "csv",
  "svg",
  "xml",
])

/** Whether a file at `path` is held as text in a document. */
export function isLiveTextPath(path: string): boolean {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && LIVE_TEXT_EXTENSIONS.has(extension)
}

/** The item keys of a canvas held as `Y.Text`: words that people type. */
const CANVAS_TEXT_KEYS: ReadonlySet<string> = new Set(["text", "title", "label"])

/** The file a kind holds as a structure, if it holds one. */
function structuredPath(kind: ArtifactKind): string | undefined {
  return kind === "canvas" ? CANVAS_FILE : undefined
}

/**
 * A document holding `files` for an artifact of `kind`. A structured file that does not parse is
 * held as text, so nothing is lost; publishing then refuses it as it would the file. Built as
 * `clientID`, two builds of the same files are the same document.
 */
export function createArtifactDocument(
  kind: ArtifactKind,
  files: LiveFiles,
  options: { readonly clientID?: number } = {}
): Y.Doc {
  const doc = new Y.Doc()
  if (options.clientID !== undefined) doc.clientID = options.clientID
  doc.transact(() => {
    doc.getMap(LIVE_ARTIFACT).set("kind", kind)
    const map = doc.getMap<unknown>(LIVE_FILES)
    for (const path of [...files.keys()].sort()) {
      const file = files.get(path) as LiveFile
      map.set(path, entryOf(kind, path, file))
    }
  })
  return doc
}

/** The kind of artifact a document is of. */
export function documentKind(doc: Y.Doc): ArtifactKind {
  const kind = doc.getMap(LIVE_ARTIFACT).get("kind")
  if (typeof kind !== "string") throw new Error("[Sixb] This document holds no artifact.")
  return kind as ArtifactKind
}

/**
 * The files a document holds now. A canvas's structure is written as `canvas.json` is: its items
 * in order, then any no order names, and without an arrow whose item someone deleted meanwhile.
 */
export function documentFiles(doc: Y.Doc): Map<string, LiveFile> {
  const files = new Map<string, LiveFile>()
  doc.getMap<unknown>(LIVE_FILES).forEach((entry, path) => {
    if (entry instanceof Y.Text) files.set(path, { text: entry.toString() })
    else if (entry instanceof Y.Map) files.set(path, { text: canvasText(entry) })
    else files.set(path, { file: entry as FileRef })
  })
  return new Map([...files].sort(([left], [right]) => (left < right ? -1 : 1)))
}

/** The canvas a document holds as its structure, for a viewer to read and edit; null without. */
export function documentCanvas(
  doc: Y.Doc
): { readonly items: Y.Map<Y.Map<unknown>>; readonly order: Y.Array<string> } | null {
  const entry = doc.getMap<unknown>(LIVE_FILES).get(CANVAS_FILE)
  if (!(entry instanceof Y.Map)) return null
  return {
    items: entry.get("items") as Y.Map<Y.Map<unknown>>,
    order: entry.get("order") as Y.Array<string>,
  }
}

/**
 * Applies to a document what changed from `base` to `next`, as edits, so that whatever else the
 * document changed since `base` stays: a file added, deleted, or replaced; a text's lines and
 * characters; a canvas's items, key by key, and their order. Where both changed the same thing,
 * `next` wins a value and both keep their words, merged as concurrent edits are. One transaction,
 * under `origin`.
 */
export function mergeIntoDocument(
  doc: Y.Doc,
  base: LiveFiles,
  next: LiveFiles,
  origin?: unknown
): void {
  const kind = documentKind(doc)
  const structured = structuredPath(kind)

  doc.transact(() => {
    const files = doc.getMap<unknown>(LIVE_FILES)

    for (const [path, file] of next) {
      const before = base.get(path)
      if (before && sameFile(before, file)) continue

      const current = files.get(path)
      if ("file" in file) {
        if (!sameRef(current, file.file)) files.set(path, file.file)
        continue
      }

      // A file added on both sides takes what `next` holds: the merge starts from what is there.
      const currentText = textOf(current)
      const baseText = before && "text" in before ? before.text : currentText

      if (path === structured) {
        if (current instanceof Y.Map && mergeCanvas(current, baseText ?? "", file.text)) continue
      } else if (current instanceof Y.Text) {
        patchText(current, mergeText(baseText ?? "", current.toString(), file.text))
        continue
      }
      files.set(path, entryOf(kind, path, file))
    }

    for (const path of base.keys()) {
      if (!next.has(path)) files.delete(path)
    }
  }, origin)
}

/** What a document's entry is for a file: a structure, a text, or a reference. */
function entryOf(kind: ArtifactKind, path: string, file: LiveFile): unknown {
  if ("file" in file) return { ...file.file }
  if (path === structuredPath(kind)) {
    const parsed = parseCanvas(file.text)
    if ("canvas" in parsed) return canvasStructure(parsed.canvas.items)
  }
  return new Y.Text(file.text)
}

function textOf(entry: unknown): string | undefined {
  if (entry instanceof Y.Text) return entry.toString()
  if (entry instanceof Y.Map) return canvasText(entry)
  return undefined
}

function sameFile(left: LiveFile, right: LiveFile): boolean {
  if ("text" in left) return "text" in right && left.text === right.text
  return "file" in right && sameRef(left.file, right.file)
}

function sameRef(entry: unknown, file: FileRef): boolean {
  if (typeof entry !== "object" || entry === null || entry instanceof Y.AbstractType) return false
  return JSON.stringify(sortedEntries(entry)) === JSON.stringify(sortedEntries(file))
}

function sortedEntries(value: object): [string, unknown][] {
  return Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))
}

/** Replaces a text's content by the fewest edits, so concurrent edits elsewhere in it stay. */
export function patchText(text: Y.Text, to: string): void {
  const edits = diffText(text.toString(), to)
  for (const edit of edits.reverse()) {
    if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
    if (edit.insert) text.insert(edit.start, edit.insert)
  }
}

/** Replaces an array's content by the fewest edits. */
function patchArray(array: Y.Array<string>, to: readonly string[]): void {
  const hunks = diffSequences(array.toArray(), to)
  for (const hunk of hunks.reverse()) {
    if (hunk.aEnd > hunk.aStart) array.delete(hunk.aStart, hunk.aEnd - hunk.aStart)
    if (hunk.bEnd > hunk.bStart) array.insert(hunk.aStart, to.slice(hunk.bStart, hunk.bEnd))
  }
}

// ── The canvas's structure ───────────────────────────────────────────────

function canvasStructure(items: readonly CanvasItem[]): Y.Map<unknown> {
  const structure = new Y.Map<unknown>()
  const byId = new Y.Map<Y.Map<unknown>>()
  for (const item of items) byId.set(item.id, itemMap(item))
  const order = new Y.Array<string>()
  order.push(items.map((item) => item.id))
  structure.set("items", byId)
  structure.set("order", order)
  return structure
}

function itemMap(item: CanvasItem): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(item)) map.set(key, itemValue(key, value))
  return map
}

function itemValue(key: string, value: unknown): unknown {
  return CANVAS_TEXT_KEYS.has(key) && typeof value === "string" ? new Y.Text(value) : value
}

function itemObject(map: Y.Map<unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = {}
  map.forEach((value, key) => {
    item[key] = value instanceof Y.Text ? value.toString() : value
  })
  return item
}

/** `canvas.json` as a canvas's structure holds it now. */
function canvasText(structure: Y.Map<unknown>): string {
  const byId = structure.get("items") as Y.Map<Y.Map<unknown>>
  const order = structure.get("order") as Y.Array<string>

  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of [...order.toArray(), ...[...byId.keys()].sort()]) {
    if (seen.has(id) || !byId.has(id)) continue
    const item = byId.get(id) as Y.Map<unknown>
    // A note or a text someone just added and is still typing its first words into has none
    // yet: it is written once it has them, and thrown away if it never does.
    if (unwritten(item)) continue
    seen.add(id)
    ids.push(id)
  }

  // Someone deleted the item an arrow joins while another drew it: the arrow goes with it.
  const items = ids.map((id) => itemObject(byId.get(id) as Y.Map<unknown>))
  const joined = (end: unknown) => typeof end !== "string" || seen.has(end)
  const kept = items.filter(
    (item) => item.type !== "arrow" || (joined(item.from) && joined(item.to))
  )
  return formatCanvas({ items: kept as unknown as CanvasItem[] })
}

/** Whether an item is a note or a text without words yet. */
function unwritten(item: Y.Map<unknown>): boolean {
  const type = item.get("type")
  if (type !== "note" && type !== "text") return false
  const text = item.get("text")
  return (
    (text instanceof Y.Text ? text.toString() : typeof text === "string" ? text : "").trim() === ""
  )
}

/**
 * Applies to a canvas's structure what changed from `base` to `next`: items added and deleted by
 * id, each changed key of an item, the words in them merged as text, and the order. False when
 * `next` does not parse: the caller then holds it as text.
 */
function mergeCanvas(structure: Y.Map<unknown>, baseText: string, nextText: string): boolean {
  const next = parseCanvas(nextText)
  if (!("canvas" in next)) return false
  const parsedBase = parseCanvas(baseText)
  const base = "canvas" in parsedBase ? parsedBase.canvas.items : []

  const byId = structure.get("items") as Y.Map<Y.Map<unknown>>
  const order = structure.get("order") as Y.Array<string>
  const baseById = new Map(base.map((item) => [item.id, item]))
  const nextById = new Map(next.canvas.items.map((item) => [item.id, item]))

  for (const [id, item] of nextById) {
    const before = baseById.get(id)
    const current = byId.get(id)
    if (!before || !current) {
      // Added by `next`; one deleted meanwhile that `next` kept stays deleted.
      if (!before) byId.set(id, itemMap(item))
      continue
    }
    mergeItem(current, before, item)
  }
  for (const id of baseById.keys()) {
    if (!nextById.has(id)) byId.delete(id)
  }

  const merged = mergeSequences(
    base.map((item) => item.id),
    order.toArray(),
    next.canvas.items.map((item) => item.id),
    interleave
  )
  const seen = new Set<string>()
  patchArray(
    order,
    merged.filter((id) => {
      if (seen.has(id) || !byId.has(id)) return false
      seen.add(id)
      return true
    })
  )
  return true
}

/** Applies to an item each key that changed from `base` to `next`. */
function mergeItem(current: Y.Map<unknown>, base: CanvasItem, next: CanvasItem): void {
  const before = base as unknown as Record<string, unknown>
  const after = next as unknown as Record<string, unknown>

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key]
    const value = after[key]
    if (JSON.stringify(was) === JSON.stringify(value)) continue

    if (value === undefined) {
      current.delete(key)
      continue
    }

    const words = current.get(key)
    if (CANVAS_TEXT_KEYS.has(key) && typeof value === "string" && words instanceof Y.Text) {
      patchText(words, mergeText(typeof was === "string" ? was : "", words.toString(), value))
      continue
    }
    current.set(key, itemValue(key, value))
  }
}
