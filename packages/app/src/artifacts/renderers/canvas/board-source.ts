import { type BoardFramePatch, boardElement } from "@sixb/core/artifacts/live"

// What an element of a board's page holds in its start tag, read from the page's source as the
// live document has it: its inline style, an image's picture and description. The properties
// panel shows them as they are written; what a stylesheet sets is the page's and shows nothing.

/** An attribute of the element at `address`, as its start tag writes it; null without. */
export function boardAttribute(source: string, address: string, name: string): string | null {
  const element = boardElement(source, address)
  if (!element) return null

  const tag = startTag(source.slice(element.start, element.end))
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i")
  const match = pattern.exec(tag)
  if (!match) return null
  return decodeAttribute(match[2] ?? match[3] ?? match[4] ?? "")
}

/** The element's inline style, property by property, as it is written. */
export function boardInlineStyle(
  source: string,
  address: string
): Readonly<Record<string, string>> {
  const style = boardAttribute(source, address, "style") ?? ""
  const declarations: Record<string, string> = {}
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon <= 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (property && value) declarations[property] = value
  }
  return declarations
}

/** An element's start tag: up to its first `>` outside a quoted value. */
function startTag(html: string): string {
  let quote: string | null = null
  for (let index = 0; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === ">") return html.slice(0, index)
  }
  return html
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** A file's path in the artifact from a reference a board's page makes to it, relative to the page. */
export function boardReferencePath(board: string, reference: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^\/|^#/i.test(reference)) return null

  const parts = board.split("/").slice(0, -1)
  for (const part of reference.split(/[?#]/)[0]?.split("/") ?? []) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    try {
      parts.push(decodeURIComponent(part))
    } catch {
      return null
    }
  }
  return parts.join("/")
}

/**
 * Patches a frame can show now: an image's picture the frame's version does not hold yet is shown
 * from its preview when the reader has one, as an image they just uploaded, and else is left as
 * it is, its element waiting for the frame to load a version that holds it. `waiting` says
 * whether any does.
 */
export function showablePatches(
  patches: readonly BoardFramePatch[],
  board: string,
  holds: (path: string) => boolean,
  previews: ReadonlyMap<string, string>
): { readonly patches: BoardFramePatch[]; readonly waiting: boolean } {
  let waiting = false
  const shown: BoardFramePatch[] = []

  for (const patch of patches) {
    const src = patch.attributes?.src
    const path = src === undefined ? null : boardReferencePath(board, src)
    if (src === undefined || path === null || holds(path)) {
      shown.push(patch)
      continue
    }

    const preview = previews.get(path)
    if (preview && patch.attributes) {
      shown.push({ ...patch, attributes: { ...patch.attributes, src: preview } })
      continue
    }
    waiting = true
  }
  return { patches: shown, waiting }
}
