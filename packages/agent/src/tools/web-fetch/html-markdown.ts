import type { Element, ElementContent, Nodes, Root, RootContent } from "hast"
import { fromParse5 } from "hast-util-from-parse5"
import { toMdast } from "hast-util-to-mdast"
import type { Nodes as MdastNodes } from "mdast"
import { gfmToMarkdown } from "mdast-util-gfm"
import { toMarkdown } from "mdast-util-to-markdown"
import { type DefaultTreeAdapterMap, defaultTreeAdapter, parse, type TreeAdapter } from "parse5"

/** A fetched HTML page, as the network returned it. */
export interface HtmlPage {
  readonly bytes: Uint8Array
  /** The response's `content-type` header, which may carry the charset. Empty when absent. */
  readonly contentType: string
  /** The URL the page was finally read from, after redirects: relative links resolve against it. */
  readonly url: string | URL
}

/** The page's readable text. */
export interface HtmlMarkdown {
  /** `og:title`, else `<title>`; empty when the page names itself nowhere. */
  readonly title: string
  readonly markdown: string
  /** The page was cut where it nested too deep or held too many elements: the rest is missing. */
  readonly truncated?: true
}

/**
 * Elements whose content is never part of what a page says: code, chrome and widgets.
 *
 * `head` goes too, once the title and `<base>` are read from it.
 */
const DROPPED_ELEMENTS = new Set([
  "aside",
  "base",
  "footer",
  "form",
  "head",
  "header",
  "iframe",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
])

/**
 * How deep the page may nest: the rest of the document is cut where it goes deeper.
 *
 * Unbounded, a page of nested `<div>`s costs parse5 quadratic time (40k levels take seconds) and
 * overflows the stack of every utility after it, which recurse once per level (at ~10k levels).
 * Below that, conversion time still grows with depth × content. Real pages stay far below this
 * (Chromium caps its tree at 512).
 */
const MAX_DEPTH = 256

/**
 * How many elements the page may place before the rest of it is cut, each counting one plus one
 * per {@link DEPTH_PER_ELEMENT} levels it is nested.
 *
 * Conversion is synchronous and costs up to ~14 µs an element, more the deeper it sits: markdown
 * indents every line of a nested quote or list. Bytes alone do not bound it: 2 MB of
 * `<a><b><p>x</a>` is a million elements and seven seconds. This budget is about half a second at
 * worst, and holds a 2 MB Wikipedia article (~25k) whole.
 */
const MAX_ELEMENTS = 40_000
const DEPTH_PER_ELEMENT = 32

/** The most nodes converted in one piece; see {@link slices}. */
const SLICE_NODES = 2_000

/** Bytes the charset `<meta>` must sit within, as the HTML spec's prescan reads them. */
const CHARSET_PRESCAN_BYTES = 1024

type Parse5Node = DefaultTreeAdapterMap["node"]
type Parse5ParentNode = DefaultTreeAdapterMap["parentNode"]
type Parse5Document = DefaultTreeAdapterMap["document"]

/**
 * Convert a fetched HTML page to markdown, keeping its content and dropping its chrome.
 *
 * `parse5` builds the tree the way a browser would, whatever the markup; the page is then pruned
 * (scripts, navigation, hidden elements), narrowed to its single `main` or `article` when it has
 * one, and written as GFM markdown. Links and images are absolute.
 */
export function htmlToMarkdown(page: HtmlPage): HtmlMarkdown {
  const html = decodeHtml(page.bytes, page.contentType)

  const parsed = parseBounded(html)
  const tree = fromParse5(parsed.document) as Root
  const title = pageTitle(tree)
  const base = baseUrl(tree, page.url)

  const content = selectContent(prune(tree, base))
  const markdown = collapseBlankLines(slices(content).map(writeMarkdown).join("\n\n"))

  return { title, markdown, ...(parsed.truncated ? { truncated: true } : {}) }
}

function writeMarkdown(slice: Root): string {
  const tree = toMdast(slice)
  unwrapEmptyInline(tree)

  return toMarkdown(tree, {
    bullet: "-",
    emphasis: "_",
    fences: true,
    listItemIndent: "one",
    rule: "-",
    extensions: [gfmToMarkdown()],
  })
}

/** Inline nodes written as markers around their content. */
const WRAPPING_INLINE = new Set(["delete", "emphasis", "strong", "link"])

/**
 * Replace inline nodes that show nothing by what they hold: written, an empty or blank one is its
 * markers alone (`~~~~` for `<del></del>`), which at a line's start opens a code fence. Blank
 * inline code keeps its spaces as text.
 */
