import { createAgentRunToken } from "@sixb/core/internal/agents"

export function normalizeApiBaseUrl(value: string): string {
  const withoutTrailingSlash = value.trim().replace(/\/+$/, "")
  if (withoutTrailingSlash.endsWith("/api")) {
    return withoutTrailingSlash.slice(0, -"/api".length)
  }
  return withoutTrailingSlash
}

/** The token the run's commands call the API with, valid while this execution owns the run. */
export function runTokenFor(input: {
  readonly projectId: string
  readonly runId: string
  readonly executionToken?: string
}): string {
  if (!input.executionToken) {
    throw new Error(
      `[SixbAgentWorker] Agent execution '${input.runId}' must hold an execution token before it gets a run token.`
    )
  }
  return createAgentRunToken({
    projectId: input.projectId,
    runId: input.runId,
    executionToken: input.executionToken,
  })
}
