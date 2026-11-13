import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse, parseFragment } from "parse5"
import * as Y from "yjs"
import { type BlockMark, type BlockNode, blocksFromY, blocksToY, patchBlocks } from "./blocks"

// A designed document's page as blocks, which its editor edits in the document's frame: its
// `<body>` as a tree of the elements it is made of, each kept as its source wrote it, so that
// writing the blocks back gives the source again, byte for byte, until someone changes one.
//
//   doc ─ box{tag, open, close, before, end}          an element holding blocks: <section>, <ul>
//         textBlock{tag, open, close, before, inner}  an element holding words: <p>, <h2>, <li>
//         image{source, before}                       an <img> among blocks
//         raw{source, before}                         anything else, kept as it was
//   inline ─ text · hardBreak{source} · rawInline{source}
//   marks ─ one per inline tag (a, span, strong, em…){open, close}
//
// `open` and `close` are the element's tags as the source wrote them (`close` is empty where the
// end tag is implied), `before` the whitespace before it, `end` the whitespace before a box's end
// tag. A text's words are spaced as they show, each run of whitespace one space; `inner` keeps
// them as the source wrote them, and is written back for as long as they read the same.
//
// Whatever does not fit, words beside blocks, a field of live data, a list repeated per item, an
// element whose markup the parser mended, is a `raw` block or a `rawInline` written back as it
// was: editors move, copy and delete it, but not into it. Each element is written back and
// compared with its source as it is read; one that does not come back the same is read as raw, so
// what is not changed is never rewritten.
//
// The page is held live as `{ head, body, tail }` (`pageEntry`): what comes before the body's
// first block, the blocks as a `Y.XmlFragment`, and what follows its last.

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode

/** A page as its editor holds it. */
export interface PageBlocks {
  /** The source up to the body's first block: the head and the `<body>` tag. */
  readonly head: string
  readonly blocks: readonly BlockNode[]
  /** The source after the body's last block. */
  readonly tail: string
}

/**
 * The inline tags a text's words are formatted by, each a mark, outermost first: a link holds
 * whatever formats its words.
 */
export const PAGE_MARK_TAGS = [
  "a",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "code",
  "abbr",
  "cite",
  "q",
  "dfn",
  "kbd",
  "samp",
  "var",
  "time",
  "data",
  "bdi",
  "bdo",
] as const

/** Elements whose words are a block of text even when empty: an empty one takes typing. */
export const PAGE_TEXT_TAGS: ReadonlySet<string> = new Set([
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
  "caption",
  "pre",
  "summary",
  "legend",
  "address",
])

/** Elements that are never edited inside: what they show is not words. */
const OPAQUE = new Set([
  "script",
  "style",
  "template",
  "noscript",
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
  "button",
  "form",
  "hr",
  "colgroup",
  "col",
  "wbr",
  "br",
])

/** Elements that sit among words: inline content, as HTML lays it out. */
const PHRASING = new Set([
  ...PAGE_MARK_TAGS,
  "br",
  "wbr",
  "img",
  "svg",
  "math",
  "input",
  "button",
  "select",
  "textarea",
  "label",
  "output",
  "meter",
  "progress",
  "picture",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "font",
  "nobr",
  "ruby",
  "rt",
  "rp",
  "slot",
])

const MARK_RANK: ReadonlyMap<string, number> = new Map(PAGE_MARK_TAGS.map((tag, at) => [tag, at]))

/** Whitespace as HTML collapses it: not the no-break space. */
const COLLAPSIBLE = /[ \t\n\r\f]+/g

// ── Source → blocks ─────────────────────────────────────────────────────

/**
 * A page's blocks, or null when its source is not one an editor can hold whole: no `<body>` tag
 * of its own, or markup the parser moved about at its top level.
 */
