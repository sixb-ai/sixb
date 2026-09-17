import type { AuthSessionAudience } from "@sixb/core"

export interface CustomAppRuntimeConfig {
  readonly publicEnv?: Readonly<Record<string, string | undefined>>
  readonly api?: {
    readonly baseUrl: string
  }
  readonly auth: {
    readonly audience: AuthSessionAudience
    readonly enabled: boolean
  }
}

export function collectPublicEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("SIXB_PUBLIC_") && entry[1] !== undefined
    )
  )
}

export function renderCustomAppRuntimeScript(config: CustomAppRuntimeConfig): string {
  const safeConfig = JSON.stringify(config).replaceAll("<", "\\u003c")
  return `<script>window.__SIXB_RUNTIME__ = ${safeConfig};</script>`
}
