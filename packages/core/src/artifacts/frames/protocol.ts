import { ARTIFACT_LIMITS, ARTIFACT_STATE_LIMITS } from "../limits"
import type { BoardElementKind, BoardFramePatch } from "../live/board"
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
  /** A designed document shown as the pages its paper cuts it into, not as one sheet. */
  readonly pages?: boolean
  /** A designed document opened at a section, by its heading's slug. */
  readonly section?: string
}

/** The fragment that carries a frame's start: `#sixb-slide=3&sixb-fill`, `#sixb-pages`. */
export function frameStartHash(start: FrameStart): string {
  const params: string[] = []
  if (start.slide !== undefined && start.slide > 1)
    params.push(`sixb-slide=${Math.round(start.slide)}`)
  if (start.fill) params.push("sixb-fill")
  if (start.pages) params.push("sixb-pages")
  if (start.section) params.push(`sixb-section=${encodeURIComponent(start.section)}`)
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
  /**
   * Starts or stops editing a canvas's board, served for editing (`?sixb-edit`): the frame then
   * reports what the reader points at and picks, by address, and lets them type into text. With
   * `typing: false`, a text the reader picks takes no typing, as when they pick what to comment on.
   * The first request after the frame loads transfers a `MessagePort`: the frame reports editing
   * (`edit.hover`, `edit.select`, `edit.text`) through it alone, never through the window.
   */
  | FrameRequestOf<"edit", { readonly on: boolean; readonly typing?: boolean }>
  /**
   * What someone else changed in the board, element by element, as `boardFramePatches` says. The
   * element the reader is typing in takes its patch once they leave it.
   */
  | FrameRequestOf<"edit.patch", { readonly patches: readonly BoardFramePatch[] }>
  /**
   * A canvas's board running on the canvas, where the reader uses its page in place. The first
   * request after the frame loads transfers a `MessagePort`: the frame then sends through it alone
   * the reader's gestures the canvas takes (`zoom`, `pan`, `space`) and the words of what they
   * press. `moving` says the canvas is panning by the wheel: a page coming under a still pointer
   * then keeps panning the canvas rather than scrolling itself.
   */
  | FrameRequestOf<"canvas", { readonly moving: boolean }>
  /**
   * Runs a designed document's editor in its frame, served for editing: `code` is the editor's
   * script, which takes the `MessagePort` the request transfers and edits the body in place.
   */
  | FrameRequestOf<"editor", { readonly code: string }>

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
  /**
   * The reader pressed a button, or a link within the page, that reads `text`: a canvas's board
   * follows the arrow that leaves it with that label. At most a label's length. A board running on
   * the canvas also sends it through its port, for the reader's own presses alone.
   */
  | FrameEventOf<"press", { readonly text: string }>
  /** Editing, the reader points at an element, or at none. */
  | FrameEventOf<"edit.hover", { readonly target: FrameEditTarget | null }>
  /** Editing, the reader picked an element, or none, clicking `at` that point of the frame. */
  | FrameEventOf<
      "edit.select",
      { readonly target: FrameEditTarget | null; readonly at?: FramePoint }
    >
  /**
   * Editing, the reader typed in a text element: all its words now, as plain text, and `base`,
   * its words as the frame last posted them, or as they were when the reader started typing. The
   * app makes it with `mergeBoardText`, so what others changed in the element since stays.
   *
   * The runtime takes the port before the board's scripts run, and stops the request that hands
   * it over before they hear it, so they cannot post on it; it reports only the reader's own
   * clicks and keys. What it posts is what the element holds, which the board's scripts can still
   * rewrite. The app takes `edit.text` only for the element the reader picked, the last
   * `edit.select` it heard, and nothing once the board's elements changed under the frame.
   */
  | FrameEventOf<
      "edit.text",
      { readonly address: string; readonly base: string; readonly text: string }
    >
  /**
   * The reader zoomed over a canvas's board, opened or running on the canvas, which the app zooms
   * instead of the browser: a pinch or the wheel with ⌘ or Ctrl, `factor` times around `at`, in
   * the frame's pixels; or ⌘ or Ctrl with +, − or 0, a `step`. Only a frame handed a port with
   * `edit` or `canvas` reports it, through that port, and only for the reader's own gestures and
   * keys; any other leaves them to the browser.
   */
  | FrameEventOf<"zoom", FrameZoom>
  /**
   * The reader turned the wheel or dragged a finger over a board running on the canvas, which pans
   * the canvas instead of scrolling the page. Only a frame handed a port with `canvas` reports it,
   * through that port, for the reader's own gestures.
   */
  | FrameEventOf<"pan", FramePan>
  /**
   * The reader pressed or let go of Space over a board running on the canvas, outside a field:
   * while it is held, dragging pans the canvas. Through the port, as `pan` is.
   */
  | FrameEventOf<"space", { readonly down: boolean }>

/**
 * How far the reader scrolled, as a wheel's deltas say it: `x` right and `y` down, in pixels. A
 * finger dragging scrolls the opposite way it moves, as it would scroll a page; the wheel's turns
 * pan the canvas at its own speed for them, as React Flow's do.
 */
export interface FramePan {
  readonly x: number
  readonly y: number
  readonly by: "wheel" | "touch"
}

/** How the reader zoomed: by a gesture, or by a key. */
export type FrameZoom =
  | { readonly factor: number; readonly at: FramePoint }
  | { readonly step: FrameZoomStep }

/** ⌘ or Ctrl with +, − or 0: in, out, or the page at its own size. */
export type FrameZoomStep = "in" | "out" | "actual"

/**
 * An element of a board being edited. One a script built, or whose words a script rewrote, is
 * `scripted`: it has no address of its own, and `within` names the element it sits in.
 */
export type FrameEditTarget =
  | {
      readonly address: string
      readonly kind: BoardElementKind
      readonly label: string
      readonly rect: FrameRect
    }
  | {
      readonly address: null
      readonly kind: "scripted"
      readonly within: string | null
      /** The words the reader pointed at, as the page shows them now. */
      readonly label?: string
      readonly rect: FrameRect
    }

export interface FramePoint {
  readonly x: number
  readonly y: number
}

export interface FrameRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

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
    case "edit.hover":
    case "edit.select": {
      const at = data.event === "edit.select" ? parsePoint(params.at) : undefined
      if (at === null) return null
      const point = at ? { at } : {}
      if (params.target === null) return event(data.event, { target: null, ...point })
      const target = parseEditTarget(params.target)
      return target ? event(data.event, { target, ...point }) : null
    }
    case "edit.text":
      return isEditAddress(params.address) &&
        typeof params.text === "string" &&
        params.text.length <= MAX_EDIT_TEXT_LENGTH &&
        typeof params.base === "string" &&
        params.base.length <= MAX_EDIT_TEXT_LENGTH
        ? event("edit.text", { address: params.address, base: params.base, text: params.text })
        : null
    case "zoom": {
      if (params.step !== undefined) {
        return ZOOM_STEPS.includes(String(params.step))
          ? event("zoom", { step: params.step as FrameZoomStep })
          : null
      }

      const at = parsePoint(params.at)
      const factor = Number(params.factor)
      if (!at || !Number.isFinite(params.factor) || factor <= 0) return null

      return event("zoom", {
        factor: Math.min(MAX_ZOOM_FACTOR, Math.max(1 / MAX_ZOOM_FACTOR, factor)),
        at,
      })
    }
    case "pan": {
      const { x, y, by } = params
      if (!Number.isFinite(x) || !Number.isFinite(y) || (by !== "wheel" && by !== "touch")) {
        return null
      }

      const bounded = (delta: number) => Math.min(MAX_PAN, Math.max(-MAX_PAN, delta))
      return event("pan", { x: bounded(Number(x)), y: bounded(Number(y)), by })
    }
    case "space":
      return typeof params.down === "boolean" ? event("space", { down: params.down }) : null
    case "press":
      return typeof params.text === "string" &&
        params.text.length > 0 &&
        params.text.length <= ARTIFACT_LIMITS.maxCanvasLabelLength
        ? event("press", { text: params.text })
        : null
    default:
      return null
  }
}

