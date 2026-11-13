import type {
  Blockquote,
  Code,
  Heading,
  Image,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm"
import { toMarkdown } from "mdast-util-to-markdown"
import { gfm } from "micromark-extension-gfm"
import * as Y from "yjs"
import { diffSequences, interleave, mergeSequences, mergeText } from "./diff"

// A Markdown document as blocks, which its editor edits: the nodes and marks ProseMirror holds,
// named as the app's TipTap editor names them, so the live document's `Y.XmlFragment` is what the
// editor's collaboration reads and writes.
//
//   doc ─ paragraph · heading{level} · blockquote · callout{kind} · bulletList · orderedList{start}
//         · taskList · listItem · taskItem{checked} · codeBlock{language, meta} · horizontalRule
//         · image{src, alt, title} · table · tableRow · tableHeader · tableCell{colspan, rowspan,
//         align}
//         · markdown{source}, any block written as it was
//   inline ─ text · hardBreak · markdownInline{source}
//   marks ─ bold · italic · strike · code · link{href, target, rel, class, title}
//
// A node is a `Y.XmlElement` named by its type, its attributes those of the node; text is a
// `Y.XmlText` whose formatting attributes are its marks, each named by its type with its
// attributes as value, as y-prosemirror encodes them; each with every attribute the editor's schema
// gives it, so what the server writes the editor leaves as it is. What it does not model, a footnote,
// a reference definition or raw HTML, is kept as its own Markdown, which it writes back verbatim.

/** A node as ProseMirror's JSON holds it. */
export interface BlockNode {
  readonly type: string
  readonly attrs?: Readonly<Record<string, unknown>>
  readonly content?: readonly BlockNode[]
  readonly text?: string
  readonly marks?: readonly BlockMark[]
}

export interface BlockMark {
  readonly type: string
  readonly attrs?: Readonly<Record<string, unknown>>
}

/** A callout's marker, read as the document page reads it: words may follow it on its line. */
const CALLOUT = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*\n?/i

/** Front matter, which Markdown has no node for: kept as it was written. */
const FRONT_MATTER = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/

/** The inline nodes the editor models: within a mark, anything else keeps the mark verbatim. */
const MODELLED_INLINE: ReadonlySet<string> = new Set([
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
  "break",
])

/** A line break in a table cell, where Markdown has no other. */
const CELL_BREAK = /^<br\s*\/?>$/i

const MARKS_OF: Readonly<Record<string, string>> = {
  strong: "bold",
  emphasis: "italic",
  delete: "strike",
}
const PHRASING_OF: Readonly<Record<string, "strong" | "emphasis" | "delete">> = {
  bold: "strong",
  italic: "emphasis",
  strike: "delete",
}

// ── Markdown → blocks ───────────────────────────────────────────────────

/** A document's Markdown as blocks. */
export function markdownToBlocks(markdown: string): BlockNode {
  const frontMatter = FRONT_MATTER.exec(markdown)?.[0]
  const body = frontMatter ? markdown.slice(frontMatter.length) : markdown
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const source = (node: Nodes) =>
    body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
  // Within a quote or a list, a block's source holds its container's markers on every line: it
  // is kept as Markdown would write it on its own, so it can move out of the container.
  const raw = (node: Nodes, nested = false): BlockNode => ({
    type: "markdown",
    attrs: {
      source: !nested
        ? source(node)
        : node.type === "html"
          ? node.value
          : toMarkdown(node as Root, { extensions: [gfmToMarkdown()] }).trimEnd(),
    },
  })
  const inlineRaw = (node: Nodes): BlockNode => ({
    type: "markdownInline",
    attrs: { source: source(node) },
  })

  const inline = (
    nodes: readonly PhrasingContent[],
    marks: readonly BlockMark[] = [],
    inCell = false
  ): BlockNode[] =>
    nodes.flatMap((node): BlockNode[] => {
      switch (node.type) {
        case "text":
          return node.value ? [text(node.value, marks)] : []
        case "strong":
        case "emphasis":
        case "delete":
          // A mark around a picture or markup the editor does not model is kept whole, mark
          // and all, or editing beside it would write the mark around the words alone.
          if (!modelledThroughout(node)) return [inlineRaw(node)]
          return inline(node.children, [...marks, { type: MARKS_OF[node.type] as string }], inCell)
        case "inlineCode":
          return [text(node.value, [...marks, { type: "code" }])]
        case "link":
          if (!modelledThroughout(node)) return [inlineRaw(node)]
          return inline(node.children, [...marks, link(node.url, node.title ?? null)], inCell)
        case "break":
          return [{ type: "hardBreak" }]
        case "html":
          if (inCell && CELL_BREAK.test(node.value)) return [{ type: "hardBreak" }]
          return [inlineRaw(node)]
        default:
          return [inlineRaw(node)]
      }
    })

  const paragraph = (node: Paragraph): BlockNode => {
    const [only] = node.children
    // An image alone in its paragraph is a figure; its title is its caption.
    if (node.children.length === 1 && only?.type === "image") return image(only)
    return block("paragraph", undefined, inline(node.children))
  }

  const list = (node: List, nested: boolean): BlockNode => {
    const checked = (item: ListItem) => item.checked !== null && item.checked !== undefined
    const task = node.children.some(checked)
    // A list of to-dos and plain items, which the editor's lists cannot hold: kept as written.
    if (task && !node.children.every(checked)) return raw(node, nested)
    const items = node.children.map((item) => listItem(item, task))
    if (task) return block("taskList", undefined, items)
    if (node.ordered) return block("orderedList", { start: node.start ?? 1 }, items)
    return block("bulletList", undefined, items)
  }

  const listItem = (node: ListItem, task: boolean): BlockNode => {
    const children = blocks(node.children, true)
    // An item opens with words: the editor's list items do.
    const content = children[0]?.type === "paragraph" ? children : [block("paragraph"), ...children]
    return task
      ? block("taskItem", { checked: node.checked === true }, content)
      : block("listItem", undefined, content)
  }

  const blockquote = (node: Blockquote): BlockNode => {
    const [first] = node.children
    const marker = first?.type === "paragraph" ? first.children[0] : undefined
    const match = marker?.type === "text" ? CALLOUT.exec(marker.value) : null
    if (!match || first?.type !== "paragraph" || marker?.type !== "text") {
      return block("blockquote", undefined, nonEmpty(blocks(node.children, true)))
    }
    const rest = marker.value.slice(match[0].length)
    const opening: Paragraph = {
      ...first,
      children: [...(rest ? [{ ...marker, value: rest }] : []), ...first.children.slice(1)],
    }
    const content = [
      ...(opening.children.length > 0 ? [paragraph(opening)] : []),
      ...blocks(node.children.slice(1), true),
    ]
    return block("callout", { kind: (match[1] as string).toLowerCase() }, nonEmpty(content))
  }

  const table = (node: Table): BlockNode =>
    block(
      "table",
      undefined,
      node.children.map((row, index) =>
        block(
          "tableRow",
          undefined,
          row.children.map((cell: TableCell, column) =>
            block(
              index === 0 ? "tableHeader" : "tableCell",
              { colspan: 1, rowspan: 1, align: node.align?.[column] ?? null },
              [block("paragraph", undefined, inline(cell.children, [], true))]
            )
          )
        )
      )
    )

  const code = (node: Code): BlockNode =>
    block(
      "codeBlock",
      { language: node.lang ?? null, meta: node.meta ?? null },
      node.value ? [text(node.value)] : []
    )

  const blocks = (nodes: readonly RootContent[], nested = false): BlockNode[] =>
    nodes.flatMap((node): BlockNode[] => {
      switch (node.type) {
        case "paragraph":
          return [paragraph(node)]
        case "heading":
          return [block("heading", { level: node.depth }, inline(node.children))]
        case "thematicBreak":
          return [{ type: "horizontalRule" }]
        case "blockquote":
          return [blockquote(node)]
        case "list":
          return [list(node, nested)]
        case "code":
          return [code(node)]
        case "table":
          return [table(node)]
        default:
          return [raw(node, nested)]
      }
    })

  const content = blocks((tree as Root).children)
  if (frontMatter) content.unshift(block("markdown", { source: frontMatter.trimEnd() }))
  return block("doc", undefined, nonEmpty(content))
}

/** Whether every inline node within a mark is one the editor models. */
function modelledThroughout(node: PhrasingContent): boolean {
  if (!MODELLED_INLINE.has(node.type)) return false
  return !("children" in node) || node.children.every(modelledThroughout)
}

/**
 * A link as the editor marks one: every attribute its schema gives a link, as a mark keeps them,
 * nulls included, so a link the server wrote is one the editor leaves as it is.
 */
function link(href: string, title: string | null): BlockMark {
  return { type: "link", attrs: { href, target: null, rel: null, class: null, title } }
}

function image(node: Image): BlockNode {
  return {
    type: "image",
    attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
  }
}

function text(value: string, marks: readonly BlockMark[] = []): BlockNode {
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value }
}

