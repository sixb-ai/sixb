// The one place the app speaks to HyperFrames' runtime, which plays a video in its frame. The
// frame is sandboxed without `allow-same-origin`, so the app reaches the runtime in messages alone,
// as HyperFrames' own player does when it cannot reach into its frame: `hf-parent` controls go in,
// `hf-preview` reports come out. Only what the player needs is mirrored here, from
// `@hyperframes/player` 0.9.68 and the runtime it drives (`__sixb/hyperframes.js`, the same
// release).
//
// Every report carries the protocol's version and the runtime's abilities. A runtime of another
// version, or one that cannot seek by seconds, is refused: the frame says so rather than playing
// out of step with its controls.

/** The version of HyperFrames' parent protocol this adapter speaks. */
export const HYPERFRAMES_PROTOCOL_VERSION = 1

/** What the player needs of the runtime: seeking by seconds. */
const REQUIRED_CAPABILITIES = ["seconds-time"] as const

/** How the reader is moving the playhead: a drag shows each frame it passes; a seek lands. */
export type SeekMode = "drag" | "commit"

/** What the app asks of the runtime. */
export type HyperframesControl =
  | { readonly action: "play" }
  | { readonly action: "pause" }
  | { readonly action: "seek"; readonly seconds: number; readonly mode?: SeekMode }
  | { readonly action: "set-muted"; readonly muted: boolean }
  | { readonly action: "set-volume"; readonly volume: number }
  | { readonly action: "set-playback-rate"; readonly rate: number }
  /** Reports its state less often while nothing moves. */
  | { readonly action: "set-idle-heartbeat"; readonly slow: boolean }

/** What the runtime reports that the player reads. */
export type HyperframesReport =
  /** It listens for controls. */
  | { readonly type: "ready" }
  /** Its timeline is built: how long it plays. */
  | { readonly type: "timeline"; readonly duration: number | null }
  /** The fonts, images and recordings it waited for have loaded, or it stopped waiting. */
  | { readonly type: "assets-ready" }
  | {
      readonly type: "state"
      readonly time: number
      readonly playing: boolean
      readonly buffering: boolean
      readonly ended: boolean
    }
  /** The browser kept a recording from playing with sound: no gesture of the reader's let it. */
  | { readonly type: "sound-blocked" }
  /** A recording the video plays could not load. */
  | { readonly type: "media-failed" }
  /** A runtime this adapter cannot drive. */
  | { readonly type: "unsupported" }

/** The message a control is posted as, with the protocol's version and the video's frame rate. */
export function controlMessage(control: HyperframesControl, fps: number): Record<string, unknown> {
  const envelope = {
    source: "hf-parent",
    type: "control",
    protocolVersion: HYPERFRAMES_PROTOCOL_VERSION,
    capabilities: [...REQUIRED_CAPABILITIES],
    fps: { numerator: fps, denominator: 1 },
  }

  switch (control.action) {
    case "seek":
      return {
        ...envelope,
        action: "seek",
        timeSeconds: control.seconds,
        frame: Math.round(control.seconds * fps),
        seekMode: control.mode ?? "commit",
      }
    case "set-muted":
      return { ...envelope, action: "set-muted", muted: control.muted }
    case "set-volume":
      return { ...envelope, action: "set-volume", volume: control.volume }
    case "set-playback-rate":
      return { ...envelope, action: "set-playback-rate", playbackRate: control.rate }
    case "set-idle-heartbeat":
      return { ...envelope, action: "set-idle-heartbeat", slow: control.slow }
    default:
      return { ...envelope, action: control.action }
  }
}

/**
 * A message from the frame read as a report, or null for anything else: another protocol's, one
 * the player does not read, or one whose fields are not what the protocol says.
 */
