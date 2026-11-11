import type { ArtifactOutline } from "../outline"

/**
 * How the frame's runtime lays out what it serves: a deck shows 1280×720 slides scaled to fit, one
 * at a time or all at once; a page scrolls like any web page, as a canvas's boards do; a designed
 * document scrolls as one sheet, or as the pages its paper cuts it into.
 */
export type FrameLayout = "deck" | "page" | "document"

/**
 * A version's frame layout, or null for one Sixb draws natively: a Markdown document, a sheet, or
 * a file.
 */
export function frameLayout(version: { readonly outline: ArtifactOutline }): FrameLayout | null {
  switch (version.outline.kind) {
    case "slides":
      return "deck"
    case "page":
    case "canvas":
      return "page"
    case "document":
      return version.outline.format === "html" ? "document" : null
    default:
      return null
  }
}

/**
 * The files of a version its frame serves as pages, with the kit and the runtime first in their
 * `<head>`: a deck's, a page's or a designed document's entry, or each of a canvas's boards; none
 * for a version that does not open in a frame.
 */
export function frameEntries(version: {
  readonly entry: string
  readonly outline: ArtifactOutline
}): readonly string[] {
  if (version.outline.kind === "canvas") {
    return version.outline.items.flatMap((item) => (item.type === "board" ? [item.file] : []))
  }
  return frameLayout(version) ? [version.entry] : []
}
