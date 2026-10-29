/** A problem the layout probe found on a slide or a page, where it is, and its text. */
export interface LayoutProblem {
  readonly code:
    | "outside"
    | "footer"
    | "wide"
    | "overlap"
    | "clipped"
    | "small_text"
    | "small_target"
    | "contrast"
    | "broken_image"
  /** In the slide's 1280×720 pixels, or the page's from its top left. */
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /** The element's text, shortened, or its tag when it has none. */
  readonly text: string
  /** The element as CSS names it, `p.eyebrow`: the same problem on many slides shares it. */
  readonly selector: string
  /** `small_text`: its size in pixels. `contrast`: the ratio, and the two colors. */
  readonly size?: number
  /** `overlap`: the text it overlaps. */
  readonly other?: string
  readonly ratio?: number
  readonly colors?: readonly [string, string]
}

/**
 * Measures a slide the frame shows, laid out at its own size (`sixb-fill`), or the whole page, and
 * returns what a reader would find wrong with it. Run in the frame as its own source,
 * `(${layoutProbe})(3)` or `(${layoutProbe})("page")`, so it names nothing outside itself.
 *
 * - `outside` (a slide): text or an image past the slide's edge, which the slide cuts off.
 * - `footer` (a slide): text or an image over the footer's rule, the source, or the number.
 * - `wide` (a page): text or an image past the window's right edge, outside any box that scrolls
 *   sideways, which makes the whole page scroll sideways.
 * - `overlap`: text drawn over other text, line box on line box.
 * - `clipped`: text its own box cuts off.
 * - `small_text`: text under 18px on a slide, 12px on a page, as drawn, an SVG's scaled with it.
 * - `small_target` (a page): a button, field, or other control under 24px either way.
 * - `contrast`: text under WCAG AA against the solid colors painted under it, its own box's,
 *   any box it overlaps, and an SVG shape's fill (4.5:1, or 3:1 from 24px, or 18.66px bold); text
 *   over an image or a gradient is not judged.
 * - `broken_image`: an image of the deck's own that did not load.
 *
 * Another artifact's chart or image is a box here, sized as its host sizes it: it is measured as
 * one, and its content is the app's. A page is measured where the viewport shows it, so the check
 * sizes the viewport to the page first.
 */