export function pageBlocks(source: string): PageBlocks | null {
  const document = parse(source, { sourceCodeLocationInfo: true })
  const html = document.childNodes.find(isElement)
  const body = html?.childNodes.find(
    (child): child is Element => isElement(child) && child.tagName === "body"
  )
  const start = body?.sourceCodeLocation?.startTag?.endOffset
  if (!body || start === undefined) return null

  const children = body.childNodes
  for (const child of children) {
    const location = child.sourceCodeLocation
    if (!location || location.startOffset < start) return null
  }
  // The parser moves what follows `</body>` into the body: nothing but whitespace, which ends up
  // in the tail, may sit past it.
  const end = body.sourceCodeLocation?.endTag?.startOffset
  const past = (child: ChildNode) =>
    end !== undefined && endOf(child) > end && !(isText(child) && child.value.trim() === "")
  if (children.some(past)) return null

  const read = childBlocks(children, source, start, { stray: true })
  if (!read) return null
  const page = {
    head: source.slice(0, start),
    blocks: read.blocks,
    tail: source.slice(start + read.length - read.trailing.length),
  }
  // Each block came back as its source; the whole page must too.
  return pageHtml(page) === source ? page : null
}

/**
 * The blocks among `children`, which start at `from` in the source: the whitespace between them
 * goes to the block after it, and what follows the last is `trailing`. Words among blocks make
 * the children unreadable as blocks, unless `stray` reads each run of them as a raw block.
 */
function childBlocks(
  children: readonly ChildNode[],
  source: string,
  from: number,
  options: { readonly stray: boolean }
): { blocks: BlockNode[]; trailing: string; length: number } | null {
  const blocks: BlockNode[] = []
  let at = from
  let before = ""
  let stray = null as { start: number; end: number } | null
  const flushStray = () => {
    if (!stray) return
    blocks.push(rawBlock(source.slice(stray.start, stray.end), before))
    before = ""
    stray = null
  }

  for (const child of children) {
    const start = startOf(child)
    const end = endOf(child)
    if (start !== at) return null
    at = end

    if (isText(child)) {
      if (child.value.trim() === "" && !stray) {
        before += source.slice(start, end)
        continue
      }
      if (!options.stray) return null
      stray = { start: stray?.start ?? start, end }
      continue
    }
    if (stray) {
      if (!options.stray) return null
      flushStray()
    }
    const block = blockOf(child, source, before)
    if (!block) return null
    blocks.push(block)
    before = ""
  }
  flushStray()
  return { blocks, trailing: before, length: at - from }
}

/** A node among blocks as a block. */
function blockOf(node: ChildNode, source: string, before: string): BlockNode | null {
  const slice = source.slice(startOf(node), endOf(node))
  if (!isElement(node)) return rawBlock(slice, before)

  const tag = node.tagName
  const location = node.sourceCodeLocation
  if (!location?.startTag || !locatedThroughout(node) || isOpaque(node)) {
    return rawBlock(slice, before)
  }
  if (tag === "img") return { type: "image", attrs: { source: slice, before } }

  const open = source.slice(location.startTag.startOffset, location.startTag.endOffset)
  const close = location.endTag
    ? source.slice(location.endTag.startOffset, location.endTag.endOffset)
    : ""
  const innerStart = location.startTag.endOffset
  const innerEnd = location.endTag?.startOffset ?? endOf(node)
  const inner = source.slice(innerStart, innerEnd)
  const empty = node.childNodes.every((child) => isText(child) && child.value.trim() === "")

  // Words, with what formats them: a block of text, unless it holds no words, only pictures.
  if (!empty || PAGE_TEXT_TAGS.has(tag)) {
    const content = inlineOf(node.childNodes, source, tag === "pre")
    const words = content?.some((each) => each.type === "text" && /[^ ]/.test(each.text ?? ""))
    if (content && (words || PAGE_TEXT_TAGS.has(tag))) {
      const block: BlockNode = {
        type: "textBlock",
        attrs: { tag, open, close, before, inner },
        ...(content.length > 0 ? { content } : {}),
      }
      // Read alone, its words must read as they did in the page.
      return innerOf(block, tag) === inner ? block : rawBlock(slice, before)
    }
  }
  if (empty) return rawBlock(slice, before)

  // Blocks: each written back as its source, or the whole is raw.
  const read = childBlocks(node.childNodes, source, innerStart, { stray: false })
  if (!read || read.blocks.length === 0) return rawBlock(slice, before)
  const box: BlockNode = {
    type: "box",
    attrs: { tag, open, close, before, end: read.trailing },
    content: read.blocks,
  }
  return writeBlock(box, null) === before + slice ? box : rawBlock(slice, before)
}

