export const appBrowserControlPath = "/__sixb/browser-control"
export const appBrowserControlSecretHeader = "x-sixb-browser-secret"

export type AppBrowserCommand =
  | {
      readonly id: string
      readonly kind: "inspect"
    }
  | {
      readonly id: string
      readonly kind: "navigate"
      readonly path: string
    }

export interface AppBrowserCommandResult {
  readonly commandId: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}
