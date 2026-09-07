import type { ModelReasoningLevel } from "@sixb/core/models"
import type { LanguageModel } from "../types"

export function modelDisplayName(model: LanguageModel): string {
  // Reviewed display aliases only: other models retain their distinguishing qualifiers.
  switch (model.modelId) {
    case "deepseek/deepseek-v4-flash-vision-exp":
      return "DeepSeek V4 Flash Vision"
    case "anthropic/claude-haiku-4.5":
      return "Claude Haiku 4.5"
    default:
      return model.name
  }
}

export function reasoningLabel(level: ModelReasoningLevel): string {
  if (level === "provider-default") return "Default"
  if (level === "xhigh") return "Extra high"
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
