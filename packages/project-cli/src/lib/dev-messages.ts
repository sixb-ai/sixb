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

export interface DevStartupFailure {
  readonly message: string
  readonly remediation?: string
}

export type DevChildMessage =
  | { readonly type: "status"; readonly step: DevStartupStep }
  | {
      readonly type: "ready"
      readonly watchesApp: boolean
      readonly app: { readonly url: string; readonly apiOrigin: string } | null
      readonly view?: DevReadyView
    }
  | { readonly type: "startup-error"; readonly error?: DevStartupFailure }
