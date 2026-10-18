import type { ArtifactTheme } from "@sixb/core/artifacts"
import type { CSSProperties } from "react"
import { type ArtifactVersion, useArtifactTheme } from "./queries"

export interface ArtifactThemeAttributes {
  /** `dark` or `light` when the artifact pins a mode, so the app's tokens for it apply. */
  readonly className?: string
  /** The artifact's own token values, which win over the app's inside the artifact. */
  readonly style?: CSSProperties
}

/**
 * How an artifact's `theme.json` reaches its renderer: a pinned mode as the class the app's tokens
 * key on, and token overrides as custom properties on the artifact's root element. Values were
 * checked at publish and again by the parser, so they cannot leave their property.
 */
export function artifactThemeAttributes(theme: ArtifactTheme | null): ArtifactThemeAttributes {
  if (!theme) return {}
  const tokens = theme.tokens ?? {}
  return {
    ...(theme.mode ? { className: theme.mode } : {}),
    ...(Object.keys(tokens).length === 0 ? {} : { style: { ...tokens } as CSSProperties }),
  }
}

/** The version's theme, for its renderer's root, once its `theme.json` is read. */
export function useArtifactThemeAttributes(version: ArtifactVersion): ArtifactThemeAttributes {
  return artifactThemeAttributes(useArtifactTheme(version))
}
