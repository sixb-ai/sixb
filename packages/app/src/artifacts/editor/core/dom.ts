// DOM helpers the view shares: drawing a node from its spec, measuring text, and telling whether
// two DOM positions are the same place.

/** How a node or mark is drawn: a tag, its attributes, and its children, `0` where content goes. */
export type DOMSpec = string | HTMLElement | readonly [string, ...unknown[]]

export interface Rendered {
  readonly dom: HTMLElement | Text
  readonly contentDOM: HTMLElement | null
}

/** Draws a spec in `document`, saying where its content goes. */
export function renderSpec(document: Document, spec: DOMSpec): Rendered {
  if (typeof spec === "string") return { dom: document.createTextNode(spec), contentDOM: null }
  if (!Array.isArray(spec)) return { dom: spec as HTMLElement, contentDOM: null }
  const [tag, ...rest] = spec as readonly [string, ...unknown[]]
  const element = document.createElement(tag)
  let contentDOM: HTMLElement | null = null
  let start = 0
  const first = rest[0]
  if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !(first instanceof globalThis.Node)
  ) {
    start = 1
    for (const [name, value] of Object.entries(first as Record<string, unknown>)) {
      if (value === null || value === undefined) continue
      // Through the style object, as ProseMirror sets it, which writes it back normalized.
      if (name === "style") element.style.cssText = String(value)
      else element.setAttribute(name, String(value))
    }
  }
  for (const child of rest.slice(start)) {
    if (child === 0) {
      contentDOM = element
      continue
    }
    const inner = renderSpec(document, child as DOMSpec)
    element.append(inner.dom)
    if (inner.contentDOM) contentDOM = inner.contentDOM
  }
  return { dom: element, contentDOM }
}

export function domIndex(node: globalThis.Node): number {
  let index = 0
  for (let current = node.previousSibling; current; current = current.previousSibling) index += 1
  return index
}

export function nodeSize(node: globalThis.Node): number {
  return node.nodeType === 3 ? (node.nodeValue ?? "").length : node.childNodes.length
}

export function isElement(node: globalThis.Node | null | undefined): node is HTMLElement {
  return !!node && node.nodeType === 1
}

export function isText(node: globalThis.Node | null | undefined): node is Text {
  return !!node && node.nodeType === 3
}

const ATOMS = /^(img|br|input|textarea|hr)$/i

/** Whether two DOM positions are the same place: across element edges, not into atoms. */
export function isEquivalentPosition(
  node: globalThis.Node,
  offset: number,
  target: globalThis.Node | null,
  targetOffset: number,
  hasDesc: (node: globalThis.Node) => boolean
): boolean {
  if (!target) return false
  return (
    scanFor(node, offset, target, targetOffset, -1, hasDesc) ||
    scanFor(node, offset, target, targetOffset, 1, hasDesc)
  )
}

function scanFor(
  start: globalThis.Node,
  startOffset: number,
  target: globalThis.Node,
  targetOffset: number,
  dir: number,
  hasDesc: (node: globalThis.Node) => boolean
): boolean {
  let node = start
  let offset = startOffset
  for (;;) {
    if (node === target && offset === targetOffset) return true
    if (offset === (dir < 0 ? 0 : nodeSize(node))) {
      const parent = node.parentNode
      if (
        !parent ||
        !isElement(parent) ||
        hasDesc(node) ||
        ATOMS.test(node.nodeName) ||
        (node as HTMLElement).contentEditable === "false"
      ) {
        return false
      }
      offset = domIndex(node) + (dir < 0 ? 0 : 1)
      node = parent
    } else if (isElement(node)) {
      const child = node.childNodes[offset + (dir < 0 ? -1 : 0)]
      if (!child || (isElement(child) && child.contentEditable === "false")) return false
      node = child
      offset = dir < 0 ? nodeSize(node) : 0
    } else {
      return false
    }
  }
}

export function textRange(node: Text, from = 0, to = node.nodeValue?.length ?? 0): Range {
  const range = node.ownerDocument.createRange()
  range.setEnd(node, to)
  range.setStart(node, from)
  return range
}

export interface Rect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** The rectangle at one side of what a range or element draws. */
export function singleRect(target: Range | HTMLElement, bias: number): DOMRect {
  const rects = target.getClientRects()
  return (
    rects.length ? rects[bias < 0 ? 0 : rects.length - 1] : target.getBoundingClientRect()
  ) as DOMRect
}

export function inRect(coords: { left: number; top: number }, rect: Rect): boolean {
  return (
    coords.left >= rect.left - 1 &&
    coords.left <= rect.right + 1 &&
    coords.top >= rect.top - 1 &&
    coords.top <= rect.bottom + 1
  )
}

/** A rectangle as a vertical line at its left or right edge. */
export function flattenV(rect: Rect, left: boolean): Rect {
  if (rect.right - rect.left === 0) return rect
  const x = left ? rect.left : rect.right
  return { top: rect.top, bottom: rect.bottom, left: x, right: x }
}

/** A rectangle as a horizontal line at its top or bottom edge. */
export function flattenH(rect: Rect, top: boolean): Rect {
  if (rect.bottom - rect.top === 0) return rect
  const y = top ? rect.top : rect.bottom
  return { top: y, bottom: y, left: rect.left, right: rect.right }
}

/** The caret position at a point, as the browser finds it. */
export function caretFromPoint(
  document: Document,
  x: number,
  y: number
): { node: globalThis.Node; offset: number } | null {
  const withPosition = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: globalThis.Node; offset: number } | null
  }
  if (withPosition.caretPositionFromPoint) {
    try {
      const position = withPosition.caretPositionFromPoint(x, y)
      if (position)
        return {
          node: position.offsetNode,
          offset: Math.min(nodeSize(position.offsetNode), position.offset),
        }
    } catch {
      // Firefox throws for points outside the document.
    }
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range
    ? {
        node: range.startContainer,
        offset: Math.min(nodeSize(range.startContainer), range.startOffset),
      }
    : null
}
