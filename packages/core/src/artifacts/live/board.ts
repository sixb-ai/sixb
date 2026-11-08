import { type DefaultTreeAdapterTypes, parse } from "parse5"
import type * as Y from "yjs"

// A canvas's board as an editor changes it in place: the static elements of its HTML, each at an
// address that names where it is in the source, and edits to them as changes to the source's
// text, applied to the board's `Y.Text` in the live document. What a script builds is in no
// source, so it has no address and cannot be edited. Browser-safe.

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element
type TextNode = DefaultTreeAdapterTypes.TextNode

/**
 * What an editor can do with an element:
 *
 * - `text`: type into it. Its words, with the inline tags among them, are one block of text.
 * - `image`: replace an `<img>`'s picture or its description.
 * - `whole`: something drawn whole, such as an `<svg>` or an embed; only its style changes.
 * - `box`: anything else, holding other elements; only its style changes.
 *
 * Every kind takes the style properties in {@link BOARD_STYLE_PROPERTIES}.
 */
export type BoardElementKind = "text" | "image" | "whole" | "box"

/** A static element of a board's source. */
export interface BoardElement {
  /**
   * Where it is in the source: each step its tag and its index among its siblings of that tag,
   * from the body down, as `body>main:0>h1:0`. The same source gives the same addresses.
   */
  readonly address: string
  readonly tag: string
  readonly kind: BoardElementKind
  /** Where it is in the source, from its start tag to its end tag included. */
  readonly start: number
  readonly end: number
  /** Its first words, or an image's description: what names it once it is gone. */
  readonly label: string
}

/** A change to a board's source: `remove` characters at `index`, then `insert` there. */
export interface BoardChange {
  readonly index: number
  readonly remove: number
  readonly insert: string
}

/** The changes an edit makes, in order through the source, none overlapping. */
export type BoardEdit = readonly BoardChange[]

/** The style properties an editor may set on an element. */
export const BOARD_STYLE_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "font-size",
  "font-weight",
  "text-align",
  "padding",
  "gap",
  "border-radius",
] as const

export type BoardStyleProperty = (typeof BOARD_STYLE_PROPERTIES)[number]

/** The attributes the frame sets on each addressed element of a board served for editing. */
export const BOARD_ADDRESS_ATTRIBUTE = "data-sixb-at"
export const BOARD_KIND_ATTRIBUTE = "data-sixb-edit"
/** A text element's words as the source has them, hashed: one a script rewrote is not editable. */
export const BOARD_TEXT_ATTRIBUTE = "data-sixb-text"

/** The longest label an element gets. */
const MAX_LABEL_LENGTH = 80
/** The longest value a style property takes. */
const MAX_STYLE_VALUE_LENGTH = 100

/** Elements that hold no part of what a board shows, or that scripts fill: never addressed. */
const UNADDRESSED = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "link",
  "meta",
  "base",
  "title",
])
/** Elements drawn whole: their insides are not addressed. */
const WHOLE = new Set([
  "svg",
  "math",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "picture",
  "select",
  "textarea",
  "input",
  "sixb-embed",
])
/** Tags that format words inside a block of text. */
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
])
/** Blocks meant for words: typed into even while empty, where an empty `<div>` may be a script's. */
const TEXT_BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "td",
  "th",
  "dt",
  "dd",
  "figcaption",
  "blockquote",
  "label",
  "caption",
  "button",
  "legend",
  "summary",
])

interface Located {
  readonly element: BoardElement
  readonly node: Element
}

/** Every static element of a board's source, in source order. */
export function boardElements(source: string): BoardElement[] {
  return located(source).map(({ element }) => element)
}

/** The element at an address in a board's source; null when the source has none there. */
export function boardElement(source: string, address: string): BoardElement | null {
  return located(source).find(({ element }) => element.address === address)?.element ?? null
}

/**
 * The source with each static element marked with its address, its kind, and a text element's
 * words hashed, as the frame serves a board for editing. Nothing else in it changes.
 */
