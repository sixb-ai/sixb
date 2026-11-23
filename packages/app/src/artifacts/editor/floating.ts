// Where a floating element goes beside a rectangle, as the editor's menus place themselves: above
// it and centered, or beside its first line; flipped below when there is no room above, kept a
// padding inside what clips it, then set off by a gap.
//
// The arithmetic is floating-ui's (MIT), step for step and in its order: sizes come from computed
// style, a scaled offset parent is divided out, and flip, shift and the gap apply in that order.
// The browser truncates a fractional `left` to 1/64 px, so the same position reached another way
// can draw a fraction of a pixel apart. Written for an element positioned `absolute`.

/** A rectangle in viewport coordinates, as `getBoundingClientRect` returns one. */
export interface FloatingRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface FloatingOptions {
  readonly placement: "top" | "left-start"
  /** Below instead, when there is no room above. */
  readonly flip?: boolean
  /** How far inside what clips it the element is kept. */
  readonly shift?: number
  /** The gap between the rectangle and the element. */
  readonly offset?: number
}

type Placement = "top" | "bottom" | "left-start"

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Sides {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

interface Scale {
  readonly x: number
  readonly y: number
}

/** The element's position in its offset parent's coordinates, for `position: absolute`. */
export function floatingPosition(
  reference: FloatingRect,
  floating: HTMLElement,
  options: FloatingOptions
): { x: number; y: number } {
  const doc = floating.ownerDocument
  const parent = offsetParentOf(floating)
  const scale = parent ? scaleOf(parent) : { x: 1, y: 1 }
  const anchor = relativeTo(reference, doc, parent, scale)
  const { width, height } = cssSize(floating)
  const clip = options.flip || options.shift !== undefined ? clippingRect(floating) : null
  const overflow = (x: number, y: number, padding: number): Sides => {
    const rect = toViewport({ x, y, width, height }, doc, parent, scale)
    const edges = clip as Sides
    return {
      top: (edges.top - rect.y + padding) / scale.y,
      bottom: (rect.y + rect.height - edges.bottom + padding) / scale.y,
      left: (edges.left - rect.x + padding) / scale.x,
      right: (rect.x + rect.width - edges.right + padding) / scale.x,
    }
  }

  let placement: Placement = options.placement
  if (options.flip && placement === "top") {
    // Above if it fits there, else below if that fits; else wherever its own side fits, else
    // wherever overflows least, keeping above when they tie.
    const tries = (["top", "bottom"] as const).map((side) => {
      const at = coordsAt(anchor, width, height, side)
      const sides = overflow(at.x, at.y, 0)
      const across = anchor.width > width ? [sides.right, sides.left] : [sides.left, sides.right]
      return { side, overflows: [sides[side], ...across] }
    })
    const fits = tries.find((each) => each.overflows.every((value) => value <= 0))
    const sideFits = tries.filter((each) => (each.overflows[0] as number) <= 0)
    const sum = (values: number[]) =>
      values.filter((value) => value > 0).reduce((total, value) => total + value, 0)
    placement = (
      fits ??
      sideFits.sort((a, b) => (a.overflows[1] as number) - (b.overflows[1] as number))[0] ??
      tries.sort((a, b) => sum(a.overflows) - sum(b.overflows))[0]
    )?.side as Placement
  }

  let { x, y } = coordsAt(anchor, width, height, placement)
  if (options.shift !== undefined) {
    const sides = overflow(x, y, options.shift)
    x = Math.max(x + sides.left, Math.min(x, x - sides.right))
  }
  const offset = options.offset ?? 0
  if (placement === "top") y -= offset
  else if (placement === "bottom") y += offset
  else x -= offset
  return { x, y }
}

/** Where the element goes against `reference`, before it is flipped, shifted or set off. */
function coordsAt(
  reference: Box,
  width: number,
  height: number,
  placement: Placement
): { x: number; y: number } {
  const centerX = reference.x + reference.width / 2 - width / 2
  if (placement === "top") return { x: centerX, y: reference.y - height }
  if (placement === "bottom") return { x: centerX, y: reference.y + reference.height }
  const centerY = reference.y + reference.height / 2 - height / 2
  return { x: reference.x - width, y: centerY - (reference.height / 2 - height / 2) }
}

/** The element's size as its computed style gives it, or its offset size when the two disagree. */
function cssSize(element: HTMLElement): { width: number; height: number; fallback: boolean } {
  const style = getComputedStyle(element)
  const width = Number.parseFloat(style.width) || 0
  const height = Number.parseFloat(style.height) || 0
  if (Math.round(width) !== element.offsetWidth || Math.round(height) !== element.offsetHeight) {
    return { width: element.offsetWidth, height: element.offsetHeight, fallback: true }
  }
  return { width, height, fallback: false }
}

/** How much larger an element draws than its own size says, as a transform scales it. */
function scaleOf(element: HTMLElement): Scale {
  const rect = element.getBoundingClientRect()
  const { width, height, fallback } = cssSize(element)
  const x = (fallback ? Math.round(rect.width) : rect.width) / width
  const y = (fallback ? Math.round(rect.height) : rect.height) / height
  return { x: x && Number.isFinite(x) ? x : 1, y: y && Number.isFinite(y) ? y : 1 }
}

/** What the element is positioned against: an element, or null for the document. */
function offsetParentOf(element: HTMLElement): HTMLElement | null {
  const trueParent = (of: HTMLElement): HTMLElement | null => {
    if (getComputedStyle(of).position === "fixed") return null
    const parent = of.offsetParent as HTMLElement | null
    return parent === of.ownerDocument.documentElement ? of.ownerDocument.body : parent
  }
  const isStatic = (of: HTMLElement) => getComputedStyle(of).position === "static"
  let parent = trueParent(element)
  while (parent && /^(TABLE|TD|TH)$/.test(parent.tagName) && isStatic(parent))
    parent = trueParent(parent)
  const root =
    parent === element.ownerDocument.body || parent === element.ownerDocument.documentElement
  if (parent && root && isStatic(parent) && !isContainingBlock(getComputedStyle(parent)))
    return null
  return parent
}

/** `rect` in the offset parent's coordinates, in its own unscaled pixels. */
function relativeTo(
  rect: FloatingRect,
  doc: Document,
  parent: HTMLElement | null,
  scale: Scale
): Box {
  const x = rect.left / scale.x
  const y = rect.top / scale.y
  const width = rect.width / scale.x
  const height = rect.height / scale.y
  if (!parent) {
    const html = doc.documentElement
    const view = doc.defaultView as Window
    const box = html.getBoundingClientRect()
    const scrollbar = box.left + html.scrollLeft
    const htmlX = box.left + view.scrollX - scrollbar
    return {
      x: x + view.scrollX - scrollbar - htmlX,
      y: y + view.scrollY - (box.top + view.scrollY),
      width,
      height,
    }
  }
  const scroll = scrollOf(parent)
  const box = parent.getBoundingClientRect()
  const left = box.left / scale.x + parent.clientLeft
  const top = box.top / scale.y + parent.clientTop
  return { x: x + scroll.left - left, y: y + scroll.top - top, width, height }
}

/** `rect` from the offset parent's coordinates back to the viewport's. */
function toViewport(rect: Box, doc: Document, parent: HTMLElement | null, scale: Scale): Box {
  const width = rect.width * scale.x
  const height = rect.height * scale.y
  if (!parent) {
    const html = doc.documentElement
    const view = doc.defaultView as Window
    const box = html.getBoundingClientRect()
    const htmlX = box.left + view.scrollX - (box.left + html.scrollLeft)
    return {
      x: rect.x - view.scrollX + htmlX,
      y: rect.y - view.scrollY + (box.top + view.scrollY),
      width,
      height,
    }
  }
  const scroll = scrollOf(parent)
  const box = parent.getBoundingClientRect()
  return {
    x: rect.x * scale.x - scroll.left * scale.x + (box.left + parent.clientLeft),
    y: rect.y * scale.y - scroll.top * scale.y + (box.top + parent.clientTop),
    width,
    height,
  }
}

/** An offset parent's scroll, which the body's lacks unless the page itself scrolls inside it. */
function scrollOf(parent: HTMLElement): { left: number; top: number } {
  const html = parent.ownerDocument.documentElement
  if (parent === parent.ownerDocument.body && !clips(getComputedStyle(html)))
    return { left: 0, top: 0 }
  return { left: parent.scrollLeft, top: parent.scrollTop }
}

/** The viewport, cut to every ancestor whose overflow hides the element. */
function clippingRect(element: HTMLElement): Sides {
  const doc = element.ownerDocument
  let { top, right, bottom, left } = viewportRect(doc)
  // An ancestor clips the element unless the element's containing block lies outside it.
  let chain = getComputedStyle(element).position
  for (
    let node = element.parentElement;
    node && node !== doc.body && node !== doc.documentElement;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node)
    if (
      !isContainingBlock(style) &&
      (chain === "fixed" || (chain === "absolute" && style.position === "static"))
    )
      continue
    chain = style.position
    if (!clips(style)) continue
    const box = node.getBoundingClientRect()
    const scale = scaleOf(node)
    const x = (box.left / scale.x + node.clientLeft) * scale.x
    const y = (box.top / scale.y + node.clientTop) * scale.y
    top = Math.max(y, top)
    right = Math.min(x + node.clientWidth * scale.x, right)
    bottom = Math.min(y + node.clientHeight * scale.y, bottom)
    left = Math.max(x, left)
  }
  return { top, right, bottom, left }
}