/** The most words a text element of a board takes from one edit: a board's own size. */
const MAX_EDIT_TEXT_LENGTH = ARTIFACT_LIMITS.maxBoardBytes

const EDIT_KINDS: readonly string[] = ["text", "image", "whole", "box"]

const ZOOM_STEPS: readonly string[] = ["in", "out", "actual"] satisfies FrameZoomStep[]

/** The most one gesture zooms by, either way: a wheel's notch is far less. */
const MAX_ZOOM_FACTOR = 4

/** The most one wheel's turn or one finger's move pans by, either way: a screen's width. */
const MAX_PAN = 4000

/** The longest label a frame reports for an element: the runtime cuts its own at 80. */
const MAX_EDIT_LABEL_LENGTH = 200

/** An address as `boardElements` writes one: steps of a tag and an index, from the body. */
function isEditAddress(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 2048 && /^body(>[a-z][a-z0-9-]*:\d+)*$/.test(value)
  )
}

/** A point the frame reports: undefined for none, null for one that does not read. */
function parsePoint(value: unknown): FramePoint | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null
  return { x: Number(value.x), y: Number(value.y) }
}

function parseEditTarget(value: unknown): FrameEditTarget | null {
  if (!isRecord(value) || !isRecord(value.rect)) return null
  const { x, y, width, height } = value.rect
  if (![x, y, width, height].every(Number.isFinite)) return null
  const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }

  if (value.kind === "scripted") {
    if (value.address !== null) return null
    if (value.within !== null && !isEditAddress(value.within)) return null
    const label =
      typeof value.label === "string" && value.label.length <= MAX_EDIT_LABEL_LENGTH
        ? { label: value.label }
        : {}
    return {
      address: null,
      kind: "scripted",
      within: value.within as string | null,
      ...label,
      rect,
    }
  }
  if (!isEditAddress(value.address) || !EDIT_KINDS.includes(String(value.kind))) return null
  if (typeof value.label !== "string" || value.label.length > MAX_EDIT_LABEL_LENGTH) return null
  return {
    address: value.address,
    kind: value.kind as BoardElementKind,
    label: value.label,
    rect,
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
