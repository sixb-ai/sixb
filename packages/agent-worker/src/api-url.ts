import {
  AGENT_API_GATEWAY_PREFIX,
  createAgentApiGatewayCapability,
} from "@sixb/core/internal/agents"

export function normalizeApiBaseUrl(value: string): string {
  const withoutTrailingSlash = value.trim().replace(/\/+$/, "")
  if (withoutTrailingSlash.endsWith("/api")) {
    return withoutTrailingSlash.slice(0, -"/api".length)
  }
  return withoutTrailingSlash
}

export function createAgentApiGatewayBaseUrl(input: {
  readonly apiBaseUrl: string
  readonly projectId: string
  readonly runId: string
  readonly executionToken?: string
}): string {
  if (!input.executionToken) {
    throw new Error(
      `[SixbAgentWorker] Agent execution '${input.runId}' must hold an execution token before creating API gateway access.`
    )
  }

  const capability = createAgentApiGatewayCapability({
    projectId: input.projectId,
    runId: input.runId,
    executionToken: input.executionToken,
  })
  // apiBaseUrl is already normalized at the worker's server-base boundary (buildAgentContext), so
  // it is appended verbatim rather than normalized again here.
  return `${input.apiBaseUrl}${AGENT_API_GATEWAY_PREFIX}/${encodeURIComponent(
    input.runId
  )}/${encodeURIComponent(capability)}`
}
