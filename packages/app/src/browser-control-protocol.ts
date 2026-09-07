export const appBrowserControlPath = "/__sixb/browser-control"
export const appBrowserControlSecretHeader = "x-sixb-browser-secret"

export type AppBrowserOperation = (
  | {
      readonly kind: "inspect"
    }
  | {
      readonly kind: "navigate"
      readonly path: string
    }
  | {
      readonly kind: "invoke"
      readonly registrationId: string
      readonly command: string
      readonly input: unknown
    }
) & { readonly excludedContext?: readonly string[] }

export type AppBrowserCommand = AppBrowserOperation & {
  readonly id: string
  readonly expiresAt: number
}

export interface AppBrowserCommandResult {
  readonly commandId: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}
