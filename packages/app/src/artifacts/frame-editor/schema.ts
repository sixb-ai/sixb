import { PAGE_MARK_TAGS, PAGE_TEXT_TAGS } from "@sixb/core/artifacts/live"
import { type Attrs, type MarkSpec, type Node, type NodeSpec, Schema } from "../editor/core/model"

// A designed document's page as the editor's schema: the nodes and marks core's
// `artifacts/live/page.ts` reads the page's body into, with the same names and attributes, so the
// live document's `Y.XmlFragment` is what both read and write. Each element is drawn with its own
// tag and the attributes its source gave it, so the page's stylesheets style it as they style the
// page; what the editor does not model is drawn from its source, and takes no typing.

/** A node's attributes: none the editor gives a value the server did not, so none is rewritten. */
function attributes(
  names: readonly string[],
  defaults: Readonly<Record<string, string>> = {}
): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, defaults[name] ?? null]))
}

/** What an element pasted gives its node: what the rule reads, and nothing else it carries. */
function parsed(
  read: Record<string, unknown>,
  names: readonly string[],
  element: HTMLElement
): Attrs {
  const attrs: Record<string, unknown> = { ...read }
  for (const name of names) {
    const value = element.getAttribute(name)
    if (value !== null && !(name in attrs)) attrs[name] = value
  }
  return attrs
}

/** The attributes the source wrote in a start tag, read once for each tag written the same. */
const attributeCache = new Map<string, Record<string, string>>()
export function tagAttributes(open: string | null | undefined): Record<string, string> {
  if (!open) return {}
  const known = attributeCache.get(open)
  if (known) return known
  if (attributeCache.size > 2000) attributeCache.clear()

  // A tag's attributes as the browser reads them, from a template, where nothing runs or loads.
  const template = document.createElement("template")
  const tag = /^<([a-zA-Z][\w-]*)/.exec(open)?.[1] ?? "span"
  template.innerHTML = `${open}</${tag}>`
  const element = template.content.firstElementChild
  const read: Record<string, string> = {}
  for (const attribute of Array.from(element?.attributes ?? [])) {
    if (drawable(attribute.name, attribute.value)) read[attribute.name] = attribute.value
  }
  attributeCache.set(open, read)
  return read
}

/**
 * Whether an attribute is drawn in the frame. The live document is anyone's who may edit it, and
 * publishing's checks have not seen it: an event handler, or an address that runs script, would
 * run in each reader's frame, beside the editor and its port. They are kept in the source.
 */
export function drawable(name: string, value: string): boolean {
  if (/^on/i.test(name)) return false
  if (/^(href|src|action|formaction|xlink:href|srcdoc|data)$/i.test(name)) {
    // As browsers read an address: without the whitespace and control characters within it.
    const address = value.replace(/[\u0000-\u0020\u007f]/g, "")
    return !/^(javascript|vbscript):/i.test(address) && name.toLowerCase() !== "srcdoc"
  }
  return true
}

/** Elements never drawn in the frame: they run script, load a page, or change the frame's own. */
const UNDRAWN =
  /^(script|iframe|object|embed|base|meta|link|form|frame|frameset|portal|noscript|template|set|animate|animatemotion|animatetransform)$/i

/** The tag a node of the page is drawn as: its own, unless it is one never drawn. */
export function drawnTag(tag: unknown): string {
  const name = String(tag ?? "")
  return /^[a-z][a-z0-9-]*$/i.test(name) && !UNDRAWN.test(name) ? name : "div"
}

/** Removes from markup drawn in the frame whatever could run script: see `drawable`. */
export function sanitize(root: DocumentFragment | Element): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (UNDRAWN.test(element.localName)) {
      element.remove()
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!drawable(attribute.name, attribute.value)) element.removeAttribute(attribute.name)
    }
  }
}

/** A start tag for `tag` with `attrs`, as an editor writes one. */
export function startTag(tag: string, attrs: Readonly<Record<string, string>> = {}): string {
  const written = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("")
  return `<${tag}${written}>`
}

/** The tag an element's start tag names. */
function tagOf(element: HTMLElement): string {
  return element.tagName.toLowerCase()
}

/** An element's start tag as the source would write it, for what is pasted, without the editor's marks. */
function openOf(element: HTMLElement): string {
  const copy = element.cloneNode(false) as HTMLElement
  for (const name of copy.getAttributeNames()) {
    if (
      name === "data-pm-slice" ||
      name.startsWith("data-sixb-raw") ||
      name === "contenteditable"
    ) {
      copy.removeAttribute(name)
    }
  }
  const html = copy.outerHTML
  return html.slice(0, html.indexOf(">") + 1)
}

/** Elements that hold blocks, read as boxes when pasted. */
const CONTAINER_TAGS: ReadonlySet<string> = new Set([
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "ul",
  "ol",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "figure",
  "details",
  "fieldset",
  "hgroup",
  "search",
])

/** Whether a pasted element holds blocks: an element among its children that is not inline. */
function holdsBlocks(element: HTMLElement): boolean {
  return Array.from(element.children).some((child) => {
    const tag = child.localName
    return CONTAINER_TAGS.has(tag) || PAGE_TEXT_TAGS.has(tag) || tag === "hr" || tag === "img"
  })
}