function unwrapEmptyInline(node: MdastNodes): void {
  if (!("children" in node)) return

  const children: MdastNodes[] = []
  for (const child of node.children) {
    unwrapEmptyInline(child)

    if (child.type === "inlineCode" && !child.value.trim()) {
      children.push({ type: "text", value: child.value })
    } else if (WRAPPING_INLINE.has(child.type) && "children" in child && isBlank(child.children)) {
      children.push(...child.children)
    } else {
      children.push(child)
    }
  }

  node.children = children as typeof node.children
}

/** Only whitespace text, or nothing. */
function isBlank(nodes: readonly MdastNodes[]): boolean {
  return nodes.every((node) => node.type === "text" && !node.value.trim())
}

/**
 * Decode with the charset the header names, else the one a `<meta>` names near the top, else
 * UTF-8. A byte-order mark wins over both, as in a browser. An unknown label decodes as UTF-8.
 */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const label = bomCharset(bytes) ?? headerCharset(contentType) ?? metaCharset(bytes) ?? "utf-8"

  return decoderFor(label).decode(bytes)
}

function bomCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"

  return undefined
}

function headerCharset(contentType: string): string | undefined {
  return /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
}

/** `<meta charset="…">` or `<meta http-equiv="content-type" content="…; charset=…">`. */
function metaCharset(bytes: Uint8Array): string | undefined {
  // Latin-1 maps every byte to one character, so ASCII markup reads the same in any charset.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_PRESCAN_BYTES))

  return /<meta[^>]+charset\s*=\s*["']?([^"'>;\s/]+)/i.exec(head)?.[1]
}

function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label.trim())
  } catch {
    return new TextDecoder("utf-8")
  }
}

/**
 * Parse like a browser, but stop the document where it nests deeper than {@link MAX_DEPTH} or
 * places more than {@link MAX_ELEMENTS} elements.
 *
 * Throwing from the tree adapter is the only way to bound parse5: it keeps every open element on
 * a stack and scans that stack for most start tags, so its time grows with depth × tags.
 */
function parseBounded(html: string): { document: Parse5Document; truncated: boolean } {
  const depths = new WeakMap<Parse5Node, number>()
  let document: Parse5Document | undefined
  let elements = 0

  const place = (parent: Parse5ParentNode, child: Parse5Node): void => {
    if (!defaultTreeAdapter.isElementNode(child)) return

    const depth = (depths.get(parent) ?? 0) + 1
    if (depth > MAX_DEPTH) throw new Cut()

    elements += 1 + depth / DEPTH_PER_ELEMENT
    if (elements > MAX_ELEMENTS) throw new Cut()

    depths.set(child, depth)
  }

  const treeAdapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,

    createDocument() {
      document = defaultTreeAdapter.createDocument()
      return document
    },

    appendChild(parent, child) {
      place(parent, child)
      defaultTreeAdapter.appendChild(parent, child)
    },

    insertBefore(parent, child, reference) {
      place(parent, child)
      defaultTreeAdapter.insertBefore(parent, child, reference)
    },

    // A template's content is a fragment of its own; it starts at the template's depth.
    setTemplateContent(template, content) {
      depths.set(content, depths.get(template) ?? 0)
      defaultTreeAdapter.setTemplateContent(template, content)
    },
  }

  try {
    return { document: parse(html, { treeAdapter }), truncated: false }
  } catch (error) {
    if (error instanceof Cut && document) return { document, truncated: true }
    throw error
  }
}

class Cut extends Error {}

/** `og:title`, else `<title>`, both from the head. */
function pageTitle(tree: Root): string {
  const head = findElement(tree, "head")
  if (!head) return ""

  for (const node of head.children) {
    if (!isElement(node, "meta")) continue

    const property = node.properties.property ?? node.properties.name
    const content = node.properties.content
    if (property === "og:title" && typeof content === "string" && content.trim()) {
      return content.trim()
    }
  }

  const title = findElement(head, "title")
  if (!title) return ""

  return title.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
}

/** The page's URL, or its `<base href>` resolved against it. */
function baseUrl(tree: Root, pageUrl: string | URL): URL | undefined {
  const page = parseUrl(String(pageUrl))
  if (!page) return undefined

  const base = findElement(tree, "base")
  const href = base?.properties.href

  return (typeof href === "string" && parseUrl(href, page)) || page
}

/**
 * Drop what is not content, and make every link and image absolute.
 *
 * A link that goes nowhere a reader can follow (`javascript:`, malformed) keeps its text; an
 * image that is not on the web (`data:`, malformed) is dropped, since its bytes would only bloat
 * the page.
 */