/** The visible viewport, less a scrollbar gutter the page reserves. */
function viewportRect(doc: Document): Sides {
  const html = doc.documentElement
  const visual = doc.defaultView?.visualViewport
  let width = visual ? visual.width : html.clientWidth
  const height = visual ? visual.height : html.clientHeight
  const x = visual && !isWebKit() ? visual.offsetLeft : 0
  const y = visual && !isWebKit() ? visual.offsetTop : 0
  if (html.getBoundingClientRect().left + html.scrollLeft <= 0) {
    const body = getComputedStyle(doc.body)
    const margins =
      doc.compatMode === "CSS1Compat"
        ? Number.parseFloat(body.marginLeft) + Number.parseFloat(body.marginRight) || 0
        : 0
    const reserved = Math.abs(html.clientWidth - doc.body.clientWidth - margins)
    const gutter =
      getComputedStyle(html).scrollbarGutter === "stable both-edges" ? reserved / 2 : reserved
    if (gutter <= 25) width -= gutter
  }
  return { top: y, right: x + width, bottom: y + height, left: x }
}

function clips(style: CSSStyleDeclaration): boolean {
  return (
    /auto|scroll|overlay|hidden|clip/.test(style.overflow + style.overflowY + style.overflowX) &&
    style.display !== "inline" &&
    style.display !== "contents"
  )
}

/** Whether an element contains absolutely positioned descendants though it is not positioned. */
function isContainingBlock(style: CSSStyleDeclaration): boolean {
  const set = (value: string) => !!value && value !== "none"
  return (
    set(style.transform) ||
    set(style.translate) ||
    set(style.scale) ||
    set(style.rotate) ||
    set(style.perspective) ||
    (!isWebKit() && (set(style.backdropFilter) || set(style.filter))) ||
    /transform|translate|scale|rotate|perspective|filter/.test(style.willChange || "") ||
    /paint|layout|strict|content/.test(style.contain || "")
  )
}

let webKit: boolean | undefined
function isWebKit(): boolean {
  webKit ??= typeof CSS !== "undefined" && CSS.supports("-webkit-backdrop-filter", "none")
  return webKit
}
