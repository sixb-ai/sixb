export type CustomAppMount = CustomAppDevelopmentMount | CustomAppProductionMount

export interface CustomAppDevelopmentMount {
  readonly kind: "development"
  readonly origin: URL
  readonly hmrWebSocketPaths: readonly AppPathPattern[]
  readonly publicProxyPaths: readonly AppPathPattern[]
  readonly publicAssetPaths: ReadonlySet<string>
  stop(): Promise<void>
}

export interface CustomAppProductionMount {
  readonly kind: "production"
  indexHtml(): Promise<string>
  asset(pathname: string): Promise<AppAsset | null>
  html(pathname: string): Promise<string | null>
  stop?(): Promise<void>
}

export type AppPathPattern =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly path: string }

export interface AppAsset {
  readonly body: BodyInit | Bun.BunFile
  readonly contentType?: string
  readonly cacheControl?: string
}