function block(
  type: string,
  attrs?: Record<string, unknown>,
  content: readonly BlockNode[] = []
): BlockNode {
  return {
    type,
    ...(attrs ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  }
}

/** Content that must hold a block: an empty paragraph when it holds none. */
function nonEmpty(content: readonly BlockNode[]): BlockNode[] {
  return content.length > 0 ? [...content] : [block("paragraph")]
}

// ── Blocks → Markdown ───────────────────────────────────────────────────

/** Blocks written as a document's Markdown. */
export function blocksToMarkdown(doc: BlockNode): string {
  const sources: string[] = []
  // What is kept verbatim goes out as a placeholder, put back once the rest is written: letters
  // and digits, which Markdown never escapes, unlike any word the document holds.
  const nonce = placeholderNonce(doc)
  const verbatim = (source: string) => {
    sources.push(source)
    return `${nonce}${sources.length - 1}x`
  }

  const phrasing = (nodes: readonly BlockNode[] = [], inCell = false): PhrasingContent[] => {
    const out: PhrasingContent[] = []
    for (const node of nodes) {
      if (node.type === "hardBreak") {
        // A cell is one line: its breaks are written as HTML, as GFM tables write them.
        out.push(inCell ? { type: "html", value: "<br>" } : { type: "break" })
        continue
      }
      if (node.type === "markdownInline") {
        out.push({ type: "html", value: verbatim(String(node.attrs?.source ?? "")) })
        continue
      }
      if (node.type !== "text" || !node.text) continue
      const marks = node.marks ?? []
      let leaf: PhrasingContent = marks.some((mark) => mark.type === "code")
        ? { type: "inlineCode", value: node.text }
        : { type: "text", value: node.text }
      // Marks wrap from the innermost, the order ProseMirror keeps them in reversed.
      for (const mark of [...marks].reverse()) {
        if (mark.type === "link") {
          leaf = {
            type: "link",
            url: String(mark.attrs?.href ?? ""),
            title: typeof mark.attrs?.title === "string" ? mark.attrs.title : null,
            children: [leaf],
          }
        } else if (PHRASING_OF[mark.type]) {
          leaf = { type: PHRASING_OF[mark.type] as "strong", children: [leaf] }
        }
      }
      out.push(leaf)
    }
    return joinPhrasing(out)
  }

  const flow = (nodes: readonly BlockNode[] = []): RootContent[] =>
    nodes.flatMap((node): RootContent[] => {
      switch (node.type) {
        case "paragraph":
          return [{ type: "paragraph", children: phrasing(node.content) }]
        case "heading":
          return [
            {
              type: "heading",
              depth: clampLevel(node.attrs?.level),
              children: phrasing(node.content),
            } as Heading,
          ]
        case "horizontalRule":
          return [{ type: "thematicBreak" }]
        case "blockquote":
          return [{ type: "blockquote", children: flow(node.content) as Blockquote["children"] }]
        case "callout": {
          const kind = String(node.attrs?.kind ?? "note").toUpperCase()
          const [first, ...rest] = flow(node.content)
          const marker: PhrasingContent = { type: "html", value: verbatim(`[!${kind}]`) }
          const opening: Paragraph =
            first?.type === "paragraph"
              ? {
                  type: "paragraph",
                  children: [marker, { type: "text", value: "\n" }, ...first.children],
                }
              : { type: "paragraph", children: [marker] }
          const children = first?.type === "paragraph" ? rest : first ? [first, ...rest] : rest
          return [
            { type: "blockquote", children: [opening, ...children] as Blockquote["children"] },
          ]
        }
        case "bulletList":
        case "orderedList":
        case "taskList":
          return [
            {
              type: "list",
              ordered: node.type === "orderedList",
              ...(node.type === "orderedList" ? { start: Number(node.attrs?.start ?? 1) } : {}),
              spread: false,
              children: (node.content ?? []).map(
                (item): ListItem => ({
                  type: "listItem",
                  // Markdown kept as written, a definition or a footnote, needs a blank line
                  // before it, or it reads as the words before it.
                  spread: (item.content ?? []).some(
                    (child, index) => index > 0 && child.type === "markdown"
                  ),
                  checked: node.type === "taskList" ? item.attrs?.checked === true : null,
                  children: flow(item.content) as ListItem["children"],
                })
              ),
            },
          ]
        case "codeBlock":
          return [
            {
              type: "code",
              lang: typeof node.attrs?.language === "string" ? node.attrs.language : null,
              meta: typeof node.attrs?.meta === "string" ? node.attrs.meta : null,
              value: (node.content ?? []).map((each) => each.text ?? "").join(""),
            },
          ]
        case "image":
          return [
            {
              type: "paragraph",
              children: [
                {
                  type: "image",
                  url: String(node.attrs?.src ?? ""),
                  alt: typeof node.attrs?.alt === "string" ? node.attrs.alt : null,
                  title: typeof node.attrs?.title === "string" ? node.attrs.title : null,
                },
              ],
            },
          ]
        case "table": {
          const rows = node.content ?? []
          return [
            {
              type: "table",
              align: (rows[0]?.content ?? []).map((cell) => alignOf(cell.attrs?.align)),
              children: rows.map((row) => ({
                type: "tableRow",
                children: (row.content ?? []).map((cell) => ({
                  type: "tableCell",
                  children: phrasing(
                    (cell.content ?? []).flatMap((each, index) => [
                      ...(index > 0 ? [{ type: "hardBreak" }] : []),
                      ...(each.content ?? []),
                    ]),
                    true
                  ),
                })),
              })),
            } as Table,
          ]
        }
        case "markdown":
          return [{ type: "html", value: verbatim(String(node.attrs?.source ?? "")) }]
        default:
          return []
      }
    })

  const written = toMarkdown(
    { type: "root", children: flow(doc.content) },
    {
      extensions: [gfmToMarkdown({ tablePipeAlign: false })],
      bullet: "-",
      emphasis: "*",
      strong: "*",
      rule: "-",
      fences: true,
      listItemIndent: "one",
    }
  )
  return written
    .replace(TABLE_DELIMITER_ROW, (row) => row.replace(/(:?)-+(:?)/g, "$1---$2"))
    .replace(new RegExp(`${nonce}(\\d+)x`, "g"), (_, index: string) => sources[Number(index)] ?? "")
}

/** Letters no text of `doc` holds, to mark where what is kept verbatim goes. */
function placeholderNonce(doc: BlockNode): string {
  const words: string[] = []
  const collect = (node: BlockNode) => {
    if (node.text) words.push(node.text)
    for (const value of Object.values(node.attrs ?? {})) {
      if (typeof value === "string") words.push(value)
    }
    for (const child of node.content ?? []) collect(child)
  }
  collect(doc)
  const all = words.join("\n")
  let nonce = "sixbverbatim"
  while (all.includes(nonce)) nonce += "q"
  return nonce
}

/** A table's delimiter row, which is written `| --- |` as people write it, not `| - |`. */
const TABLE_DELIMITER_ROW = /^\|(?: *:?-+:? *\|)+$/gm

/** Adjacent runs of the same mark joined, as Markdown writes them: `**a b**`, not `**a** **b**`. */
function joinPhrasing(nodes: PhrasingContent[]): PhrasingContent[] {
  const joined: PhrasingContent[] = []
  for (const node of nodes) {
    const last = joined.at(-1)
    if (last && node.type === last.type && "children" in node && "children" in last) {
      const sameLink =
        node.type !== "link" ||
        (last.type === "link" && node.url === last.url && node.title === last.title)
      if (sameLink) {
        ;(last.children as PhrasingContent[]).push(...(node.children as PhrasingContent[]))
        last.children = joinPhrasing(last.children as PhrasingContent[]) as typeof last.children
        continue
      }
    }
    if (last?.type === "text" && node.type === "text") {
      last.value += node.value
      continue
    }
    joined.push(node)
  }
  return joined
}

function clampLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const value = Number(level)
  return (Number.isInteger(value) ? Math.min(6, Math.max(1, value)) : 1) as 1 | 2 | 3 | 4 | 5 | 6
}