function rawBlock(source: string, before: string): BlockNode {
  return { type: "raw", attrs: { source, before } }
}

/**
 * The inline content of `children`: words, with their marks, and the line breaks and anything
 * else inline among them, raw; null when a block is among them. Words are spaced as they show,
 * except in `<pre>`.
 */
function inlineOf(
  children: readonly ChildNode[],
  source: string,
  pre: boolean
): BlockNode[] | null {
  const nodes: BlockNode[] = []
  const visit = (each: readonly ChildNode[], marks: readonly BlockMark[]): boolean => {
    for (const child of each) {
      const slice = () => source.slice(startOf(child), endOf(child))
      if (isText(child)) {
        nodes.push(textNode(child.value, marks))
        continue
      }
      if (!isElement(child)) {
        // A comment shows nothing: it parts no words.
        nodes.push({ type: "rawInline", attrs: { source: slice(), hidden: true } })
        continue
      }
      const tag = child.tagName
      const location = child.sourceCodeLocation
      if (!location?.startTag || (!PHRASING.has(tag) && !isCustom(tag))) return false
      if (!locatedThroughout(child)) return false
      if (tag === "br") {
        nodes.push({ type: "hardBreak", attrs: { source: slice() } })
        continue
      }
      const markable =
        MARK_RANK.has(tag) &&
        !isLive(child) &&
        !marks.some((mark) => mark.type === tag) &&
        child.childNodes.length > 0 &&
        holdsOnlyInline(child) &&
        formatsWords(child)
      if (!markable) {
        if (!holdsOnlyInline(child) && !isOpaque(child)) return false
        nodes.push({ type: "rawInline", attrs: { source: slice() } })
        continue
      }
      const open = source.slice(location.startTag.startOffset, location.startTag.endOffset)
      const close = location.endTag
        ? source.slice(location.endTag.startOffset, location.endTag.endOffset)
        : ""
      if (!visit(child.childNodes, [...marks, { type: tag, attrs: { open, close } }])) return false
    }
    return true
  }
  if (!visit(children, [])) return null
  return joinTexts(pre ? nodes : collapsed(nodes))
}

/**
 * Whether an inline element formats words alone: text, line breaks, and other marks that do too.
 * The editor keeps marks on words only, so one around a field or a picture, `<a><img></a>`, would
 * lose them once its block is edited: it is kept whole instead.
 */
function formatsWords(node: Element): boolean {
  return node.childNodes.every((child) => {
    if (!isElement(child)) return true
    if (child.tagName === "br") return true
    return MARK_RANK.has(child.tagName) && !isLive(child) && formatsWords(child)
  })
}

/** Whether an element holds inline content alone, all the way down. */
function holdsOnlyInline(node: Element): boolean {
  if (isOpaque(node)) return true
  return node.childNodes.every((child) => {
    if (!isElement(child)) return true
    return (PHRASING.has(child.tagName) || isCustom(child.tagName)) && holdsOnlyInline(child)
  })
}

/**
 * Words spaced as HTML shows them: each run of whitespace one space, none at the start, before a
 * line break, or at the end. A comment parts nothing; anything else inline is a word.
 */
