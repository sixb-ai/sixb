import { CALLOUT_KINDS } from "../renderers/document-tree"
import type { DOMSpec } from "./core/dom"
import { type Attrs, type Node, Schema } from "./core/model"

// The blocks a Markdown document is made of, as the editor's schema: the nodes and marks core's
// `artifacts/live/blocks.ts` reads Markdown into, with the same names and attributes, so the
// live document's `Y.XmlFragment` is what both read and write. A node or attribute added here is
// added there too, or the server writes it back as nothing.

/** An attribute read from an element as a typed value: a number, a boolean, or the text. */
function fromString(value: string | null): unknown {
  if (value === null) return null
  if (/^[+-]?(?:\d*\.)?\d+$/.test(value)) return Number(value)
  if (value === "true") return true
  if (value === "false") return false
  return value
}

/** The attributes `names` an element carries, by the same names, where it has them. */
function read(element: HTMLElement, names: readonly string[], base: Attrs = {}): Attrs {
  const attrs: Record<string, unknown> = { ...base }
  for (const name of names) {
    const value = fromString(element.getAttribute(name))
    if (value !== null) attrs[name] = value
  }
  return attrs
}

/** A table cell's column alignment, which GFM keeps on its delimiter row. */
function alignOf(element: HTMLElement): string | null {
  const align = (
    (element.style.textAlign || "").trim() || (element.getAttribute("align") ?? "").trim()
  ).toLowerCase()
  return align === "left" || align === "right" || align === "center" ? align : null
}

function cellAttrs(element: HTMLElement): Attrs {
  const attrs: Record<string, unknown> = { ...read(element, ["colspan", "rowspan"]) }
  const colwidth = element.getAttribute("colwidth")
  if (colwidth) attrs.colwidth = colwidth.split(",").map((width) => Number.parseInt(width, 10))
  const align = alignOf(element)
  if (align) attrs.align = align
  return attrs
}

function cellDOM(tag: "td" | "th"): (node: Node) => DOMSpec {
  return (node) => {
    const attrs: Record<string, unknown> = {}
    if (node.attrs.colspan !== 1 && node.attrs.colspan !== null) attrs.colspan = node.attrs.colspan
    if (node.attrs.rowspan !== 1 && node.attrs.rowspan !== null) attrs.rowspan = node.attrs.rowspan
    if (node.attrs.colwidth) attrs.colwidth = (node.attrs.colwidth as number[]).join(",")
    const align = node.attrs.align
    if (align === "left" || align === "right" || align === "center")
      attrs.style = `text-align: ${align}`
    return [tag, attrs, 0]
  }
}

const CELL_ATTRS = { colspan: 1, rowspan: 1, colwidth: null, align: null }