function alignOf(align: unknown): "left" | "right" | "center" | null {
  return align === "left" || align === "right" || align === "center" ? align : null
}

// ── Blocks ⇄ the live document ──────────────────────────────────────────

/** Blocks as a `Y.XmlFragment`'s children: each an element, its text with its marks. */
export function blocksToY(nodes: readonly BlockNode[]): (Y.XmlElement | Y.XmlText)[] {
  const children: (Y.XmlElement | Y.XmlText)[] = []
  let run: BlockNode[] = []
  const flush = () => {
    if (run.length === 0) return
    const text = new Y.XmlText()
    let at = 0
    for (const node of run) {
      const value = node.text ?? ""
      text.insert(at, value, marksAttributes(node.marks))
      at += value.length
    }
    children.push(text)
    run = []
  }
  for (const node of nodes) {
    if (node.type === "text") {
      run.push(node)
      continue
    }
    flush()
    const element = new Y.XmlElement(node.type)
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      if (value !== null && value !== undefined) element.setAttribute(key, value as string)
    }
    const content = blocksToY(node.content ?? [])
    if (content.length > 0) element.insert(0, content)
    children.push(element)
  }
  flush()
  return children
}

function marksAttributes(marks: readonly BlockMark[] = []): Record<string, unknown> {
  return Object.fromEntries(marks.map((mark) => [mark.type, { ...mark.attrs }]))
}

