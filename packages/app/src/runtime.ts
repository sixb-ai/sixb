export interface CustomAppRuntimeConfig {
  readonly api: {
    readonly baseUrl: string
  }
  readonly auth: {
    readonly audience: string
    readonly enabled: boolean
  }
}

export function renderCustomAppRuntimeScript(config: CustomAppRuntimeConfig): string {
  const safeConfig = JSON.stringify(config).replaceAll("<", "\\u003c")
  return `<script>window.__PARIO_RUNTIME__ = ${safeConfig};</script>`
}
