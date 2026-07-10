import type { ResolvedAppMetadata, ResolvedManifestIcon } from "./metadata"

interface CustomAppManifest {
  readonly id: "/"
  readonly name: string
  readonly description?: string
  readonly start_url: "/"
  readonly scope: "/"
  readonly display: "standalone"
  readonly theme_color: string
  readonly background_color: string
  readonly icons?: readonly ResolvedManifestIcon[]
}

export function renderAppManifest(metadata: ResolvedAppMetadata): string {
  const manifest: CustomAppManifest = {
    id: "/",
    name: metadata.title,
    ...(metadata.description ? { description: metadata.description } : {}),
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: metadata.themeColor,
    background_color: metadata.backgroundColor,
    ...(metadata.icons.length > 0 ? { icons: metadata.icons } : {}),
  }

  return `${JSON.stringify(manifest, null, 2)}\n`
}