function collapsed(nodes: readonly BlockNode[]): BlockNode[] {
  const out: BlockNode[] = []
  let after = true
  const trimEnd = () => {
    for (let at = out.length - 1; at >= 0; at -= 1) {
      const node = out[at] as BlockNode
      if (node.type === "rawInline" && node.attrs?.hidden) continue
      if (node.type !== "text") return
      const text = (node.text ?? "").replace(/ $/, "")
      out[at] = { ...node, text }
      return
    }
  }
  for (const node of nodes) {
    if (node.type === "text") {
      let text = (node.text ?? "").replace(COLLAPSIBLE, " ")
      if (after) text = text.replace(/^ /, "")
      if (text === "") continue
      after = text.endsWith(" ")
      out.push({ ...node, text })
      continue
    }
    if (node.type === "hardBreak") {
      trimEnd()
      after = true
    } else if (!(node.type === "rawInline" && node.attrs?.hidden)) {
      after = false
    }
    out.push(node)
  }
  trimEnd()
  return out
}

/** Adjacent words with the same marks as one text, as the editor holds them; none empty. */
function joinTexts(nodes: readonly BlockNode[]): BlockNode[] {
  const out: BlockNode[] = []
  for (const node of nodes) {
    const last = out.at(-1)
    if (node.type === "text" && node.text === "") continue
    if (node.type === "text" && last?.type === "text" && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: `${last.text ?? ""}${node.text ?? ""}` }
      continue
    }
    // A comment is no part of what the editor holds.
    out.push(
      node.type === "rawInline" ? { type: node.type, attrs: { source: node.attrs?.source } } : node
    )
  }
  return out
}

function textNode(text: string, marks: readonly BlockMark[]): BlockNode {
  return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text }
}

// ── Blocks → source ─────────────────────────────────────────────────────

/** A page's source: its head, its blocks as they are now, and its tail. */
export function pageHtml(page: PageBlocks): string {
  return page.head + writeChildren(page.blocks, null) + page.tail
}

/**
 * Blocks as source. A block an editor made has no `before`: it is spaced as the block before it
 * is, or one step in from the box it starts.
 */
function writeChildren(blocks: readonly BlockNode[], parentBefore: string | null): string {
  let previous: string | null = null
  let out = ""
  for (const block of blocks) {
    const before: string =
      stringAttr(block, "before") ?? previous ?? (parentBefore ? indented(parentBefore) : "")
    out += writeBlock(block, before)
    previous = before
  }
  return out
}

function writeBlock(block: BlockNode, spaced: string | null): string {
  const before = spaced ?? stringAttr(block, "before") ?? ""
  switch (block.type) {
    case "box": {
      const tag = stringAttr(block, "tag") ?? "div"
      const end = stringAttr(block, "end") ?? (before.includes("\n") ? before : "")
      const children = writeChildren(block.content ?? [], before)
      return `${before}${openOf(block, tag)}${children}${end}${closeOf(block, tag)}`
    }
    case "textBlock": {
      const tag = stringAttr(block, "tag") ?? "p"
      return `${before}${openOf(block, tag)}${innerOf(block, tag)}${closeOf(block, tag)}`
    }
    default:
      return `${before}${stringAttr(block, "source") ?? ""}`
  }
}

function openOf(block: BlockNode, tag: string): string {
  return stringAttr(block, "open") ?? `<${tag}>`
}

function closeOf(block: BlockNode, tag: string): string {
  const close = stringAttr(block, "close")
  return close === null ? `</${tag}>` : close
}

/** A text block's words as source: as the source wrote them, while they read the same. */
function innerOf(block: BlockNode, tag: string): string {
  // The parser drops a newline right after `<pre>`: one the words start with is written twice.
  const words = inlineHtml(block.content ?? [])
  const written = tag === "pre" && /^\r?\n/.test(words) ? `\n${words}` : words
  const inner = stringAttr(block, "inner")
  if (inner !== null && canonicalInner(inner, tag) === written) return inner
  return written
}

/** What `inner` reads as, written as the editor would write it; cached, as it is asked often. */
const canonical = new Map<string, string | null>()
function canonicalInner(inner: string, tag: string): string | null {
  const key = `${tag}\u0000${inner}`
  const known = canonical.get(key)
  if (known !== undefined) return known
  if (canonical.size > 4000) canonical.clear()

  // Read in place, the parser drops a newline right after `<pre>`; read alone, it would not.
  const words = tag === "pre" ? inner.replace(/^\r?\n/, "") : inner
  const context = defaultTreeAdapter.createElement(tag, HTML_NAMESPACE, [])
  const fragment = parseFragment(context, words, { sourceCodeLocationInfo: true })
  const content = inlineOf(fragment.childNodes, words, tag === "pre")
  const html = content ? inlineHtml(content) : null
  const written = html !== null && tag === "pre" && /^\r?\n/.test(html) ? `\n${html}` : html
  canonical.set(key, written)
  return written
}

