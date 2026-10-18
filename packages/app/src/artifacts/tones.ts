import type { ArtifactTone } from "@sixb/core/artifacts"

/** Each tone's color in the theme, for a sheet's tags and a canvas's notes and shapes. */
export const TONE_COLORS: Readonly<Record<ArtifactTone, string>> = {
  neutral: "var(--muted-foreground)",
  positive: "var(--success)",
  warning: "var(--warning)",
  negative: "var(--destructive)",
  "chart-1": "var(--chart-1)",
  "chart-2": "var(--chart-2)",
  "chart-3": "var(--chart-3)",
  "chart-4": "var(--chart-4)",
  "chart-5": "var(--chart-5)",
}