const BOX_ATTRS = ["tag", "open", "close", "before", "end"]
const TEXT_ATTRS = ["tag", "open", "close", "before", "inner"]

/** An element holding blocks: a section, a list, a table and its rows. */
const box: NodeSpec = {
  group: "block",
  content: "block+",
  defining: true,
  attrs: attributes(BOX_ATTRS, { tag: "div" }),
  parseDOM: [
    {
      // What is pasted: a container, or an element of words that holds blocks, a list item
      // holding paragraphs. Anything else gives its content alone.
      tag: "*",
      priority: 10,
      getAttrs: (dom) => {
        const element = dom as HTMLElement
        const tag = tagOf(element)
        const isBox = CONTAINER_TAGS.has(tag) || (PAGE_TEXT_TAGS.has(tag) && holdsBlocks(element))
        return isBox ? parsed({ tag, open: openOf(element) }, BOX_ATTRS, element) : false
      },
    },
  ],
  toDOM: (node) => [
    drawnTag(node.attrs.tag),
    { ...tagAttributes(node.attrs.open as string | null) },
    0,
  ],
}

/** An element holding words: a paragraph, a heading, a list item, a table's cell. */
const textBlock: NodeSpec = {
  group: "block",
  content: "inline*",
  defining: true,
  attrs: attributes(TEXT_ATTRS, { tag: "p" }),
  parseDOM: [
    {
      tag: [...PAGE_TEXT_TAGS].join(","),
      getAttrs: (dom) => {
        const element = dom as HTMLElement
        return holdsBlocks(element)
          ? false
          : parsed({ tag: tagOf(element), open: openOf(element) }, TEXT_ATTRS, element)
      },
    },
  ],
  toDOM: (node) => [
    drawnTag(node.attrs.tag),
    { ...tagAttributes(node.attrs.open as string | null) },
    0,
  ],
}

/** A picture among blocks. */
const image: NodeSpec = {
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  attrs: attributes(["source", "before"]),
  parseDOM: [
    {
      tag: "img[src]",
      getAttrs: (dom) =>
        parsed({ source: (dom as HTMLElement).outerHTML }, ["before"], dom as HTMLElement),
    },
  ],
  toDOM: (node) => ["img", { ...tagAttributes(node.attrs.source as string | null) }],
}

/** Anything else among blocks, kept as its source wrote it. */
const raw: NodeSpec = {
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  attrs: attributes(["source", "before"]),
  parseDOM: [
    // As the clipboard writes it: its source as words. Before the rules for the tags it is drawn as.
    {
      tag: "[data-sixb-raw]",
      priority: 60,
      getAttrs: (dom) =>
        parsed({ source: (dom as HTMLElement).textContent ?? "" }, ["before"], dom as HTMLElement),
    },
    // A rule pasted from elsewhere, as it was written.
    {
      tag: "hr",
      getAttrs: (dom) =>
        parsed({ source: openOf(dom as HTMLElement) }, ["before"], dom as HTMLElement),
    },
  ],
  toDOM: (node) => ["div", { "data-sixb-raw": "" }, String(node.attrs.source ?? "")],
}

/** Anything inline that is not words: a field of live data, an inline picture or icon. */
const rawInline: NodeSpec = {
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: attributes(["source"]),
  parseDOM: [
    {
      tag: "[data-sixb-raw-inline]",
      priority: 60,
      getAttrs: (dom) => ({ source: (dom as HTMLElement).textContent ?? "" }),
    },
  ],
  toDOM: (node) => ["span", { "data-sixb-raw-inline": "" }, String(node.attrs.source ?? "")],
}

/** A line break among words. */
const hardBreak: NodeSpec = {
  group: "inline",
  inline: true,
  selectable: false,
  attrs: attributes(["source"]),
  parseDOM: [{ tag: "br", getAttrs: (dom) => parsed({}, ["source"], dom as HTMLElement) }],
  toDOM: () => ["br"],
  leafText: () => "\n",
}

/** A mark for each inline tag, drawn as that tag with its source's attributes. */
function pageMark(tag: string): MarkSpec {
  return {
    // A link does not grow as the reader types after it.
    inclusive: tag !== "a",
    attrs: attributes(["open", "close"]),
    parseDOM: [
      {
        tag,
        getAttrs: (dom) =>
          parsed({ open: openOf(dom as HTMLElement), close: `</${tag}>` }, [], dom as HTMLElement),
      },
    ],
    toDOM: (mark) => [tag, { ...tagAttributes(mark.attrs.open as string | null) }, 0],
  }
}

/** The page's schema: what core's page reads its body into. A block of words first: what is made where a block is missing. */
export const pageSchema = new Schema({
  nodes: [
    ["doc", { content: "block+" }],
    ["text", { group: "inline" }],
    ["textBlock", textBlock],
    ["box", box],
    ["image", image],
    ["raw", raw],
    ["rawInline", rawInline],
    ["hardBreak", hardBreak],
  ],
  marks: PAGE_MARK_TAGS.map((tag) => [tag, pageMark(tag)] as const),
})

/** Whether a node is a block of words that takes typing. */
export function isWords(node: Node | null | undefined): boolean {
  return node?.type.name === "textBlock"
}
