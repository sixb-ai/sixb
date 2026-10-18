/**
 * The colors an artifact gives what it marks, a sheet's tag or a canvas's note: the theme's
 * meanings, or one of its chart colors, so they follow the app's theme and dark mode.
 */
export const ARTIFACT_TONES = [
  "neutral",
  "positive",
  "warning",
  "negative",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const
export type ArtifactTone = (typeof ARTIFACT_TONES)[number]

export function isArtifactTone(value: unknown): value is ArtifactTone {
  return (ARTIFACT_TONES as readonly unknown[]).includes(value)
}