/** Where a link may point: not a script. */
export function isAllowedUri(uri: string): boolean {
  const address = uri.replace(/[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g, "")
  return !/^(?:javascript|vbscript|data):/i.test(address) || /^data:image\//i.test(address)
}

/** The document's schema: `codeBlock` keeps its info string's meta, a heading its level, a list its start. */
export const documentSchema = new Schema({
  nodes: [
    [
      "paragraph",
      { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    ],
    [
      "blockquote",
      {
        content: "block+",
        group: "block",
        defining: true,
        parseDOM: [{ tag: "blockquote" }],
        toDOM: () => ["blockquote", 0],
      },
    ],
    [
      "bulletList",
      {
        content: "listItem+",
        group: "block list",
        parseDOM: [{ tag: "ul" }],
        toDOM: () => ["ul", 0],
      },
    ],
    ["doc", { content: "block+" }],
    [
      "hardBreak",
      {
        group: "inline",
        inline: true,
        selectable: false,
        parseDOM: [{ tag: "br" }],
        toDOM: () => ["br"],
        leafText: () => "\n",
      },
    ],
    [
      "heading",
      {
        content: "inline*",
        group: "block",
        defining: true,
        attrs: { level: 1 },
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
          tag: `h${level}`,
          getAttrs: () => ({ level }),
        })),
        toDOM: (node) => [`h${node.attrs.level}`, 0],
      },
    ],
    ["horizontalRule", { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] }],
    [
      "listItem",
      {
        content: "paragraph block*",
        defining: true,
        parseDOM: [{ tag: "li" }],
        toDOM: () => ["li", 0],
      },
    ],
    [
      "orderedList",
      {
        content: "listItem+",
        group: "block list",
        attrs: { start: 1, type: null },
        parseDOM: [
          {
            tag: "ol",
            getAttrs: (element) => {
              const ol = element as HTMLElement
              return {
                start: ol.hasAttribute("start")
                  ? Number.parseInt(ol.getAttribute("start") ?? "", 10)
                  : 1,
                type: ol.getAttribute("type"),
              }
            },
          },
        ],
        toDOM: (node) => {
          const attrs: Record<string, unknown> = {}
          if (node.attrs.start !== 1) attrs.start = node.attrs.start
          if (node.attrs.type) attrs.type = node.attrs.type
          return ["ol", attrs, 0]
        },
      },
    ],
    ["text", { group: "inline" }],
    [
      "codeBlock",
      {
        content: "text*",
        group: "block",
        marks: "",
        code: true,
        defining: true,
        attrs: { language: null, meta: null },
        parseDOM: [
          {
            tag: "pre",
            preserveWhitespace: "full",
            getAttrs: (element) => {
              const classes = Array.from(
                (element as HTMLElement).firstElementChild?.classList ?? []
              )
              const language =
                classes.find((name) => name.startsWith("language-"))?.replace("language-", "") ??
                null
              return { language, meta: fromString((element as HTMLElement).getAttribute("meta")) }
            },
          },
        ],
        toDOM: (node) => [
          "pre",
          {},
          ["code", { class: node.attrs.language ? `language-${node.attrs.language}` : null }, 0],
        ],
      },
    ],
    [
      "callout",
      {
        content: "block+",
        group: "block",
        defining: true,
        attrs: { kind: "note" },
        parseDOM: [
          {
            tag: "aside[data-callout]",
            getAttrs: (element) => ({
              kind: (element as HTMLElement).getAttribute("data-callout") ?? "note",
            }),
          },
        ],
        toDOM: (node) => ["aside", { "data-callout": node.attrs.kind, class: "sixb-callout" }, 0],
      },
    ],
    [
      "markdown",
      {
        group: "block",
        atom: true,
        selectable: true,
        draggable: true,
        attrs: { source: "" },
        parseDOM: [
          {
            tag: "pre[data-markdown]",
            getAttrs: (element) => ({ source: (element as HTMLElement).textContent }),
          },
        ],
        toDOM: (node) => [
          "pre",
          { "data-markdown": "", class: "sixb-editor-verbatim" },
          String(node.attrs.source),
        ],
      },
    ],
    [
      "markdownInline",
      {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { source: "" },
        parseDOM: [
          {
            tag: "code[data-markdown]",
            getAttrs: (element) => ({ source: (element as HTMLElement).textContent }),
          },
        ],
        toDOM: (node) => [
          "code",
          { "data-markdown": "", class: "sixb-editor-verbatim" },
          String(node.attrs.source),
        ],
      },
    ],
    [
      "image",
      {
        group: "block",
        draggable: true,
        attrs: { src: null, alt: null, title: null },
        parseDOM: [
          {
            tag: 'img[src]:not([src^="data:"])',
            getAttrs: (element) => read(element as HTMLElement, ["src", "alt", "title"]),
          },
        ],
        toDOM: (node) => [
          "img",
          { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title },
        ],
      },
    ],
    [
      "taskList",
      {
        content: "taskItem+",
        group: "block list",
        parseDOM: [{ tag: 'ul[data-type="taskList"]', priority: 51 }],
        toDOM: () => ["ul", { "data-type": "taskList" }, 0],
      },
    ],
    [
      "taskItem",
      {
        content: "paragraph block*",
        defining: true,
        attrs: { checked: false },
        parseDOM: [
          {
            tag: 'li[data-type="taskItem"]',
            priority: 51,
            getAttrs: (element) => {
              const checked = (element as HTMLElement).getAttribute("data-checked")
              return { checked: checked === "" || checked === "true" }
            },
          },
        ],
        toDOM: (node) => [
          "li",
          { "data-type": "taskItem", "data-checked": String(node.attrs.checked) },
          [
            "label",
            ["input", { type: "checkbox", checked: node.attrs.checked ? "checked" : null }],
            ["span"],
          ],
          ["div", 0],
        ],
      },
    ],
    [
      "table",
      {
        content: "tableRow+",
        group: "block",
        isolating: true,
        tableRole: "table",
        parseDOM: [{ tag: "table" }],
        toDOM: (node) => {
          const columns = node.firstChild?.childCount ?? 0
          return [
            "table",
            { style: `min-width: ${columns * 25}px` },
            [
              "colgroup",
              ...Array.from({ length: columns }, () => ["col", { style: "min-width: 25px" }]),
            ],
            ["tbody", 0],
          ]
        },
      },
    ],
    [
      "tableRow",
      {
        content: "(tableCell | tableHeader)*",
        tableRole: "row",
        parseDOM: [{ tag: "tr" }],
        toDOM: () => ["tr", 0],
      },
    ],
    [
      "tableHeader",
      {
        content: "paragraph+",
        isolating: true,
        tableRole: "header_cell",
        attrs: CELL_ATTRS,
        parseDOM: [{ tag: "th", getAttrs: (element) => cellAttrs(element as HTMLElement) }],
        toDOM: cellDOM("th"),
      },
    ],
    [
      "tableCell",
      {
        content: "paragraph+",
        isolating: true,
        tableRole: "cell",
        attrs: CELL_ATTRS,
        parseDOM: [{ tag: "td", getAttrs: (element) => cellAttrs(element as HTMLElement) }],
        toDOM: cellDOM("td"),
      },
    ],
  ],
  marks: [
    [
      "link",
      {
        inclusive: true,
        attrs: { href: null, target: null, rel: null, class: null, title: null },
        parseDOM: [
          {
            tag: "a[href]",
            getAttrs: (element) => {
              const href = (element as HTMLElement).getAttribute("href")
              if (!href || !isAllowedUri(href)) return false
              return read(element as HTMLElement, ["href", "target", "rel", "class", "title"])
            },
          },
        ],
        toDOM: (mark) => {
          const href =
            typeof mark.attrs.href === "string" && isAllowedUri(mark.attrs.href)
              ? mark.attrs.href
              : ""
          return [
            "a",
            {
              href,
              target: mark.attrs.target,
              rel: mark.attrs.rel,
              class: mark.attrs.class,
              title: mark.attrs.title,
            },
            0,
          ]
        },
      },
    ],
    [
      "bold",
      {
        parseDOM: [
          { tag: "strong" },
          {
            tag: "b",
            getAttrs: (element) => (element as HTMLElement).style.fontWeight !== "normal" && null,
          },
          { style: "font-weight=400", clearMark: (mark) => mark.type.name === "bold" },
          {
            style: "font-weight",
            getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null,
          },
        ],
        toDOM: () => ["strong", 0],
      },
    ],
    ["code", { excludes: "_", code: true, parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] }],
    [
      "italic",
      {
        parseDOM: [
          { tag: "em" },
          {
            tag: "i",
            getAttrs: (element) => (element as HTMLElement).style.fontStyle !== "normal" && null,
          },
          { style: "font-style=normal", clearMark: (mark) => mark.type.name === "italic" },
          { style: "font-style=italic" },
        ],
        toDOM: () => ["em", 0],
      },
    ],
    [
      "strike",
      {
        parseDOM: [
          { tag: "s" },
          { tag: "del" },
          { tag: "strike" },
          {
            style: "text-decoration",
            getAttrs: (value) => ((value as string).includes("line-through") ? {} : false),
          },
        ],
        toDOM: () => ["s", 0],
      },
    ],
  ],
})

export { CALLOUT_KINDS }