/** A fragment's children read back as blocks. */
export function blocksFromY(
  children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]
): BlockNode[] {
  return children.flatMap((child): BlockNode[] => {
    if (child instanceof Y.XmlText) {
      return (child.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[])
        .filter((op) => typeof op.insert === "string" && op.insert !== "")
        .map((op) => {
          const marks = Object.entries(op.attributes ?? {}).map(([name, attrs]) => {
            // y-prosemirror names a second mark of a type that allows several `type--hash`.
            const type = name.split("--")[0] as string
            const values =
              attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {}
            return Object.keys(values).length > 0 ? { type, attrs: values } : { type }
          })
          return text(op.insert as string, marks)
        })
    }
    if (!(child instanceof Y.XmlElement)) return []
    const attrs = child.getAttributes() as Record<string, unknown>
    const content = blocksFromY(child.toArray())
    return [
      {
        type: child.nodeName,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        ...(content.length > 0 ? { content } : {}),
      },
    ]
  })
}

/** A new fragment holding the blocks of `markdown`. */
export function markdownFragment(markdown: string): Y.XmlFragment {
  const fragment = new Y.XmlFragment()
  fragment.insert(0, blocksToY(markdownToBlocks(markdown).content ?? []))
  return fragment
}

/** The Markdown a fragment holds now. */
export function fragmentMarkdown(fragment: Y.XmlFragment): string {
  return blocksToMarkdown({ type: "doc", content: blocksFromY(fragment.toArray()) })
}

