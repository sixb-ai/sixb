import { ARTIFACT_LIMITS, ARTIFACT_STATE_LIMITS } from "../limits"
import { isArtifactQueryName } from "../queries"
import { ARTIFACT_THEME_TOKENS } from "../theme"

/**
 * Messages between the app and an artifact in its sandboxed frame: a deck, or a page. The app
 * asks; the frame answers each request by its id, and tells the app what happened inside it as
 * events. Later abilities are new methods and events, not a new protocol.
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
  /** Scrolls a page by a wheel turned over what the app draws on it. */
  | FrameRequestOf<"scroll", { readonly x: number; readonly y: number }>
  /** Loads the entry again, as a page whose data was reset starts over. */
  | FrameRequestOf<"reload", Record<string, never>>
  /**
   * A query the page read has new rows: the objects it reads changed. The page reads them with
   * `sixb.query(name)` again; the app sends it only for the queries that frame has read.
   */
  | FrameRequestOf<"query.changed", { readonly name: string }>

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
  /** The frame has laid out its entry: a deck says how many slides it has. */
  | FrameEventOf<"ready", { readonly slides?: number }>
  /** The reader picked a slide in the overview. */
  | FrameEventOf<"select", { readonly slide: number }>
  /** A key the app handles, pressed while the frame had focus. */
  | FrameEventOf<"key", { readonly key: string }>
  /** A link to another artifact, which opens where the reader is. */
  | FrameEventOf<"open", { readonly address: string }>
  /**
   * A link to a web page, which the app opens in a new tab: the frame cannot open windows itself.
   * Only `http:` and `https:` addresses.
   */
  | FrameEventOf<"link", { readonly url: string }>
  /**
   * Where the `<sixb-embed>` boxes in view are, for the app to draw each over the frame: in the
   * frame's pixels, with the scale they are drawn at. A deck reports the shown slide's, and none in
   * the overview, where an embed stays a placeholder, as it does in a filled frame, which never
   * reports; a page reports those near its view as it scrolls, at its own scale.
   */
  | FrameEventOf<"embeds", { readonly embeds: readonly FrameEmbed[] }>
  /** A page's height as laid out at the frame's width, so a document can size the frame to it. */
  | FrameEventOf<"size", { readonly height: number }>

/** One `<sixb-embed>` the frame shows. */
export interface FrameEmbed {
  /** The element's own id while the page is loaded: the same as it scrolls out and back. */
  readonly id: number
  readonly address: string
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /**
   * The scale it is drawn at: a slide's, where the embed is laid out at `rect / scale` and scaled
   * with the slide; 1 on a page.
   */
  readonly scale: number
}

interface FrameEventOf<Event extends string, Params> {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly event: Event
  readonly params: Params
}

/**
 * What the frame asks of the app, numbered so the app's `result` answers it: a page keeping data
 * with `sixb.state`, or reading one of its version's queries with `sixb.query`. The app answers
 * only its own frame, for the artifact and the version it shows.
 */
export type FrameCall =
  | FrameCallOf<"state.get", { readonly key: string }>
  | FrameCallOf<"state.set", { readonly key: string; readonly value: unknown }>
  | FrameCallOf<"state.delete", { readonly key: string }>
  | FrameCallOf<"state.keys", Record<string, never>>
  /** Runs `queries/<name>.json` as the reader; the value is the query route's JSON. */
  | FrameCallOf<"query.run", { readonly name: string }>

interface FrameCallOf<Method extends string, Params> {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly call: number
  readonly method: Method
  readonly params: Params
}

/** The app's answer to one call: its value, or why it failed. */
export interface FrameCallResult {
  readonly protocol: typeof FRAME_PROTOCOL
  readonly result: number
  readonly value?: unknown
  readonly error?: string
}

/**
 * A message from a frame as a call, or null when it is not one. A page's scripts write what it
 * posts, so the shapes are checked here, and a value is checked for size as JSON, as storage will
 * count it, before the app sends it anywhere.
 */
export function parseFrameCall(data: unknown): FrameCall | null {
  if (!isRecord(data) || data.protocol !== FRAME_PROTOCOL || !isRecord(data.params)) return null
  if (!Number.isSafeInteger(data.call) || Number(data.call) < 0) return null
  const call = Number(data.call)
  const { params } = data
  const key = params.key
  const keyed = isStateKey(key)
  switch (data.method) {
    case "state.get":
    case "state.delete":
      return keyed
        ? ({ protocol: FRAME_PROTOCOL, call, method: data.method, params: { key } } as FrameCall)
        : null
    case "state.set": {
      if (!keyed || !("value" in params)) return null
      const json = jsonText(params.value)
      if (json === undefined || utf8Bytes(json) > ARTIFACT_STATE_LIMITS.maxValueBytes) return null
      return {
        protocol: FRAME_PROTOCOL,
        call,
        method: "state.set",
        params: { key, value: params.value },
      }
    }
    case "state.keys":
      return { protocol: FRAME_PROTOCOL, call, method: "state.keys", params: {} }
    case "query.run": {
      // The client puts the name in the URL's path, as it does a key.
      const { name } = params
      if (typeof name !== "string" || !isArtifactQueryName(name)) return null

      return { protocol: FRAME_PROTOCOL, call, method: "query.run", params: { name } }
    }
    default:
      return null
  }
}

/**
 * A key the app can send: the client puts it in the URL's path, where `.` and `..` would name
 * another route, `..` the artifact itself.
 */
function isStateKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ARTIFACT_STATE_LIMITS.maxKeyLength &&
    !/\p{Cc}/u.test(value) &&
    value !== "." &&
    value !== ".."
  )
}

function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
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
      if (params.slides === undefined) return event("ready", {})
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
    case "link":
      return isWebAddress(params.url) ? event("link", { url: params.url }) : null
    case "embeds": {
      const { embeds } = params
      if (!Array.isArray(embeds) || embeds.length > ARTIFACT_LIMITS.maxReferences) return null
      const parsed: FrameEmbed[] = []
      const ids = new Set<number>()
      for (const embed of embeds) {
        if (!isRecord(embed) || !isAddress(embed.address) || !isRecord(embed.rect)) return null

        // Two embeds with one id would be one element drawn twice.
        if (!isCount(embed.id) || ids.has(embed.id)) return null
        ids.add(embed.id)

        const { x, y, width, height } = embed.rect
        if (![x, y, width, height, embed.scale].every(Number.isFinite)) return null
        if (Number(width) < 0 || Number(height) < 0 || Number(embed.scale) <= 0) return null
        parsed.push({
          id: embed.id,
          address: embed.address,
          rect: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
          scale: Number(embed.scale),
        })
      }
      return event("embeds", { embeds: parsed })
    }
    case "size":
      return Number.isFinite(params.height) && Number(params.height) >= 0
        ? event("size", { height: Math.min(Number(params.height), MAX_HEIGHT) })
        : null
    default:
      return null
  }
}

/** The most a page reports as its height: more is a page that grows with its frame. */
const MAX_HEIGHT = 100_000

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

/** The longest web address the app opens: longer than any link a page needs. */
const MAX_URL_LENGTH = 8192

/** An absolute `http:` or `https:` address, as the frame resolves a link's. */
function isWebAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return false

  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}
