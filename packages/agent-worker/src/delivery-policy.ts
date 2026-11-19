import { AgentRequesterLeftThreadError } from "@sixb/agent"
import { AgentDefinitionError } from "@sixb/core"
import { isSixbError } from "@sixb/core/internal/errors"
import { ModelProviderError, UnsupportedModelFeatureError } from "@sixb/core/models"

/** Bound infrastructure retries before any model or tool has been called. */
export const MAX_AGENT_DELIVERY_ATTEMPTS = 10

/**
 * A video check's failures in a row before its job dead-letters: with its backoff, five seconds
 * doubling up to five minutes, about 70 minutes, past a generation's one-hour ceiling. Each look
 * that finds the generation still pending schedules the job afresh, at attempt 0 again.
 */
export const MAX_VIDEO_CHECK_ATTEMPTS = 20

export function isPermanentAgentPreparationError(error: unknown): boolean {
  if (isSixbError(error) || error instanceof ModelProviderError) return !error.retryable
  return (
    error instanceof AgentDefinitionError ||
    error instanceof UnsupportedModelFeatureError ||
    error instanceof AgentRequesterLeftThreadError
  )
}

export function shouldRetryAgentPreparation(error: unknown, attempt: number): boolean {
  return attempt < MAX_AGENT_DELIVERY_ATTEMPTS && !isPermanentAgentPreparationError(error)
}