/**
 * Makes a fragment hold the blocks of `markdown` by the fewest changes to its blocks, as
 * `patchBlocks` makes them.
 */
export function patchFragment(fragment: Y.XmlFragment, markdown: string): void {
  patchBlocks(fragment, markdownToBlocks(markdown).content ?? [])
}

/**
 * Makes a fragment or an element hold `next` by the fewest changes to its blocks: one that reads
 * the same stays as it is, with whatever its editors' carets and history hold. A block replaced by
 * one of the same type and attributes that holds blocks too is patched inside the same way, so a
 * change to one paragraph of a section leaves the rest of the section as it was.
 */
export function patchBlocks(
  parent: Y.XmlFragment,
  next: readonly BlockNode[],
  options: BlockComparison = {}
): void {
  const current = blocksFromY(parent.toArray())
  const key = options.key ?? ((node: BlockNode) => JSON.stringify(normalized(node)))
  const shell = options.shell ?? ((node: BlockNode) => key({ ...node, content: [] }))
  const hunks = diffSequences(current.map(key), next.map(key))
  for (const hunk of hunks.reverse()) {
    const removed = hunk.aEnd - hunk.aStart
    const added = hunk.bEnd - hunk.bStart
    const pairs = Array.from({ length: removed === added ? removed : 0 }, (_, at) => ({
      element: parent.get(hunk.aStart + at),
      before: current[hunk.aStart + at] as BlockNode,
      after: next[hunk.bStart + at] as BlockNode,
    }))
    if (
      pairs.length > 0 &&
      pairs.every(
        ({ element, before, after }) =>
          element instanceof Y.XmlElement &&
          holdsBlocks(before) &&
          holdsBlocks(after) &&
          shell(before) === shell(after)
      )
    ) {
      for (const { element, after } of pairs) {
        patchBlocks(element as Y.XmlElement, after.content ?? [], options)
      }
      continue
    }
    // A block of words changed in its words alone: the words are patched where they changed, so
    // what someone is typing elsewhere in it stays.
    if (
      pairs.length > 0 &&
      pairs.every(
        ({ element, before, after }) =>
          element instanceof Y.XmlElement &&
          holdsWordsAlone(element, before) &&
          holdsWordsAlone(null, after) &&
          shell(before) === shell(after)
      )
    ) {
      for (const { element, after } of pairs) patchWords(element as Y.XmlElement, after)
      continue
    }
    if (removed > 0) parent.delete(hunk.aStart, removed)
    if (added > 0) parent.insert(hunk.aStart, blocksToY(next.slice(hunk.bStart, hunk.bEnd)))
  }
}

