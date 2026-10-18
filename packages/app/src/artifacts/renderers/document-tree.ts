import { createHeadingSlugger } from "@sixb/core/artifacts"
import {
  isElement,
  meaningfulChildren,
  type TreeElement,
  type TreeNode,
  type TreeRoot,
  type TreeText,
} from "../markdown-tree"

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

const CALLOUT_MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*\n?/i
// A figure like 1,234.5 or -$5.56M or (1.3%) or 3.2x: digits with an optional sign, currency, and
// unit. Dates and identifiers with letters in the middle stay text.
const NUMERIC_CELL = /^[-+−(]?\s?[$€£¥]?\s?\d[\d,.\s]*(?:%|[kKmMbB]|bn|x)?\)?$/

/**
 * Shapes a document's Markdown into the document page: the first heading becomes the title and the
 * paragraph after it the lede, headings get the slugs publishing gave them, `> [!NOTE]` quotes
 * become callouts, a titled image alone in its paragraph becomes a figure with a caption, and table
 * columns of figures align right.
 */
export function rehypeArtifactDocument() {
  return (tree: TreeRoot) => {
    markTitleAndLede(tree)
    slugHeadings(tree)
    visitElements(tree, (element, parent, index) => {
      if (element.tagName === "blockquote") shapeCallout(element)
      if (element.tagName === "p" && parent) shapeFigure(element, parent, index)
      if (element.tagName === "table") markNumericColumns(element)
    })
  }
}

function markTitleAndLede(tree: TreeRoot): void {
  const elements = tree.children.filter(isElement)
  const [first, second] = elements
  if (first?.tagName !== "h1") return
  addClass(first, "sixb-document-title")
  if (second?.tagName === "p") addClass(second, "sixb-document-lede")
}

function slugHeadings(tree: TreeRoot): void {
  const slug = createHeadingSlugger()
  visitElements(tree, (element) => {
    // Headings that already have an id, such as the footnotes label, keep it.
    if (!/^h[1-6]$/.test(element.tagName) || element.properties.id !== undefined) return
    element.properties.id = slug(textContent(element).replace(/\s+/g, " ").trim())
  })
}

function shapeCallout(blockquote: TreeElement): void {
  const paragraph = blockquote.children.find(isElement)
  const marker = paragraph?.tagName === "p" ? paragraph.children[0] : undefined
  if (!paragraph || marker?.type !== "text") return
  const text = marker as TreeText
  const match = CALLOUT_MARKER.exec(text.value)
  if (!match) return

  text.value = text.value.slice(match[0].length)
  if (text.value === "") paragraph.children.shift()
  if (
    paragraph.children.every((child) => child.type === "text" && !(child as TreeText).value.trim())
  ) {
    blockquote.children = blockquote.children.filter((child) => child !== paragraph)
  }
  blockquote.tagName = "aside"
  blockquote.properties = { ...blockquote.properties, dataCallout: match[1]?.toLowerCase() }
}

function shapeFigure(paragraph: TreeElement, parent: TreeElement | TreeRoot, index: number): void {
  const meaningful = meaningfulChildren(paragraph)
  const image = meaningful.length === 1 && isElement(meaningful[0]) ? meaningful[0] : undefined
  const caption = image?.tagName === "img" ? image.properties.title : undefined
  if (!image || typeof caption !== "string" || !caption.trim()) return

  const { title: _title, ...properties } = image.properties
  parent.children[index] = {
    type: "element",
    tagName: "figure",
    properties: {},
    children: [
      { ...image, properties },
      {
        type: "element",
        tagName: "figcaption",
        properties: {},
        children: [{ type: "text", value: caption.trim() }],
      },
    ],
  }
}

function markNumericColumns(table: TreeElement): void {
  const rows = collect(table, "tr")
  const header = rows.find((row) => row.children.some((cell) => isCell(cell, "th")))
  const body = rows.filter((row) => row !== header)
  // A loop, not a spread: a long table's rows are more arguments than a call can take.
  let width = 0
  for (const row of rows) width = Math.max(width, row.children.filter(isCellElement).length)

  for (let column = 0; column < width; column += 1) {
    const values = body
      .map((row) => row.children.filter(isCellElement)[column])
      .map((cell) => (cell ? textContent(cell).trim() : ""))
      .filter((value) => value !== "")
    if (values.length === 0 || !values.every((value) => NUMERIC_CELL.test(value))) continue
    for (const row of rows) {
      const cell = row.children.filter(isCellElement)[column]
      if (cell) addClass(cell, "sixb-numeric")
    }
  }
}

function visitElements(
  node: TreeRoot | TreeElement,
  visit: (element: TreeElement, parent: TreeElement | TreeRoot | null, index: number) => void
): void {
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!isElement(child)) continue
    visit(child, node, index)
    // A visit may replace the child (a paragraph that became a figure): walk what is there now.
    const current = children[index]
    if (isElement(current)) visitElements(current, visit)
  }
}

function collect(node: TreeElement, tagName: string): TreeElement[] {
  const found: TreeElement[] = []
  visitElements(node, (element) => {
    if (element.tagName === tagName) found.push(element)
  })
  return found
}

function textContent(node: TreeNode): string {
  if (node.type === "text") return (node as TreeText).value
  return "children" in node && node.children ? node.children.map(textContent).join("") : ""
}

function addClass(element: TreeElement, className: string): void {
  const current = element.properties.className
  const classes = Array.isArray(current) ? current : typeof current === "string" ? [current] : []
  element.properties.className = [...classes, className]
}

function isCellElement(node: TreeNode): node is TreeElement {
  return isCell(node, "th") || isCell(node, "td")
}

function isCell(node: TreeNode, tagName: "th" | "td"): boolean {
  return isElement(node) && node.tagName === tagName
}
