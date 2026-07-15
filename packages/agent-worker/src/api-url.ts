import {
  AGENT_API_GATEWAY_PREFIX,
  createAgentApiGatewayCapability,
} from "@sixb/core/internal/agents"
import type { AgentRunRecord } from "@sixb/core/storage"

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
  readonly run: AgentRunRecord
}): string {
  const execution = input.run.execution
  if (!execution) {
    throw new Error(
      `[SixbAgentWorker] Agent run '${input.run.id}' must hold an execution token before creating API gateway access.`
    )
  }

  const capability = createAgentApiGatewayCapability({
    projectId: input.projectId,
    runId: input.run.id,
    executionToken: execution.token,
  })
  // apiBaseUrl is already normalized at the worker's server-base boundary (buildAgentContext), so
  // it is appended verbatim rather than normalized again here.
  return `${input.apiBaseUrl}${AGENT_API_GATEWAY_PREFIX}/${encodeURIComponent(
    input.run.id
  )}/${encodeURIComponent(capability)}`
}