/** Inline content as source, each mark opened where it starts and closed where it ends. */
function inlineHtml(nodes: readonly BlockNode[]): string {
  let out = ""
  let open: BlockMark[] = []
  for (const node of nodes) {
    const marks = sortedMarks(node.type === "text" ? (node.marks ?? []) : [])
    let common = 0
    while (common < open.length && common < marks.length && sameMark(open[common], marks[common])) {
      common += 1
    }
    // Inline atoms close nothing that wraps them: they take the marks around them.
    const keep = node.type === "text" ? common : open.length
    for (const mark of open.slice(keep).reverse()) out += markClose(mark)
    open = open.slice(0, keep)
    if (node.type !== "text") {
      out += stringAttr(node, "source") ?? (node.type === "hardBreak" ? "<br>" : "")
      continue
    }
    for (const mark of marks.slice(common)) out += markOpen(mark)
    open = [...open, ...marks.slice(common)]
    out += escapeText(node.text ?? "")
  }
  for (const mark of open.reverse()) out += markClose(mark)
  return out
}

function markOpen(mark: BlockMark): string {
  const open = mark.attrs?.open
  return typeof open === "string" && open !== "" ? open : `<${mark.type}>`
}

function markClose(mark: BlockMark): string {
  const close = mark.attrs?.close
  return typeof close === "string" && close !== "" ? close : `</${mark.type}>`
}

function sortedMarks(marks: readonly BlockMark[]): BlockMark[] {
  return [...marks].sort(
    (left, right) => (MARK_RANK.get(left.type) ?? 99) - (MARK_RANK.get(right.type) ?? 99)
  )
}

function sameMark(left: BlockMark | undefined, right: BlockMark | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.type === right.type &&
    left.attrs?.open === right.attrs?.open &&
    left.attrs?.close === right.attrs?.close
  )
}

function sameMarks(
  left: readonly BlockMark[] | undefined,
  right: readonly BlockMark[] | undefined
): boolean {
  const a = sortedMarks(left ?? [])
  const b = sortedMarks(right ?? [])
  return a.length === b.length && a.every((mark, at) => sameMark(mark, b[at]))
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;")
}

/** One step in from `before`: its last line's indent, and two spaces more. */
function indented(before: string): string {
  const line = before.lastIndexOf("\n")
  return line < 0 ? "" : `${before.slice(line)}  `
}

function stringAttr(node: BlockNode, name: string): string | null {
  const value = node.attrs?.[name]
  return typeof value === "string" ? value : null
}

// ── The live page ───────────────────────────────────────────────────────

/** The fragment of a live page that holds its blocks. */
export const PAGE_BODY = "body"

/**
 * A page held live: `{ head, body, tail }`, its blocks a `Y.XmlFragment` its editor's collaboration
 * reads and writes. Null when its source is not one an editor can hold whole.
 */
export function pageEntry(source: string): Y.Map<unknown> | null {
  const page = pageBlocks(source)
  if (!page) return null
  const entry = new Y.Map<unknown>()
  const body = new Y.XmlFragment()
  body.insert(0, blocksToY(page.blocks))
  entry.set("head", page.head)
  entry.set(PAGE_BODY, body)
  entry.set("tail", page.tail)
  return entry
}

/**
 * Two blocks are the same when they write the same source, whatever their spacing or the source
 * their words were read from: a paragraph someone typed in reads the same as the source written
 * from it, and stays the element they type in. A box is patched inside when its tags are the same.
 */
const PAGE_PATCH = {
  key: (node: BlockNode) => writeBlock(node, ""),
  shell: (node: BlockNode) =>
    `${node.type}\u0000${stringAttr(node, "open")}\u0000${stringAttr(node, "close")}`,
}

