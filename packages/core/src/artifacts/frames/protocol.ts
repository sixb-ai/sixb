import { ARTIFACT_LIMITS } from "../limits"
import { ARTIFACT_THEME_TOKENS } from "../theme"

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
  /**
   * Where the shown slide's `<sixb-embed>` boxes are, for the app to draw each over the frame: in
   * the frame's pixels, with the scale the slide is drawn at. Empty in the overview, where an
   * embed stays a placeholder, as it does in a filled frame, which never reports.
   */
  | FrameEventOf<"embeds", { readonly embeds: readonly FrameEmbed[] }>

/** One `<sixb-embed>` on the shown slide. */
export interface FrameEmbed {
  readonly address: string
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /** The slide's scale: the embed is drawn at `rect / scale`, then scaled with the slide. */
  readonly scale: number
}

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

/**
 * The theme tokens the app sends into a frame, read from the viewer as it is themed: the ones an
 * artifact's theme may set.
 */
export const FRAME_THEME_TOKENS = ARTIFACT_THEME_TOKENS

/**
 * A message from a frame as an event, or null when it is not one this protocol sends. A deck runs
 * its own scripts, so anything it posts is checked for the shape the app relies on: whole slide
 * numbers, a key the app handles, finite boxes, and no more embeds than a version may record.
 */
export function parseFrameEvent(data: unknown): FrameEvent | null {
  if (!isRecord(data) || data.protocol !== FRAME_PROTOCOL || !isRecord(data.params)) return null
  const { params } = data
  switch (data.event) {
    case "ready":
      return isCount(params.slides) ? event("ready", { slides: params.slides }) : null
    case "select":
      return isCount(params.slide) && params.slide > 0
        ? event("select", { slide: params.slide })
        : null
    case "key":
      return typeof params.key === "string" && (DECK_KEYS as readonly string[]).includes(params.key)
        ? event("key", { key: params.key })
        : null
    case "open":
      return isAddress(params.address) ? event("open", { address: params.address }) : null
    case "embeds": {
      const { embeds } = params
      if (!Array.isArray(embeds) || embeds.length > ARTIFACT_LIMITS.maxReferences) return null
      const parsed: FrameEmbed[] = []
      for (const embed of embeds) {
        if (!isRecord(embed) || !isAddress(embed.address) || !isRecord(embed.rect)) return null
        const { x, y, width, height } = embed.rect
        if (![x, y, width, height, embed.scale].every(Number.isFinite)) return null
        if (Number(width) < 0 || Number(height) < 0 || Number(embed.scale) <= 0) return null
        parsed.push({
          address: embed.address,
          rect: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
          scale: Number(embed.scale),
        })
      }
      return event("embeds", { embeds: parsed })
    }
    default:
      return null
  }
}

function event<Name extends FrameEvent["event"]>(
  name: Name,
  params: Extract<FrameEvent, { event: Name }>["params"]
): FrameEvent {
  return { protocol: FRAME_PROTOCOL, event: name, params } as FrameEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** Long enough for any address a version can record; the app resolves it before using it. */
function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048
}