export function annotateBoard(source: string): string {
  const changes: BoardChange[] = []
  for (const { element, node } of located(source)) {
    const index = startTagClose(source, node)
    if (index === null) continue

    const attributes = [
      `${BOARD_ADDRESS_ATTRIBUTE}="${escapeAttribute(element.address)}"`,
      `${BOARD_KIND_ATTRIBUTE}="${element.kind}"`,
      ...(element.kind === "text"
        ? [`${BOARD_TEXT_ATTRIBUTE}="${boardTextHash(textOf(node))}"`]
        : []),
    ]
    changes.push({ index, remove: 0, insert: ` ${attributes.join(" ")}` })
  }
  return applyBoardEdit(source, changes)
}

/**
 * Sets a text element's words. Only what changed is replaced, inside the text it falls in, so
 * the inline tags around the rest stay: typing in a bold word keeps it bold.
 */
export function setBoardText(source: string, address: string, text: string): BoardEdit {
  const { node } = elementAt(source, address, ["text"])
  const nodes = textNodes(node)
  const before = nodes.map((each) => each.value).join("")
  if (before === text) return []

  // The span that changed, between what both start and end with.
  let prefix = 0
  const most = Math.min(before.length, text.length)
  while (prefix < most && before[prefix] === text[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < most - prefix &&
    before[before.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const from = prefix
  const to = before.length - suffix
  const insert = escapeText(text.slice(prefix, text.length - suffix))

  // An element with no words yet takes them right after its start tag.
  if (nodes.length === 0) {
    const index = startTagEnd(node)
    return index === null ? [] : [{ index, remove: 0, insert }]
  }

  // The words go into the text where the change starts, after what it follows: typed at the end
  // of a bold word, they are bold too.
  const ends: number[] = []
  let total = 0
  for (const each of nodes) {
    total += each.value.length
    ends.push(total)
  }
  const into = Math.max(
    0,
    ends.findIndex((end) => from <= end)
  )

  const changes: BoardChange[] = []
  for (const [position, each] of nodes.entries()) {
    const end = ends[position] as number
    const start = end - each.value.length
    const removeFrom = Math.max(from, start)
    const removeTo = Math.min(to, end)
    const removes = removeFrom < removeTo
    const takes = position === into
    if (!takes && !removes) continue

    const raw = rawOffsets(source, each)
    if (raw) {
      const index = raw[(takes ? from : removeFrom) - start] as number
      const until = removes ? (raw[removeTo - start] as number) : index
      changes.push({ index, remove: until - index, insert: takes ? insert : "" })
      continue
    }

    // Text whose source does not map character by character onto its words, as an entity this
    // does not know: written again whole, with the change.
    const value =
      each.value.slice(0, (takes ? from : removeFrom) - start) +
      (takes ? text.slice(prefix, text.length - suffix) : "") +
      each.value.slice(removes ? removeTo - start : (takes ? from : removeFrom) - start)
    changes.push({ index: each.start, remove: each.end - each.start, insert: escapeText(value) })
  }
  return changes.filter((change) => change.remove > 0 || change.insert.length > 0)
}

/** Replaces an image's picture, its description, or both. */
export function setBoardImage(
  source: string,
  address: string,
  image: { readonly src?: string; readonly alt?: string }
): BoardEdit {
  const { node } = elementAt(source, address, ["image"])
  if (image.src !== undefined) checkImageSource(image.src)

  const changes: BoardChange[] = []
  for (const name of ["src", "alt"] as const) {
    const value = image[name]
    if (value !== undefined) changes.push(attributeChange(source, node, name, value))
  }
  return changes.sort((left, right) => left.index - right.index)
}

/**
 * Sets style properties in an element's inline style, or removes those set to `null`. The rest of
 * its style stays as it is.
 */
export function setBoardStyle(
  source: string,
  address: string,
  properties: Readonly<Partial<Record<BoardStyleProperty, string | null>>>
): BoardEdit {
  const { node } = elementAt(source, address, ["text", "image", "whole", "box"])

  const declarations = parseStyle(
    node.attrs.find((attribute) => attribute.name === "style")?.value ?? ""
  )
  for (const [name, value] of Object.entries(properties)) {
    if (!(BOARD_STYLE_PROPERTIES as readonly string[]).includes(name)) {
      throw new Error(
        `[Sixb] '${name}' is not a style a board's element takes in place: ${BOARD_STYLE_PROPERTIES.join(", ")}.`
      )
    }
    const index = declarations.findIndex(([property]) => property === name)
    if (value === null || value === undefined) {
      if (index >= 0) declarations.splice(index, 1)
      continue
    }
    const checked = checkStyleValue(name, value)
    if (index >= 0) declarations[index] = [name, checked]
    else declarations.push([name, checked])
  }

  const style = declarations.map(([property, value]) => `${property}: ${value}`).join("; ")
  if (style === "" && !node.attrs.some((attribute) => attribute.name === "style")) return []
  return [attributeChange(source, node, "style", style)]
}

/** A board's source once an edit is made to it. */
export function applyBoardEdit(source: string, edit: BoardEdit): string {
  let result = ""
  let at = 0
  for (const change of edit) {
    result += source.slice(at, change.index) + change.insert
    at = change.index + change.remove
  }
  return result + source.slice(at)
}

/**
 * Makes an edit to a board's text in the live document, in one transaction under `origin`. It
 * must be made from what the text holds now.
 */
export function applyBoardEditToText(text: Y.Text, edit: BoardEdit, origin?: unknown): void {
  if (edit.length === 0) return
  const apply = () => {
    // From the end, so each change's index still names where it was made.
    for (const change of [...edit].reverse()) {
      if (change.remove > 0) text.delete(change.index, change.remove)
      if (change.insert.length > 0) text.insert(change.index, change.insert)
    }
  }
  const doc = text.doc
  if (doc) doc.transact(apply, origin)
  else apply()
}

/** What a frame showing a board for editing changes in place, for one element. */
export interface BoardFramePatch {
  readonly address: string
  /** Every attribute it holds now, the frame's own included. */
  readonly attributes?: Readonly<Record<string, string>>
  /** What it holds now, for an element that holds no addressed element. */
  readonly html?: string
}

/**
 * What a frame showing `before` for editing changes so it shows `after`, element by element; null
 * when the elements themselves changed, added, removed or moved, and the frame loads `after`
 * instead.
 */
export function boardFramePatches(before: string, after: string): BoardFramePatch[] | null {
  if (before === after) return []
  const beforeSource = annotateBoard(before)
  const afterSource = annotateBoard(after)
  const old = located(beforeSource)
  const next = located(afterSource)
  const same =
    old.length === next.length &&
    old.every(
      ({ element }, index) =>
        element.address === next[index]?.element.address &&
        element.kind === next[index]?.element.kind
    )
  if (!same) return null

  const patches: BoardFramePatch[] = []
  for (const [index, { element, node }] of next.entries()) {
    const previous = (old[index] as Located).node
    const attributes = attributesOf(node)
    const changed = JSON.stringify(attributesOf(previous)) !== JSON.stringify(attributes)

    // What holds no addressed element is written whole. A box's own words, between its
    // children, are not: the frame loads the board again when they change.
    let html: string | undefined
    if (element.kind === "box") {
      if (ownContent(beforeSource, previous) !== ownContent(afterSource, node)) return null
    } else {
      const inner = innerOf(afterSource, node)
      if (inner !== null && innerOf(beforeSource, previous) !== inner) html = inner
    }

    if (changed || html !== undefined) {
      patches.push({
        address: element.address,
        ...(changed ? { attributes } : {}),
        ...(html === undefined ? {} : { html }),
      })
    }
  }
  return patches
}

/**
 * The hash of a text element's words that marks it in a board served for editing: FNV-1a over
 * its UTF-16 code units, in hex. The frame's runtime hashes what the element holds the same way.
 */
export function boardTextHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

/** The address an image's picture is given from a board: its file's path, from the board's folder. */
export function boardFilePath(board: string, file: string): string {
  const from = board.split("/").slice(0, -1)
  const to = file.split("/")
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1
  const path = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/")
  return path.split("/").map(encodeURIComponent).join("/")
}

// ── The source as a tree ────────────────────────────────────────────────

function located(source: string): Located[] {
  const document = parse(source, { sourceCodeLocationInfo: true })
  const html = document.childNodes.find(isElement)
  const body = html?.childNodes.find(
    (child): child is Element => isElement(child) && child.tagName === "body"
  )
  if (!body) return []

  const found: Located[] = []
  const visit = (node: Element, address: string) => {
    if (node.sourceCodeLocation?.startTag) {
      const kind = kindOf(node)
      found.push({
        node,
        element: {
          address,
          tag: node.tagName,
          kind,
          start: node.sourceCodeLocation.startOffset,
          end: node.sourceCodeLocation.endOffset,
          label: labelOf(node, kind),
        },
      })
      if (kind !== "box") return
    }

    const seen = new Map<string, number>()
    for (const child of node.childNodes) {
      if (!isElement(child) || UNADDRESSED.has(child.tagName)) continue
      const index = seen.get(child.tagName) ?? 0
      seen.set(child.tagName, index + 1)
      visit(child, `${address}>${child.tagName}:${index}`)
    }
  }
  visit(body, "body")
  return found
}

function kindOf(node: Element): BoardElementKind {
  if (node.tagName === "img") return "image"
  if (WHOLE.has(node.tagName) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    return "whole"
  }
  if (!holdsOnlyWords(node)) return "box"
  return textOf(node).trim() !== "" || TEXT_BLOCKS.has(node.tagName) || INLINE.has(node.tagName)
    ? "text"
    : "box"
}

/** Whether an element holds only words and the inline tags that format them. */
function holdsOnlyWords(node: Element): boolean {
  return node.childNodes.every((child) => {
    if (isText(child)) return true
    if (!isElement(child)) return child.nodeName === "#comment"
    return INLINE.has(child.tagName) && holdsOnlyWords(child)
  })
}

function labelOf(node: Element, kind: BoardElementKind): string {
  const words =
    kind === "image"
      ? (node.attrs.find((attribute) => attribute.name === "alt")?.value ?? "")
      : textNodes(node)
          .map((each) => each.value)
          .join(kind === "text" ? "" : " ")
  const label = words.replace(/\s+/g, " ").trim()
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label
}

function textOf(node: Element): string {
  return textNodes(node)
    .map((each) => each.value)
    .join("")
}

interface SourceText {
  readonly value: string
  readonly start: number
  readonly end: number
}

/** The texts inside an element, in order, where the source has them. */
function textNodes(node: Element): SourceText[] {
  const texts: SourceText[] = []
  const visit = (each: Node) => {
    if (isText(each)) {
      const location = each.sourceCodeLocation
      if (location)
        texts.push({ value: each.value, start: location.startOffset, end: location.endOffset })
      return
    }
    if (isElement(each) && !UNADDRESSED.has(each.tagName)) {
      for (const child of each.childNodes) visit(child)
    }
  }
  for (const child of node.childNodes) visit(child)
  return texts
}

/**
 * Where in the source each character of a text starts, and one past its end: null when the
 * source's characters do not map one by one onto the text's, as an entity the decoding here does
 * not know would.
 */
function rawOffsets(source: string, text: SourceText): number[] | null {
  const raw = source.slice(text.start, text.end)
  const offsets: number[] = []
  let decoded = ""
  let at = 0
  while (at < raw.length) {
    const entity = raw[at] === "&" ? /^&(#x[\da-f]+|#\d+|[a-z]+);/i.exec(raw.slice(at)) : null
    // The parser reads a line break as one `\n`, whether it was written `\r\n` or `\r`.
    const crlf = raw[at] === "\r" && raw[at + 1] === "\n"
    const value = entity ? decodeEntity(entity[1] as string) : raw[at] === "\r" ? "\n" : raw[at]
    const length = entity ? entity[0].length : crlf ? 2 : 1
    if (value === null || value === undefined) return null

    for (let unit = 0; unit < value.length; unit += 1) offsets.push(text.start + at)
    decoded += value
    at += length
  }
  offsets.push(text.end)
  return decoded === text.value ? offsets : null
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
}

function decodeEntity(entity: string): string | null {
  if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? null
  const codePoint =
    entity[1]?.toLowerCase() === "x"
      ? Number.parseInt(entity.slice(2), 16)
      : Number(entity.slice(1))
  // A single character only: one that takes two code units would split between them.
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint < 0x10000
    ? String.fromCharCode(codePoint)
    : null
}

/** Just past an element's start tag. */
function startTagEnd(node: Element): number | null {
  return node.sourceCodeLocation?.startTag?.endOffset ?? null
}

/** Where an attribute goes in an element's start tag: before its `>`, or its `/>`. */
function startTagClose(source: string, node: Element): number | null {
  const end = startTagEnd(node)
  if (end === null) return null
  let at = end - 1
  if (source[at - 1] === "/") at -= 1
  while (at > 0 && /\s/.test(source[at - 1] ?? "")) at -= 1
  return at
}

function attributeChange(source: string, node: Element, name: string, value: string): BoardChange {
  const written = `${name}="${escapeAttribute(value)}"`
  const location = node.sourceCodeLocation?.attrs?.[name]
  if (location) {
    return {
      index: location.startOffset,
      remove: location.endOffset - location.startOffset,
      insert: written,
    }
  }
  const index = startTagClose(source, node)
  if (index === null) throw new Error("[Sixb] This element has no start tag in the board's source.")
  return { index, remove: 0, insert: ` ${written}` }
}

function attributesOf(node: Element): Record<string, string> {
  return Object.fromEntries(node.attrs.map((attribute) => [attribute.name, attribute.value]))
}

/** What an element holds in the source, between its tags; null for one with no end tag. */
function innerOf(source: string, node: Element): string | null {
  const location = node.sourceCodeLocation
  const start = location?.startTag?.endOffset
  const end = location?.endTag?.startOffset
  if (start === undefined) return null
  return source.slice(start, end ?? location?.endOffset ?? start)
}

/** What a box holds in the source besides its addressed children. */
function ownContent(source: string, node: Element): string | null {
  const inner = innerOf(source, node)
  const start = node.sourceCodeLocation?.startTag?.endOffset
  if (inner === null || start === undefined) return inner

  let own = ""
  let at = start
  for (const child of node.childNodes) {
    if (!isElement(child) || UNADDRESSED.has(child.tagName) || !child.sourceCodeLocation) continue
    own += source.slice(at, child.sourceCodeLocation.startOffset)
    at = child.sourceCodeLocation.endOffset
  }
  return own + source.slice(at, start + inner.length)
}

function elementAt(source: string, address: string, kinds: readonly BoardElementKind[]): Located {
  const found = located(source).find(({ element }) => element.address === address)
  if (!found) {
    throw new Error(
      `[Sixb] The board holds no element at '${address}': it changed, or a script builds it.`
    )
  }
  if (!kinds.includes(found.element.kind)) {
    throw new Error(
      `[Sixb] The element at '${address}' is ${articled(found.element.kind)}: it takes no such edit.`
    )
  }
  return found
}

function articled(kind: BoardElementKind): string {
  return { text: "text", image: "an image", whole: "drawn whole", box: "a box of elements" }[kind]
}

/** Declarations of an inline style, in order. */
function parseStyle(style: string): [string, string][] {
  const declarations: [string, string][] = []
  let depth = 0
  let quote: string | null = null
  let current = ""
  const flush = () => {
    const colon = current.indexOf(":")
    if (colon > 0) {
      const property = current.slice(0, colon).trim().toLowerCase()
      const value = current.slice(colon + 1).trim()
      if (property && value) declarations.push([property, value])
    }
    current = ""
  }
  for (const char of style) {
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (char === ";" && depth === 0) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return declarations
}

function checkStyleValue(property: string, value: string): string {
  const trimmed = value.trim()
  if (
    trimmed === "" ||
    trimmed.length > MAX_STYLE_VALUE_LENGTH ||
    /[;{}<>"'\\]|\/\*|url\s*\(|expression\s*\(|@/i.test(trimmed)
  ) {
    throw new Error(`[Sixb] '${value}' is not a value '${property}' takes in place.`)
  }
  return trimmed
}

function checkImageSource(src: string): void {
  const trimmed = src.trim()
  if (
    trimmed === "" ||
    trimmed.length > 2048 ||
    /^(javascript|vbscript|data:text)/i.test(trimmed.replace(/[\s\u0000-\u001f]/g, ""))
  ) {
    throw new Error(`[Sixb] '${src}' is not a picture a board's image shows.`)
  }
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function isElement(node: Node): node is Element {
  return "tagName" in node
}

function isText(node: Node): node is TextNode {
  return node.nodeName === "#text"
}
