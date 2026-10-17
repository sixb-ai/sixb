import type { DeckMode } from "@sixb/core/artifacts"

/** What a key does to a deck, wherever focus is: in the frame or on the viewer around it. */
export type DeckAction =
  | { readonly type: "goto"; readonly slide: number }
  | { readonly type: "mode"; readonly mode: DeckMode }

export function deckKeyAction(
  key: string,
  state: { readonly slide: number; readonly total: number; readonly mode: DeckMode }
): DeckAction | null {
  const clamp = (slide: number) => Math.min(Math.max(1, slide), Math.max(1, state.total))
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
      return { type: "goto", slide: clamp(state.slide + 1) }
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return { type: "goto", slide: clamp(state.slide - 1) }
    case "Home":
      return { type: "goto", slide: 1 }
    case "End":
      return { type: "goto", slide: clamp(state.total) }
    case "Escape":
      return state.mode === "slide" ? null : { type: "mode", mode: "slide" }
    default:
      return null
  }
}

/** The slide an address names, as `#4`; the first slide when it names none. */
export function slideFromPart(part: string | undefined, total: number): number {
  const slide = part && /^[1-9]\d*$/.test(part) ? Number(part) : 1
  return Math.min(slide, Math.max(1, total))
}
