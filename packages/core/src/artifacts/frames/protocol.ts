/**
 * Messages between the app and a deck in its sandboxed frame. The app asks; the frame answers
 * each request by its id, and tells the app what happened inside it as events. Later abilities
 * are new methods and events, not a new protocol.
 */
export const FRAME_PROTOCOL = "sixb-frame/1"

/**
 * A deck shows one slide scaled to fit on its stage, every slide in a grid, or one slide filling
 * the page to present it.
 */
export type DeckMode = "slide" | "overview" | "present"

/**
 * How a frame opens, set in its URL so the first paint is right: at a slide, and with `fill`, that
 * slide alone filling the frame with no stage around it, as a thumbnail or an embed shows it.
 */
export interface FrameStart {
  readonly slide?: number
  readonly fill?: boolean
}

/** The fragment that carries a frame's start: `#sixb-slide=3&sixb-fill`. */
export function frameStartHash(start: FrameStart): string {
  const params: string[] = []
  if (start.slide !== undefined && start.slide > 1)
    params.push(`sixb-slide=${Math.round(start.slide)}`)
  if (start.fill) params.push("sixb-fill")
  return params.length > 0 ? `#${params.join("&")}` : ""
}

/** What the app asks of the frame. */
export type FrameRequest =
  | FrameRequestOf<
      "theme",
      { readonly tokens: Readonly<Record<string, string>>; readonly dark: boolean }
    >
  | FrameRequestOf<"goto", { readonly slide: number }>
  | FrameRequestOf<"mode", { readonly mode: DeckMode }>

interface FrameRequestOf<Method extends string, Params> {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly id: number
  readonly method: Method
  readonly params: Params
}

/** The frame's answer to one request. */
export interface FrameResponse {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly id: number
  readonly error?: string
}

/** What happened inside the frame. */
export type FrameEvent =
  | FrameEventOf<"ready", { readonly slides: number }>
  /** The reader picked a slide in the overview. */
  | FrameEventOf<"select", { readonly slide: number }>
  /** A key the app handles, pressed while the frame had focus. */
  | FrameEventOf<"key", { readonly key: string }>
  /** A link to another artifact, which opens where the reader is. */
  | FrameEventOf<"open", { readonly address: string }>

interface FrameEventOf<Event extends string, Params> {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly event: Event
  readonly params: Params
}

/** Keys the frame passes to the app, so a deck navigates the same with focus in it or not. */
export const DECK_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Escape",
] as const

/** The theme tokens the app sends into a frame, read from the viewer as it is themed. */
export const FRAME_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--font-sans",
  "--font-serif",
  "--font-mono",
  "--radius",
] as const
