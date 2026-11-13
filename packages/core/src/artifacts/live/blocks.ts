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
import { diffSequences } from "./diff"

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

const CALLOUT = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i

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
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const source = (node: Nodes) =>
    markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
  const raw = (node: Nodes): BlockNode => ({ type: "markdown", attrs: { source: source(node) } })

  const inline = (
    nodes: readonly PhrasingContent[],
    marks: readonly BlockMark[] = []
  ): BlockNode[] =>
    nodes.flatMap((node): BlockNode[] => {
      switch (node.type) {
        case "text":
          return node.value ? [text(node.value, marks)] : []
        case "strong":
        case "emphasis":
        case "delete":
          return inline(node.children, [...marks, { type: MARKS_OF[node.type] as string }])
        case "inlineCode":
          return [text(node.value, [...marks, { type: "code" }])]
        case "link":
          return inline(node.children, [...marks, link(node.url, node.title ?? null)])
        case "break":
          return [{ type: "hardBreak" }]
        default:
          return [{ type: "markdownInline", attrs: { source: source(node) } }]
      }
    })

  const paragraph = (node: Paragraph): BlockNode => {
    const [only] = node.children
    // An image alone in its paragraph is a figure; its title is its caption.
    if (node.children.length === 1 && only?.type === "image") return image(only)
    return block("paragraph", undefined, inline(node.children))
  }

  const list = (node: List): BlockNode => {
    const task = node.children.some((item) => item.checked !== null && item.checked !== undefined)
    const items = node.children.map((item) => listItem(item, task))
    if (task) return block("taskList", undefined, items)
    if (node.ordered) return block("orderedList", { start: node.start ?? 1 }, items)
    return block("bulletList", undefined, items)
  }

  const listItem = (node: ListItem, task: boolean): BlockNode => {
    const children = blocks(node.children)
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
      return block("blockquote", undefined, nonEmpty(blocks(node.children)))
    }
    const rest = marker.value.slice(match[0].length)
    const opening: Paragraph = {
      ...first,
      children: [...(rest ? [{ ...marker, value: rest }] : []), ...first.children.slice(1)],
    }
    const content = [
      ...(opening.children.length > 0 ? [paragraph(opening)] : []),
      ...blocks(node.children.slice(1)),
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
              [block("paragraph", undefined, inline(cell.children))]
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

  const blocks = (nodes: readonly RootContent[]): BlockNode[] =>
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
          return [list(node)]
        case "code":
          return [code(node)]
        case "table":
          return [table(node)]
        default:
          return [raw(node)]
      }
    })

  return block("doc", undefined, nonEmpty(blocks((tree as Root).children)))
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
  // What is kept verbatim goes out as a placeholder, put back once the rest is written.
  const verbatim = (source: string) => {
    sources.push(source)
    return `\u{E000}${sources.length - 1}\u{E001}`
  }

  const phrasing = (nodes: readonly BlockNode[] = []): PhrasingContent[] => {
    const out: PhrasingContent[] = []
    for (const node of nodes) {
      if (node.type === "hardBreak") {
        out.push({ type: "break" })
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
                  spread: false,
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
                    ])
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
    .replace(/\u{E000}(\d+)\u{E001}/gu, (_, index: string) => sources[Number(index)] ?? "")
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
function toYChildren(nodes: readonly BlockNode[]): (Y.XmlElement | Y.XmlText)[] {
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
    const content = toYChildren(node.content ?? [])
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
function fromYChildren(children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): BlockNode[] {
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
    const content = fromYChildren(child.toArray())
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
  fragment.insert(0, toYChildren(markdownToBlocks(markdown).content ?? []))
  return fragment
}

/** The Markdown a fragment holds now. */
export function fragmentMarkdown(fragment: Y.XmlFragment): string {
  return blocksToMarkdown({ type: "doc", content: fromYChildren(fragment.toArray()) })
}

/**
 * Makes a fragment hold the blocks of `markdown` by the fewest changes to its top-level blocks:
 * one that reads the same stays as it is, with whatever its editors' carets and history hold.
 */
export function patchFragment(fragment: Y.XmlFragment, markdown: string): void {
  const next = markdownToBlocks(markdown).content ?? []
  const current = fromYChildren(fragment.toArray())
  const key = (node: BlockNode) => JSON.stringify(normalized(node))
  const hunks = diffSequences(current.map(key), next.map(key))
  for (const hunk of hunks.reverse()) {
    if (hunk.aEnd > hunk.aStart) fragment.delete(hunk.aStart, hunk.aEnd - hunk.aStart)
    if (hunk.bEnd > hunk.bStart) {
      fragment.insert(hunk.aStart, toYChildren(next.slice(hunk.bStart, hunk.bEnd)))
    }
  }
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