/**
 * Whether a block holds words alone, with their marks: no line break, nothing kept verbatim. In
 * the live document, its element holds one text at most.
 */
function holdsWordsAlone(element: Y.XmlElement | null, node: BlockNode): boolean {
  if (!node.content?.every((each) => each.type === "text")) {
    return node.content === undefined && (element === null || element.length <= 1)
  }
  if (element === null) return true
  const children = element.toArray()
  return children.length === 1 && children[0] instanceof Y.XmlText
}

/**
 * Makes an element holding words alone hold `next`'s, by replacing what lies between the words
 * they start and end with alike, marks included, and takes `next`'s attributes.
 */
function patchWords(element: Y.XmlElement, next: BlockNode): void {
  const attrs = Object.fromEntries(
    Object.entries(next.attrs ?? {}).filter(([, value]) => value !== null && value !== undefined)
  )
  for (const [name, value] of Object.entries(element.getAttributes())) {
    if (!(name in attrs)) element.removeAttribute(name)
    else if (value !== attrs[name]) element.setAttribute(name, attrs[name] as string)
  }
  for (const [name, value] of Object.entries(attrs)) {
    if (!element.hasAttribute(name)) element.setAttribute(name, value as string)
  }

  const existing = element.get(0)
  if (!(existing instanceof Y.XmlText)) {
    const fresh = blocksToY(next.content ?? [])
    if (fresh.length > 0) element.insert(0, fresh)
    return
  }
  const characters = (nodes: readonly BlockNode[]) =>
    nodes.flatMap((node) => {
      const marks = JSON.stringify(marksAttributes(node.marks))
      return [...(node.text ?? "")].map((character) => ({ character, marks, node }))
    })
  const before = characters(blocksFromY([existing]))
  const after = characters(next.content ?? [])
  const same = (left: (typeof before)[number], right: (typeof after)[number]) =>
    left.character === right.character && left.marks === right.marks
  let start = 0
  while (start < before.length && start < after.length && same(before[start], after[start]))
    start += 1
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    same(before[before.length - 1 - end], after[after.length - 1 - end])
  )
    end += 1

  // Yjs counts UTF-16 code units, as JavaScript strings do.
  const units = (run: readonly { character: string }[]) =>
    run.reduce((sum, each) => sum + each.character.length, 0)
  const from = units(before.slice(0, start))
  const removed = units(before.slice(start, before.length - end))
  if (removed > 0) existing.delete(from, removed)
  let at = from
  const inserted = after.slice(start, after.length - end)
  for (let index = 0; index < inserted.length; ) {
    const marks = inserted[index]?.marks
    let run = ""
    let node = inserted[index]?.node as BlockNode
    while (index < inserted.length && inserted[index]?.marks === marks) {
      run += inserted[index]?.character
      node = inserted[index]?.node as BlockNode
      index += 1
    }
    existing.insert(at, run, marksAttributes(node.marks))
    at += run.length
  }
}