/** Whether a document's entry is a live page. */
export function isPageEntry(entry: unknown): entry is Y.Map<unknown> {
  return entry instanceof Y.Map && entry.get(PAGE_BODY) instanceof Y.XmlFragment
}

/** The source a live page holds now. */
export function pageEntryHtml(entry: Y.Map<unknown>): string {
  const body = entry.get(PAGE_BODY) as Y.XmlFragment
  return pageHtml({
    head: String(entry.get("head") ?? ""),
    blocks: blocksFromY(body.toArray()),
    tail: String(entry.get("tail") ?? ""),
  })
}

/**
 * Makes a live page hold `source` by the fewest changes to its blocks, as `patchBlocks` makes
 * them. False, changing nothing, when `source` is not one an editor can hold whole.
 */
export function patchPageEntry(entry: Y.Map<unknown>, source: string): boolean {
  const page = pageBlocks(source)
  if (!page) return false
  if (entry.get("head") !== page.head) entry.set("head", page.head)
  if (entry.get("tail") !== page.tail) entry.set("tail", page.tail)
  const body = entry.get(PAGE_BODY) as Y.XmlFragment
  patchBlocks(body, page.blocks, PAGE_PATCH)
  respace(body, page.blocks)
  return true
}

/**
 * Gives the blocks a patch kept the spacing `next` writes them with: blocks are compared without
 * it, so the paragraph someone types in stays theirs, but a write that only spaces them anew still
 * reaches the page.
 */
function respace(parent: Y.XmlFragment, next: readonly BlockNode[]): void {
  const elements = parent.toArray()
  if (elements.length !== next.length) return
  elements.forEach((element, at) => {
    const block = next[at] as BlockNode
    if (!(element instanceof Y.XmlElement) || element.nodeName !== block.type) return
    for (const name of ["before", "end"]) {
      const value = block.attrs?.[name]
      if (typeof value === "string" && element.getAttribute(name) !== value) {
        element.setAttribute(name, value)
      }
    }
    if (block.type === "box") respace(element, block.content ?? [])
  })
}

// ── The parse tree ──────────────────────────────────────────────────────

const HTML_NAMESPACE =
  "http://www.w3.org/1999/xhtml" as DefaultTreeAdapterTypes.Element["namespaceURI"]

function isElement(node: Node): node is Element {
  return "tagName" in node
}

function isText(node: Node): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === "#text"
}

function isCustom(tag: string): boolean {
  return tag.includes("-")
}

/** A field of live data, or an element repeated per item: what it shows is not its words. */
function isLive(node: Element): boolean {
  return node.attrs.some(
    (attribute) => attribute.name === "data-sixb-field" || attribute.name === "data-sixb-each"
  )
}

function isOpaque(node: Element): boolean {
  return (
    OPAQUE.has(node.tagName) ||
    isCustom(node.tagName) ||
    node.namespaceURI !== HTML_NAMESPACE ||
    isLive(node)
  )
}

/** Whether every node inside an element is where the source has it: none the parser made up. */
function locatedThroughout(node: Element): boolean {
  return node.childNodes.every(
    (child) =>
      child.sourceCodeLocation !== undefined &&
      child.sourceCodeLocation !== null &&
      (!isElement(child) || locatedThroughout(child))
  )
}

function startOf(node: ChildNode): number {
  return node.sourceCodeLocation?.startOffset ?? -1
}

/**
 * Where a node ends in the source. An element whose end tag is implied ends with what it holds:
 * the parser would have it end where whatever closed it does, even past `</body>`.
 */
function endOf(node: ChildNode): number {
  if (!isElement(node)) return node.sourceCodeLocation?.endOffset ?? -1
  const location = node.sourceCodeLocation
  if (!location) return -1
  if (location.endTag || !location.startTag) return location.endOffset
  const last = node.childNodes.at(-1)
  return last ? Math.max(location.startTag.endOffset, endOf(last)) : location.startTag.endOffset
}
