/**
 * What a version contains, read from its files when it is published. Addresses resolve against
 * it, and previews and hover cards show it without opening the files.
 */
export type ArtifactOutline =
  | DocumentOutline
  | SheetOutline
  | SlidesOutline
  | PageOutline
  | FileOutline

export interface DocumentOutline {
  readonly kind: "document"
  readonly headings: readonly DocumentHeading[]
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
  readonly rows: number
  readonly columns: readonly string[]
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