/** Whether a node holds blocks alone, each its own element of the live document. */
function holdsBlocks(node: BlockNode): boolean {
  return (
    (node.content?.length ?? 0) > 0 && node.content?.every((each) => each.type !== "text") === true
  )
}

/**
 * Folds two changes of a list of blocks, `ours` and `theirs` of `base`, block by block: a block
 * only one side changed is taken from it; one both changed is merged inside, a block of blocks by
 * its blocks and anything else by `mergeLeaf`; what both added is kept, ours first, and what
 * either took out goes. A block both hold is taken as `theirs` holds it.
 */
export function mergeBlockLists(
  base: readonly BlockNode[],
  ours: readonly BlockNode[],
  theirs: readonly BlockNode[],
  comparison: Required<BlockComparison> & {
    /** One block both changed, merged inside; null to keep both sides' as two. */
    readonly mergeLeaf: (base: BlockNode, ours: BlockNode, theirs: BlockNode) => BlockNode | null
  }
): BlockNode[] {
  const keys = new WeakMap<BlockNode, string>()
  const key = (node: BlockNode) => {
    let known = keys.get(node)
    if (known === undefined) {
      known = comparison.key(node)
      keys.set(node, known)
    }
    return known
  }
  const merge = (
    base: readonly BlockNode[],
    ours: readonly BlockNode[],
    theirs: readonly BlockNode[]
  ): BlockNode[] => {
    const baseKeys = base.map(key)
    const oursKeys = ours.map(key)
    const theirsKeys = theirs.map(key)
    if (sameKeys(oursKeys, baseKeys)) return [...theirs]
    if (sameKeys(theirsKeys, baseKeys) || sameKeys(oursKeys, theirsKeys)) return [...ours]

    // Each key's blocks, theirs first; the first of each side's, for blocks both changed.
    const byKey = new Map<string, BlockNode[]>()
    for (const node of [...theirs, ...ours, ...base]) {
      const list = byKey.get(key(node))
      if (list) list.push(node)
      else byKey.set(key(node), [node])
    }
    const firstOf = (list: readonly BlockNode[]) => {
      const map = new Map<string, BlockNode>()
      for (const node of list) if (!map.has(key(node))) map.set(key(node), node)
      return map
    }
    const [baseOf, oursOf, theirsOf] = [firstOf(base), firstOf(ours), firstOf(theirs)]
    const one = (b: BlockNode, o: BlockNode, t: BlockNode): BlockNode | null => {
      const shell = comparison.shell(t)
      if (comparison.shell(b) !== shell || comparison.shell(o) !== shell) return null
      if (holdsBlocks(b) && holdsBlocks(o) && holdsBlocks(t)) {
        return { ...t, content: merge(b.content ?? [], o.content ?? [], t.content ?? []) }
      }
      return comparison.mergeLeaf(b, o, t)
    }

    const merged = mergeSequences(baseKeys, oursKeys, theirsKeys, (b, o, t) => {
      // The same blocks changed on both sides: each merged inside, while it is the same
      // block on each.
      if (b.length === o.length && o.length === t.length) {
        const each = b.map((k, at) =>
          one(
            baseOf.get(k) as BlockNode,
            oursOf.get(o[at] as string) as BlockNode,
            theirsOf.get(t[at] as string) as BlockNode
          )
        )
        if (each.every((node) => node !== null)) {
          return each.map((node) => {
            const k = key(node as BlockNode)
            byKey.set(k, [node as BlockNode, ...(byKey.get(k) ?? [])])
            return k
          })
        }
      }
      return interleave(b, o, t)
    })
    const taken = new Map<string, number>()
    return merged.map((k) => {
      const at = taken.get(k) ?? 0
      taken.set(k, at + 1)
      const nodes = byKey.get(k) ?? []
      return (nodes[at] ?? nodes[0]) as BlockNode
    })
  }
  return merge(base, ours, theirs)
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, at) => key === right[at])
}

