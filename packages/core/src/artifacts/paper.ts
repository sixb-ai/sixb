/**
 * The sheet a designed document prints on, as its stylesheets' `@page` rule sets it, in CSS pixels
 * (96 to the inch): the page's size, and its margins. The app lays the document's pages out on it,
 * and the PDF prints on it.
 */
export interface DocumentPaper {
  readonly width: number
  readonly height: number
  readonly margin: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
}

const PX_PER_UNIT: Readonly<Record<string, number>> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
}

/** The named sizes CSS gives `size`, portrait, in millimetres or inches as their standard is. */
const PAGE_SIZES: Readonly<Record<string, readonly [string, string]>> = {
  a5: ["148mm", "210mm"],
  a4: ["210mm", "297mm"],
  a3: ["297mm", "420mm"],
  b5: ["176mm", "250mm"],
  b4: ["250mm", "353mm"],
  "jis-b5": ["182mm", "257mm"],
  "jis-b4": ["257mm", "364mm"],
  letter: ["8.5in", "11in"],
  legal: ["8.5in", "14in"],
  ledger: ["11in", "17in"],
}

/**
 * The paper the stylesheets ask for, read in the order the document applies them: the `size` and
 * margins of every unnamed, unqualified `@page` rule, a later one over an earlier one. Null when
 * none sets a size, or sets one Sixb can't measure (`auto`, or a length in `em`).
 */
export function readDocumentPaper(stylesheets: readonly string[]): DocumentPaper | null {
  let size: readonly [number, number] | null = null
  const margin: [number, number, number, number] = [0, 0, 0, 0]
  for (const css of stylesheets) {
    for (const declarations of pageRules(css)) {
      for (const [property, value] of declarations) {
        if (property === "size") {
          size = readSize(value) ?? size
        } else if (property === "margin") {
          const sides = readLengths(value)
          if (sides && sides.length <= 4) {
            const [top, right = top, bottom = top, left = right] = sides
            margin.splice(0, 4, top, right, bottom, left)
          }
        } else {
          const side = ["margin-top", "margin-right", "margin-bottom", "margin-left"].indexOf(
            property
          )
          const length = side === -1 ? null : readLength(value)
          if (length !== null) margin[side] = length
        }
      }
    }
  }
  if (!size) return null

  const round = (value: number) => Math.round(value * 100) / 100
  return {
    width: round(size[0]),
    height: round(size[1]),
    margin: {
      top: round(margin[0]),
      right: round(margin[1]),
      bottom: round(margin[2]),
      left: round(margin[3]),
    },
  }
}

/**
 * The declarations of each `@page { … }` rule in the CSS, in order, as `[property, value]` pairs.
 * A named page (`@page cover`) or one for some pages only (`@page :first`) is left out: it applies
 * to pages the document picks, not the sheet the document prints on. Margin boxes nested in a rule
 * (`@top-center { … }`) are skipped.
 */
function pageRules(css: string): (readonly [string, string])[][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const rules: (readonly [string, string])[][] = []
  const opening = /@page\b([^{;]*)\{/gi
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const body = blockAt(text, opening.lastIndex)
    opening.lastIndex += body.length
    if (match[1]?.trim()) continue

    // Only what sits at the rule's own level: nested blocks are margin boxes.
    let flat = ""
    let depth = 0
    for (const char of body) {
      if (char === "{") depth += 1
      else if (char === "}") depth -= 1
      else if (depth === 0) flat += char
    }
    rules.push(
      flat.split(";").flatMap((declaration) => {
        const colon = declaration.indexOf(":")
        if (colon === -1) return []
        const property = declaration.slice(0, colon).trim().toLowerCase()
        const value = declaration
          .slice(colon + 1)
          .replace(/!important\s*$/i, "")
          .trim()
          .toLowerCase()
        return property && value ? [[property, value] as const] : []
      })
    )
  }
  return rules
}

/** The text of the block that opened just before `start`, up to its closing brace. */
function blockAt(text: string, start: number): string {
  let depth = 1
  for (let index = start; index < text.length; index++) {
    if (text[index] === "{") depth += 1
    else if (text[index] === "}") depth -= 1
    if (depth === 0) return text.slice(start, index)
  }
  return text.slice(start)
}

function readSize(value: string): readonly [number, number] | null {
  const words = value.split(/\s+/)
  const orientation = words.find((word) => word === "portrait" || word === "landscape")
  const rest = words.filter((word) => word !== orientation)
  let size: readonly [number, number] | null = null
  if (rest.length === 1 && rest[0] && PAGE_SIZES[rest[0]]) {
    const [width, height] = PAGE_SIZES[rest[0]] as readonly [string, string]
    size = [readLength(width) as number, readLength(height) as number]
  } else if (rest.length === 0 && orientation) {
    size = [readLength("8.5in") as number, readLength("11in") as number]
  } else {
    const lengths = readLengths(rest.join(" "))
    if (lengths?.length === 1 && lengths[0]) size = [lengths[0], lengths[0]]
    else if (lengths?.length === 2 && lengths[0] && lengths[1]) size = [lengths[0], lengths[1]]
  }
  if (!size || size[0] <= 0 || size[1] <= 0) return null

  const [short, long] = size[0] <= size[1] ? size : [size[1], size[0]]
  if (orientation === "landscape") return [long, short]
  if (orientation === "portrait") return [short, long]
  return size
}

function readLengths(value: string): number[] | null {
  const lengths = value.split(/\s+/).map(readLength)
  return lengths.length > 0 && lengths.every((length) => length !== null)
    ? (lengths as number[])
    : null
}

function readLength(value: string): number | null {
  if (value === "0") return 0
  const match = /^(-?\d*\.?\d+)([a-z]+)$/.exec(value)
  const perUnit = match?.[2] ? PX_PER_UNIT[match[2]] : undefined
  if (!match || perUnit === undefined) return null
  const length = Number(match[1]) * perUnit
  return Number.isFinite(length) && length >= 0 ? length : null
}
