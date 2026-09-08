import type { ModelReasoningLevel } from "@sixb/core/models"

export function reasoningLabel(level: ModelReasoningLevel): string {
  if (level === "provider-default") return "Default"
  if (level === "xhigh") return "Extra high"
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
