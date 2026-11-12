import type { DocumentPaper } from "./paper"
import type { ArtifactThemeMode } from "./theme"

/**
 * What a version contains, read from its files when it is published. Addresses resolve against
 * it, and previews and hover cards show it without opening the files.
 */
export type ArtifactOutline =
  | DocumentOutline
  | SheetOutline
  | SlidesOutline
  | PageOutline
  | CanvasOutline
  | FileOutline

export interface DocumentOutline {
  readonly kind: "document"
  readonly headings: readonly DocumentHeading[]
  /** `html` for a designed document, `document.html` with its own stylesheets; absent for Markdown. */
  readonly format?: "html"
  /** The sheet a designed document's `@page` rule sets, which gives it pages; absent without one. */
  readonly paper?: DocumentPaper
  /**
   * The object a designed document shows live data of, as `<meta name="sixb:object-type">` names
   * its type: the one object of that type that holds the document. Absent without the tag.
   */
  readonly holder?: DocumentHolder
}

/** What a designed document reads of the object that holds it. */
export interface DocumentHolder {
  readonly objectTypeId: string
  /** The links of the holder its fields read through, which reading the holder expands. */
  readonly links: readonly string[]
}

export interface DocumentHeading {
  readonly depth: number
  readonly text: string
  /** What `#part` names in an address to this section. */
  readonly slug: string
}

export interface SheetOutline {
  readonly kind: "sheet"
  readonly sheets: readonly SheetSummary[]
  /** The names of the charts declared in the workbook. */
  readonly charts: readonly string[]
}

export interface SheetSummary {
  readonly name: string
  /** The rows of its CSV; none for a live sheet, whose rows are each reader's. */
  readonly rows: number
  readonly columns: readonly string[]
  /** A live sheet's query, whose rows it shows. */
  readonly query?: string
}

export interface SlidesOutline {
  readonly kind: "slides"
  /** One entry per slide, in order; the title is the slide's first heading. */
  readonly slides: readonly { readonly title?: string }[]
}

export interface PageOutline {
  readonly kind: "page"
  /** The page's `<title>`, else its first heading. */
  readonly title?: string
}

export interface CanvasOutline {
  readonly kind: "canvas"
  /** The boards and sections an address can name, by id, in the canvas's order. */
  readonly items: readonly CanvasOutlineItem[]
  /**
   * The modes each board has a preview in: light and dark, or the one its `theme.json` pins.
   * Absent from a version published before boards had previews.
   */
  readonly themes?: readonly ArtifactThemeMode[]
}

export type CanvasOutlineItem =
  | {
      readonly id: string
      readonly type: "board"
      readonly title?: string
      /** The HTML file it shows, and its size: what its frame serves, and the shape it embeds at. */
      readonly file: string
      readonly w: number
      readonly h: number
      /**
       * What its preview is a picture of, as a hash: a version that keeps the board as it was
       * keeps its key, and so its preview.
       */
      readonly renderKey?: string
    }
  | { readonly id: string; readonly type: "section"; readonly title?: string }

export interface FileOutline {
  readonly kind: "file"
  readonly mediaType: string
}

/**
 * Turns a document's heading texts, in order, into their section slugs: lowercase, punctuation
 * dropped, spaces as hyphens, and `-1`, `-2` after a repeat. Publishing and the renderer both name
 * sections with it, so an address to a section finds the heading the reader sees.
 */
export function createHeadingSlugger(): (text: string) => string {
  const used = new Set<string>()
  return (text) => {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-") || "section"
    let slug = base
    for (let repeat = 1; used.has(slug); repeat += 1) slug = `${base}-${repeat}`
    used.add(slug)
    return slug
  }
}