export function layoutProbe(scope: number | "page"): LayoutProblem[] {
  const MAX_PER_CODE = 8
  const page = scope === "page"
  const slide = page
    ? document.body
    : document.querySelectorAll<HTMLElement>("section.slide")[scope - 1]
  if (!slide) return []
  const box = page
    ? document.documentElement.getBoundingClientRect()
    : slide.getBoundingClientRect()
  const problems: LayoutProblem[] = []
  const counts = new Map<string, number>()
  const selector = (element: Element) =>
    element instanceof SVGElement && element.tagName.toLowerCase() !== "svg"
      ? `svg ${element.tagName.toLowerCase()}`
      : [element.tagName.toLowerCase(), ...Array.from(element.classList).slice(0, 2)].join(".")
  const report = (
    code: LayoutProblem["code"],
    element: Element,
    details: Pick<LayoutProblem, "size" | "ratio" | "colors" | "other"> & { text?: string } = {}
  ) => {
    const count = counts.get(code) ?? 0
    if (count >= MAX_PER_CODE) return
    counts.set(code, count + 1)
    problems.push({
      code,
      rect: at(element.getBoundingClientRect()),
      selector: selector(element),
      ...details,
      text: details.text ?? describe(element),
    })
  }
  const at = (rect: DOMRect) => ({
    x: Math.round(rect.left - box.left),
    y: Math.round(rect.top - box.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  })
  // The text as a reader sees it: a line break separates words.
  const describe = (element: Element) =>
    (element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || element.tagName.toLowerCase()
  const shown = (element: Element) => {
    const style = getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const ownText = (element: Element) =>
    Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""
    )
  const media = (element: Element) =>
    /^(img|svg|canvas|video|picture|table|sixb-embed)$/i.test(element.tagName)

  // What a reader sees: elements with text of their own, and media. Each judged once.
  const elements = Array.from(slide.querySelectorAll("*")).filter(
    (element) => !element.closest("svg *, .source") && shown(element)
  )
  const content = elements.filter((element) => ownText(element) || media(element))
  const svgText = Array.from(slide.querySelectorAll<SVGTextContentElement>("svg text")).filter(
    (element) => (element.textContent ?? "").trim() !== "" && shown(element)
  )

  // Past the slide's edge, or over the footer; on a page, past the window's right edge. The
  // outermost offender stands for what it holds.
  const footer = getComputedStyle(slide, "::after")
  const footerTop =
    page || footer.content === "none" || footer.display === "none"
      ? Number.POSITIVE_INFINITY
      : box.bottom -
        Number.parseFloat(footer.bottom) -
        Number.parseFloat(footer.paddingTop) -
        Number.parseFloat(footer.lineHeight) -
        Number.parseFloat(footer.borderTopWidth)
  // The footer's rule spans these columns; a deck may narrow it beside an edge-to-edge image.
  const footerLeft = box.left + (Number.parseFloat(footer.left) || 0)
  const footerRight = box.right - (Number.parseFloat(footer.right) || 0)
  // An image that reaches the slide's bottom edge is drawn behind the footer on purpose: a
  // backdrop or an edge-to-edge photo. The kit's footer sits over it.
  const bleeds = (element: Element, rect: DOMRect) =>
    /^(img|picture|video|canvas)$/i.test(element.tagName) && rect.bottom >= box.bottom - 1
  const outside: Element[] = []
  // A box that scrolls sideways holds what is wider than the window, as a wide table's does.
  const scrolls = (element: Element) => {
    for (let node = element.parentElement; node && node !== slide; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowX)) return true
    }
    return false
  }
  for (const element of content) {
    if (outside.some((parent) => parent.contains(element))) continue
    const rect = element.getBoundingClientRect()
    if (page) {
      if (rect.right > window.innerWidth + 1 && !scrolls(element)) {
        outside.push(element)
        report("wide", element)
      }
      continue
    }
    if (
      rect.left < box.left - 1 ||
      rect.top < box.top - 1 ||
      rect.right > box.right + 1 ||
      rect.bottom > box.bottom + 1
    ) {
      outside.push(element)
      report("outside", element)
    } else if (
      rect.bottom > footerTop + 1 &&
      rect.top < box.bottom &&
      rect.right > footerLeft + 1 &&
      rect.left < footerRight - 1 &&
      !bleeds(element, rect)
    ) {
      outside.push(element)
      report("footer", element)
    }
  }

  // Text over text: the lines each element's own text draws, against every other's. A range's
  // rectangle spans the font's whole ascent and descent, which a tight line-height (a stat's
  // number) leaves well outside its line: each is cut to its line-height around its middle.
  const lines = content
    .filter((element) => ownText(element) && !outside.some((parent) => parent.contains(element)))
    .map((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      const rects: DOMRect[] = []
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() === "") continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0) continue
          const inset =
            Number.isFinite(lineHeight) && rect.height > lineHeight
              ? (rect.height - lineHeight) / 2
              : 0
          rects.push(new DOMRect(rect.x, rect.y + inset, rect.width, rect.height - inset * 2))
        }
      }
      return { element, rects }
    })
  const crosses = (a: DOMRect, b: DOMRect) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3
  const overlapping = new Set<Element>()
  for (const [index, a] of lines.entries()) {
    for (const b of lines.slice(index + 1)) {
      if (overlapping.has(a.element) || overlapping.has(b.element)) continue
      if (a.rects.some((rectA) => b.rects.some((rectB) => crosses(rectA, rectB)))) {
        overlapping.add(a.element)
        overlapping.add(b.element)
        report("overlap", b.element, { other: describe(a.element) })
      }
    }
  }

  // Cut off by its own box.
  for (const element of elements) {
    if (outside.some((parent) => parent.contains(element) || element.contains(parent))) continue
    const style = getComputedStyle(element)
    const clips = /hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)
    if (!clips || (element.textContent ?? "").trim() === "") continue
    const wraps = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap"
    if (
      !wraps &&
      (element.scrollHeight > element.clientHeight + 2 ||
        element.scrollWidth > element.clientWidth + 2)
    ) {
      report("clipped", element)
    }
  }

  // Colors as the screen shows them: any CSS color, through a canvas pixel.
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })
  const rgba = (color: string): [number, number, number, number] | null => {
    if (!context) return null
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = "rgba(0, 0, 0, 0)"
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (
    top: [number, number, number, number],
    under: [number, number, number, number]
  ): [number, number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
    1,
  ]
  /**
   * The solid color painted under an element's text, or null over an image or a gradient, or out
   * of the window: every
   * box under its center, top to bottom, its own and its ancestors' and any it overlaps, until an
   * opaque one.
   */
  const background = (element: Element): [number, number, number, number] | null => {
    const layers: [number, number, number, number][] = []
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    // Out of the window, as a wide table's far cells are in the box it scrolls in, nothing is
    // under the point to measure.
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null
    const stack = document.elementsFromPoint(x, y)
    // An SVG's text is not hit between its glyphs: then everything under the point counts.
    const start = Math.max(0, stack.indexOf(element))
    const under = stack.slice(start)
    // A photo or a video paints colors no style names.
    const pictures = under.filter((node) => /^(img|picture|video|canvas)$/i.test(node.tagName))
    for (const node of under) {
      if (pictures.includes(node)) return null
      // A box holding the picture paints under it, though its ::before, a scrim over the photo,
      // puts it above the picture in the stack.
      if (pictures.some((picture) => node.contains(picture))) continue
      const style = getComputedStyle(node)
      // An SVG shape paints with its fill: a chart's label sits on its bar.
      const shape = node instanceof SVGGeometryElement
      const paint = shape ? style.fill : style.backgroundColor
      if ((!shape && style.backgroundImage !== "none") || paint.startsWith("url(")) return null
      const color = rgba(paint)
      if (color && shape) color[3] *= Number.parseFloat(style.fillOpacity) || 0
      if (color && color[3] > 0) {
        layers.push(color)
        if (color[3] >= 0.99) break
      }
    }
    return layers.reduceRight<[number, number, number, number]>(
      (under, top) => over(top, under),
      [255, 255, 255, 1]
    )
  }
  const luminance = ([r, g, b]: readonly number[]) => {
    const channel = (value = 0) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const hex = (color: readonly number[]) =>
    `#${color
      .slice(0, 3)
      .map((value) => Math.round(value).toString(16).padStart(2, "0"))
      .join("")}`

  // Text: its size as drawn, and its contrast.
  const texts: { element: Element; size: number; ink: string }[] = [
    ...content
      .filter((element) => ownText(element))
      .map((element) => {
        const style = getComputedStyle(element)
        return { element, size: Number.parseFloat(style.fontSize), ink: style.color }
      }),
    ...svgText.map((element) => {
      const style = getComputedStyle(element)
      const scale = element.getScreenCTM()?.a ?? 1
      return { element, size: Number.parseFloat(style.fontSize) * scale, ink: style.fill }
    }),
  ]
  for (const { element, size, ink } of texts) {
    if (outside.some((parent) => parent.contains(element))) continue
    if (size < (page ? 11.5 : 17.5)) {
      report("small_text", element, { size: Math.round(size * 10) / 10 })
    }
    const color = rgba(ink)
    const behind = background(element)
    if (!color || color[3] === 0 || !behind) continue
    const solid = over(color, behind)
    const [light, dark] = [luminance(solid), luminance(behind)].sort((a, b) => b - a)
    const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
    const bold = Number.parseInt(getComputedStyle(element).fontWeight, 10) >= 700
    const needed = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
    if (ratio < needed) {
      report("contrast", element, {
        ratio: Math.round(ratio * 100) / 100,
        colors: [hex(solid), hex(behind)],
      })
    }
  }

  // A control a finger or a pointer can miss: WCAG's 24px minimum target, on a page.
  if (page) {
    const controls = slide.querySelectorAll(
      'button, select, textarea, summary, [role="button"], a.button, input:not([type="hidden"], [type="checkbox"], [type="radio"])'
    )
    for (const control of Array.from(controls)) {
      if (!shown(control)) continue
      const rect = control.getBoundingClientRect()
      if (rect.width < 23.5 || rect.height < 23.5) {
        report("small_target", control, {
          size: Math.round(Math.min(rect.width, rect.height)),
        })
      }
    }
  }

  // An image from another artifact is the app's to load, not the deck's.
  for (const image of Array.from(
    slide.querySelectorAll<HTMLImageElement>("img:not([data-sixb-ref])")
  )) {
    if (image.getAttribute("src") && image.complete && image.naturalWidth === 0) {
      report("broken_image", image, { text: image.getAttribute("src") ?? "img" })
    }
  }
  return problems
}
