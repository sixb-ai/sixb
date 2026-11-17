import { PAGE_MARK_TAGS, PAGE_TEXT_TAGS } from "@sixb/core/artifacts/live"
import { type AnyExtension, Mark, Node } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

// A designed document's page as the editor's schema: the nodes and marks core's
// `artifacts/live/page.ts` reads the page's body into, with the same names and attributes, so the
// live document's `Y.XmlFragment` is what both read and write. Each element is drawn with its own
// tag and the attributes its source gave it, so the page's stylesheets style it as they style the
// page; what the editor does not model is drawn from its source, and takes no typing.

/** A node's attributes: none the editor gives a value the server did not, so none is rewritten. */
function attributes(names: readonly string[], defaults: Readonly<Record<string, string>> = {}) {
  return Object.fromEntries(
    names.map((name) => [name, { default: defaults[name] ?? null, rendered: false }])
  )
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

/** The page's body: its blocks. */
const PageDocument = Node.create({ name: "doc", topNode: true, content: "block+" })

const PageText = Node.create({ name: "text", group: "inline" })

/** An element holding blocks: a section, a list, a table and its rows. */
export const Box = Node.create({
  name: "box",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => attributes(["tag", "open", "close", "before", "end"], { tag: "div" }),
  parseHTML: () => [
    {
      // What is pasted: a container, or an element of words that holds blocks, a list item
      // holding paragraphs. Anything else gives its content alone.
      tag: "*",
      priority: 10,
      getAttrs: (element) => {
        const tag = tagOf(element)
        const box = CONTAINER_TAGS.has(tag) || (PAGE_TEXT_TAGS.has(tag) && holdsBlocks(element))
        return box ? { tag, open: openOf(element) } : false
      },
    },
  ],
  renderHTML: ({ node }) => [
    drawnTag(node.attrs.tag),
    { ...tagAttributes(node.attrs.open as string | null) },
    0,
  ],
})

/** An element holding words: a paragraph, a heading, a list item, a table's cell. */
export const TextBlock = Node.create({
  name: "textBlock",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes: () => attributes(["tag", "open", "close", "before", "inner"], { tag: "p" }),
  parseHTML: () => [
    {
      tag: [...PAGE_TEXT_TAGS].join(","),
      getAttrs: (element) =>
        holdsBlocks(element) ? false : { tag: tagOf(element), open: openOf(element) },
    },
  ],
  renderHTML: ({ node }) => [
    drawnTag(node.attrs.tag),
    { ...tagAttributes(node.attrs.open as string | null) },
    0,
  ],
})

/** A picture among blocks. */
export const PageImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => attributes(["source", "before"]),
  parseHTML: () => [{ tag: "img[src]", getAttrs: (element) => ({ source: element.outerHTML }) }],
  renderHTML: ({ node }) => ["img", { ...tagAttributes(node.attrs.source as string | null) }],
})

/** Anything else among blocks, kept as its source wrote it. */
export const RawBlock = Node.create({
  name: "raw",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => attributes(["source", "before"]),
  parseHTML: () => [
    // As the clipboard writes it: its source as words. Before the rules for the tags it is drawn as.
    {
      tag: "[data-sixb-raw]",
      priority: 60,
      getAttrs: (element) => ({ source: element.textContent ?? "" }),
    },
    // A rule pasted from elsewhere, as it was written.
    { tag: "hr", getAttrs: (element) => ({ source: openOf(element) }) },
  ],
  renderHTML: ({ node }) => ["div", { "data-sixb-raw": "" }, String(node.attrs.source ?? "")],
})

/** Anything inline that is not words: a field of live data, an inline picture or icon. */
export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => attributes(["source"]),
  parseHTML: () => [
    {
      tag: "[data-sixb-raw-inline]",
      priority: 60,
      getAttrs: (element) => ({ source: element.textContent ?? "" }),
    },
  ],
  renderHTML: ({ node }) => [
    "span",
    { "data-sixb-raw-inline": "" },
    String(node.attrs.source ?? ""),
  ],
})

/** A line break among words. */
export const HardBreak = Node.create({
  name: "hardBreak",
  group: "inline",
  inline: true,
  selectable: false,
  linebreakReplacement: true,
  addAttributes: () => attributes(["source"]),
  parseHTML: () => [{ tag: "br" }],
  renderHTML: () => ["br"],
  renderText: () => "\n",
})

/** A mark for each inline tag, drawn as that tag with its source's attributes. */
export const PAGE_MARKS = PAGE_MARK_TAGS.map((tag) =>
  Mark.create({
    name: tag,
    // A link does not grow as the reader types after it.
    inclusive: tag !== "a",
    addAttributes: () => attributes(["open", "close"]),
    parseHTML: () => [
      { tag, getAttrs: (element) => ({ open: openOf(element), close: `</${tag}>` }) },
    ],
    renderHTML: ({ mark }) => [tag, { ...tagAttributes(mark.attrs.open as string | null) }, 0],
  })
)

/** The page's schema: what core's page reads its body into. */
export function pageSchemaExtensions(): AnyExtension[] {
  // A block of words first: what ProseMirror makes where a block is missing.
  return [
    PageDocument,
    PageText,
    TextBlock,
    Box,
    PageImage,
    RawBlock,
    RawInline,
    HardBreak,
    ...PAGE_MARKS,
  ]
}

/** Whether a node is a block of words that takes typing. */
export function isWords(node: ProseMirrorNode | null | undefined): boolean {
  return node?.type.name === "textBlock"
}
