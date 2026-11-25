/**
 * What the dev process tells the supervisor over IPC. The supervisor outlives every restart, so
 * when it draws the terminal's live footer the dev process reports instead of printing.
 */

/** Set on the dev process when the supervisor draws the screen; the process then only reports. */
export const DEV_UI_ENV = "SIXB_DEV_UI"

/** The steps a dev process goes through before it serves, in order. */
export const DEV_STARTUP_STEPS = [
  "Generating types",
  "Loading project",
  "Starting server",
  "Starting app",
] as const

export type DevStartupStep = (typeof DEV_STARTUP_STEPS)[number]

/** What a dev process serves once it is ready. */
export interface DevReadyView {
  readonly name: string
  readonly apiUrl: string
  readonly apiDocsUrl: string
  readonly wsUrl: string
  /** `null` when the app could not start; a warning says why. */
  readonly appUrl: string | null
  readonly workers: readonly { readonly type: string; readonly concurrency: number }[]
  readonly warnings: readonly string[]
}

/** How far a branch's copy has loaded: bytes of its spooled copy read so far. */
export interface DevLoadProgress {
  readonly bytesRead: number
  readonly bytes: number
  readonly elapsedMs: number
}

export interface DevStartupFailure {
  readonly message: string
  readonly remediation?: string
  /** The project file the error points at, relative to the project. */
  readonly file?: string
}

export type DevChildMessage =
  | { readonly type: "status"; readonly step: DevStartupStep }
  /**
   * A branch's copy of production loading: when it starts, every few seconds while it loads, and
   * once it is loaded (`done`). It takes as long as the copy is big, so the startup deadline waits
   * for it while it makes progress.
   */
  | { readonly type: "loading"; readonly done: boolean; readonly progress: DevLoadProgress }
  | {
      readonly type: "ready"
      readonly watchesApp: boolean
      readonly app: { readonly url: string; readonly apiOrigin: string } | null
      readonly view?: DevReadyView
    }
  | { readonly type: "startup-error"; readonly error?: DevStartupFailure }

/** What `sixb dev` says when a branch's copy starts loading, as it loads, and once it has. */
export function loadingLine(message: {
  readonly done: boolean
  readonly progress: DevLoadProgress
}): string {
  const { bytesRead, bytes, elapsedMs } = message.progress
  if (message.done)
    return `Loaded this branch's copy of production's data in ${seconds(elapsedMs)}.`
  if (bytesRead === 0) {
    return `Loading this branch's copy of production's data (${size(bytes)}). A large copy takes minutes: startup waits while it makes progress.`
  }

  const percent = bytes > 0 ? Math.min(100, Math.floor((bytesRead / bytes) * 100)) : 100
  return `Loading this branch's copy: ${size(bytesRead)} of ${size(bytes)} (${percent}%), ${seconds(elapsedMs)}.`
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`
}
