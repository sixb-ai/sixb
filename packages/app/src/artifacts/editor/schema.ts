import { type AnyExtension, mergeAttributes, Node } from "@tiptap/core"
import { CodeBlock } from "@tiptap/extension-code-block"
import { Image } from "@tiptap/extension-image"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { StarterKit } from "@tiptap/starter-kit"
import { CALLOUT_KINDS } from "../renderers/document-tree"

// The blocks a Markdown document is made of, as the editor's schema: the nodes and marks core's
// `artifacts/live/blocks.ts` reads Markdown into, with the same names and attributes, so the
// live document's `Y.XmlFragment` is what both read and write. A node or attribute added here is
// added there too, or the server writes it back as nothing.

/** A `> [!NOTE]` quote: a block of blocks of one kind. */
export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (element) => element.getAttribute("data-callout") ?? "note",
        renderHTML: (attrs) => ({ "data-callout": attrs.kind }),
      },
    }
  },
  parseHTML() {
    return [{ tag: "aside[data-callout]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { class: "sixb-callout" }), 0]
  },
})

/** Markdown the editor does not model, a footnote or raw HTML, kept as it was written. */
export const MarkdownBlock = Node.create({
  name: "markdown",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { source: { default: "" } }
  },
  parseHTML() {
    return [{ tag: "pre[data-markdown]", getAttrs: (element) => ({ source: element.textContent }) }]
  },
  renderHTML({ node }) {
    return ["pre", { "data-markdown": "", class: "sixb-editor-verbatim" }, node.attrs.source]
  },
})

/** The same, within a line of text. */
export const MarkdownInline = Node.create({
  name: "markdownInline",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { source: { default: "" } }
  },
  parseHTML() {
    return [
      { tag: "code[data-markdown]", getAttrs: (element) => ({ source: element.textContent }) },
    ]
  },
  renderHTML({ node }) {
    return ["code", { "data-markdown": "", class: "sixb-editor-verbatim" }, node.attrs.source]
  },
})

/** A table cell's column alignment, which GFM keeps on its delimiter row. */
const align = {
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => element.style.textAlign || null,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.align ? { style: `text-align: ${attrs.align}` } : {},
  },
}

/** A fenced code block: its language, and the rest of its info string. */
export const CodeBlockWithMeta = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), meta: { default: null, rendered: false } }
  },
})

/**
 * A header cell, with its column's alignment. A Markdown cell holds one line of words: its
 * paragraphs, each a line, and no other block.
 */
const AlignedHeader = TableHeader.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), ...align }
  },
})

/** A body cell, with its column's alignment, and words alone. */
const AlignedCell = TableCell.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), ...align }
  },
})

/** A figure: an image alone in its paragraph, its title its caption. */
export const Figure = Image.extend({
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    }
  },
}).configure({ inline: false, allowBase64: false })

/**
 * The document's schema. `codeBlock` keeps its info string's meta, a heading its level, an
 * ordered list its start: what writing it back as Markdown needs.
 */
export function documentSchemaExtensions(
  options: { readonly callout?: AnyExtension } = {}
): AnyExtension[] {
  return [
    StarterKit.configure({
      // Undo is the live document's own, and nothing is added to a document because it opened.
      undoRedo: false,
      trailingNode: false,
      underline: false,
      // A document's link opens where its reader decides: no target, no rel, as Markdown has none.
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: { target: null, rel: null },
      },
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    CodeBlockWithMeta,
    options.callout ?? CalloutNode,
    MarkdownBlock,
    MarkdownInline,
    Figure,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    AlignedHeader,
    AlignedCell,
  ]
}

export { CALLOUT_KINDS }
