import { AgentDefinitionError } from "@sixb/core"
import { isSixbError } from "@sixb/core/internal/errors"
import { ModelProviderError, UnsupportedModelFeatureError } from "@sixb/core/models"

/** Bound infrastructure retries before any model or tool has been called. */
export const MAX_AGENT_DELIVERY_ATTEMPTS = 10

export function isPermanentAgentPreparationError(error: unknown): boolean {
  if (isSixbError(error) || error instanceof ModelProviderError) return !error.retryable
  return error instanceof AgentDefinitionError || error instanceof UnsupportedModelFeatureError
}

export function shouldRetryAgentPreparation(error: unknown, attempt: number): boolean {
  return attempt < MAX_AGENT_DELIVERY_ATTEMPTS && !isPermanentAgentPreparationError(error)
}
