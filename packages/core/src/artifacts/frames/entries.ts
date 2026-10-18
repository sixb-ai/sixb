import type { ArtifactKind } from "../kinds"

/**
 * How the frame's runtime lays out what it serves: a deck shows 1280×720 slides scaled to fit, one
 * at a time or all at once; a page scrolls like any web page.
 */
export type FrameLayout = "deck" | "page"

/** The kinds that open in a sandboxed frame, each in its layout. */
const FRAME_LAYOUTS: Partial<Readonly<Record<ArtifactKind, FrameLayout>>> = {
  slides: "deck",
  page: "page",
}

/** A kind's frame layout, or null for a kind Sixb draws natively. */
export function frameLayout(kind: ArtifactKind): FrameLayout | null {
  return FRAME_LAYOUTS[kind] ?? null
}

/**
 * The files of a version its frame serves as pages, with the kit and the runtime first in their
 * `<head>`: a deck's or a page's entry; none for a kind that does not open in a frame.
 */
export function frameEntries(version: {
  readonly entry: string
  readonly outline: { readonly kind: ArtifactKind }
}): readonly string[] {
  return frameLayout(version.outline.kind) ? [version.entry] : []
}