function prune<T extends Root | Element>(node: T, base: URL | undefined): T {
  const children: ElementContent[] = []

  for (const child of node.children) {
    if (child.type === "comment" || child.type === "doctype") continue

    if (child.type !== "element") {
      children.push(child)
      continue
    }

    if (isDropped(child)) continue

    if (child.tagName === "a" && typeof child.properties.href === "string") {
      const href = webUrl(child.properties.href, base, ["http:", "https:", "mailto:"])

      if (!href) {
        for (const grandchild of prune(child, base).children) children.push(grandchild)
        continue
      }

      child.properties.href = href
    }

    if (child.tagName === "img") {
      const src = webUrl(String(child.properties.src ?? ""), base, ["http:", "https:"])
      if (!src) continue

      child.properties.src = src
    }

    children.push(prune(child, base))
  }

  node.children = children as T["children"]
  return node
}

function isDropped(element: Element): boolean {
  if (DROPPED_ELEMENTS.has(element.tagName)) return true
  if (element.properties.hidden) return true

  return String(element.properties.ariaHidden).toLowerCase() === "true"
}

/** The page's single `main`, else its single `article`, else the whole page. */
function selectContent(tree: Root): Root {
  for (const tagName of ["main", "article"]) {
    const found = findElements(tree, tagName)
    if (found.length === 1) return { type: "root", children: found }
  }

  return tree
}

/**
 * Cut the content into trees of at most {@link SLICE_NODES} nodes, converted one at a time.
 *
 * The syntax-tree utilities find a node's index with `indexOf` on its parent's children, so a
 * parent with n children costs n²: 160k table rows take 25 s in one piece. A small page is one
 * slice and converts unchanged; on a large one, an element too big for a slice is repeated
 * around each part of its children — a long table becomes several tables, a long list several
 * lists.
 */
function slices(content: Root): Root[] {
  return split(content, new WeakMap())
}

function split<T extends Root | Element>(node: T, sizes: WeakMap<Nodes, number>): T[] {
  if (sizeOf(node, sizes) <= SLICE_NODES) return [node]

  const parts: T[] = []
  let group: Array<T["children"][number]> = []
  let groupSize = 0

  const flush = (): void => {
    if (group.length === 0) return

    const part = { ...node, children: group }
    sizes.set(part, groupSize + 1)
    parts.push(part)

    group = []
    groupSize = 0
  }

  for (const child of node.children) {
    const pieces = child.type === "element" ? split(child, sizes) : [child]

    for (const piece of pieces) {
      const size = sizeOf(piece, sizes)
      if (groupSize + size > SLICE_NODES) flush()

      group.push(piece)
      groupSize += size
    }
  }

  flush()
  return parts
}

/** Nodes in the subtree, counted once and remembered. */
function sizeOf(node: Nodes, sizes: WeakMap<Nodes, number>): number {
  const known = sizes.get(node)
  if (known !== undefined) return known

  let size = 1
  if ("children" in node) {
    for (const child of node.children) size += sizeOf(child, sizes)
  }

  sizes.set(node, size)
  return size
}

/**
 * Collapse runs of blank lines to one and trim, leaving fenced code exactly as written: its blank
 * lines are part of the code.
 */
function collapseBlankLines(markdown: string): string {
  const lines: string[] = []
  let fence: string | undefined
  let blank = false

  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]

    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = undefined
      lines.push(line)
      continue
    }

    if (marker) fence = marker

    const isBlank = line.trim() === ""
    if (isBlank && blank) continue

    blank = isBlank
    lines.push(isBlank ? "" : line)
  }

  return lines.join("\n").trim()
}

function webUrl(value: string, base: URL | undefined, protocols: string[]): string | undefined {
  const url = parseUrl(value.trim(), base)
  if (!url || !protocols.includes(url.protocol)) return undefined

  return url.href
}

function parseUrl(value: string, base?: URL): URL | undefined {
  try {
    return new URL(value, base)
  } catch {
    return undefined
  }
}

function isElement(node: RootContent | ElementContent, tagName: string): node is Element {
  return node.type === "element" && node.tagName === tagName
}

function findElement(node: Root | Element, tagName: string): Element | undefined {
  return findElements(node, tagName, 1)[0]
}

/** Elements named `tagName` under `node`, outermost first, without descending into a match. */
function findElements(node: Root | Element, tagName: string, limit = Infinity): Element[] {
  const found: Element[] = []
  const stack: Array<RootContent | ElementContent> = []
  pushReversed(stack, node.children)

  for (let child = stack.pop(); child && found.length < limit; child = stack.pop()) {
    if (child.type !== "element") continue

    if (child.tagName === tagName) {
      found.push(child)
      continue
    }

    pushReversed(stack, child.children)
  }

  return found
}

/** Push so that popping visits `items` in document order. No spread: a node may have millions. */
function pushReversed<T>(stack: T[], items: readonly T[]): void {
  for (let index = items.length - 1; index >= 0; index--) stack.push(items[index] as T)
}