/**
 * Folds two changes of a Markdown document, `ours` the blocks its editors hold now, block by
 * block: compared as blocks, how each side writes its Markdown is no change. A block both changed
 * is merged by its Markdown, written alone.
 */
export function mergeMarkdownBlocks(
  base: string,
  ours: readonly BlockNode[],
  theirs: string
): BlockNode[] {
  const key = (node: BlockNode) => JSON.stringify(normalized(node))
  return mergeBlockLists(
    markdownToBlocks(base).content ?? [],
    ours,
    markdownToBlocks(theirs).content ?? [],
    {
      key,
      shell: (node) => key({ ...node, content: [] }),
      mergeLeaf: (b, o, t) => {
        const written = (node: BlockNode) => blocksToMarkdown({ type: "doc", content: [node] })
        const [merged, ...more] =
          markdownToBlocks(mergeText(written(b), written(o), written(t))).content ?? []
        if (!merged || more.length > 0 || merged.type !== t.type) return null
        return merged
      },
    }
  )
}

/**
 * How `patchBlocks` tells blocks apart: `key` is the same for two blocks that are the same, and
 * `shell` for two that are the same but for what they hold. By default, by their nodes.
 */
export interface BlockComparison {
  readonly key?: (node: BlockNode) => string
  readonly shell?: (node: BlockNode) => string
}

/** A block without what reading it back adds or drops: null attributes, empty marks. */
function normalized(node: BlockNode): unknown {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {}).filter(([, value]) => value !== null && value !== undefined)
  )
  return {
    type: node.type,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks?.length
      ? { marks: node.marks.map((mark) => normalized(mark as BlockNode)) }
      : {}),
    ...(node.content?.length ? { content: node.content.map(normalized) } : {}),
  }
}