export function readReport(data: unknown): HyperframesReport | null {
  if (!isRecord(data) || data.source !== "hf-preview" || typeof data.type !== "string") return null

  if (!supported(data)) return { type: "unsupported" }

  switch (data.type) {
    case "ready":
      return { type: "ready" }
    case "assets-ready":
      return { type: "assets-ready" }
    case "media-autoplay-blocked":
      return { type: "sound-blocked" }
    case "timeline": {
      const duration = Number(data.durationSeconds)
      return {
        type: "timeline",
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      }
    }
    case "state": {
      const time = Number(data.currentTime)
      if (!Number.isFinite(time)) return null
      return {
        type: "state",
        time: Math.max(0, time),
        playing: data.isPlaying === true,
        buffering: data.buffering === true,
        ended: data.ended === true,
      }
    }
    case "diagnostic":
      return mediaFailed(data) ? { type: "media-failed" } : null
    default:
      return null
  }
}

/** The elements whose failing asset is a recording: a video, a sound, or a source of one. */
const RECORDINGS = new Set(["video", "audio", "source"])

/**
 * Whether a diagnostic says a recording could not load. The runtime says it in two ways: its media
 * layer's `runtime_media_load_failed`, and, for a file the browser cannot read at all, the asset
 * watch's `runtime_asset_load_failed` naming the element, which it also sends for an image.
 */
function mediaFailed(data: Record<string, unknown>): boolean {
  if (data.code === "runtime_media_load_failed") return true
  if (data.code !== "runtime_asset_load_failed" || !isRecord(data.details)) return false

  const { tagName } = data.details
  return typeof tagName === "string" && RECORDINGS.has(tagName.toLowerCase())
}

/**
 * Whether a report comes from a runtime this adapter drives: protocol version 1, a frame rate,
 * and the abilities it needs. HyperFrames' player refuses the same.
 */
function supported(data: Record<string, unknown>): boolean {
  if (data.protocolVersion !== HYPERFRAMES_PROTOCOL_VERSION) return false

  const { capabilities, fps } = data
  if (!Array.isArray(capabilities) || !isRecord(fps)) return false
  const rate = Number(fps.numerator) / Number(fps.denominator)
  if (!Number.isFinite(rate) || rate <= 0) return false

  return REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability))
}

/** Where the player stands, as the runtime's reports move it. */
export interface PlaybackState {
  /**
   * `loading` until the runtime listens and has built its timeline, `ready` from then on, and
   * `failed` for a runtime it cannot drive, which stays failed.
   */
  readonly phase: "loading" | "ready" | "failed"
  /** The playhead, in seconds. */
  readonly time: number
  /** How long the video plays, as the runtime built it; until then, as publishing read it. */
  readonly duration: number
  readonly playing: boolean
  /** Waiting for a recording, a font or an image to play on. */
  readonly buffering: boolean
  readonly ended: boolean
  /** Whether what it waited for before the first frame has loaded. */
  readonly loaded: boolean
  /** The browser kept its sound from playing. */
  readonly soundBlocked: boolean
  /** A recording it plays could not load. */
  readonly mediaFailed: boolean
}

export function initialPlayback(duration: number): PlaybackState {
  return {
    phase: "loading",
    time: 0,
    duration,
    playing: false,
    buffering: false,
    ended: false,
    loaded: false,
    soundBlocked: false,
    mediaFailed: false,
  }
}

/** The player's state once the runtime reports this. */
export function playbackAfter(state: PlaybackState, report: HyperframesReport): PlaybackState {
  if (state.phase === "failed") return state

  switch (report.type) {
    case "unsupported":
      return { ...state, phase: "failed", playing: false }
    case "ready":
      return state
    case "timeline":
      return {
        ...state,
        phase: "ready",
        ...(report.duration === null ? {} : { duration: report.duration }),
      }
    case "assets-ready":
      return { ...state, loaded: true }
    case "sound-blocked":
      return { ...state, soundBlocked: true }
    case "media-failed":
      return { ...state, mediaFailed: true }
    case "state": {
      const { time, playing, buffering, ended } = report
      if (
        state.time === time &&
        state.playing === playing &&
        state.buffering === buffering &&
        state.ended === ended
      ) {
        return state
      }
      return { ...state, time: Math.min(time, state.duration), playing, buffering, ended }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
