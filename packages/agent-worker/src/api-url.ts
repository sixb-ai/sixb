import {
  AGENT_API_GATEWAY_PREFIX,
  type AgentRunRecord,
  createAgentApiGatewayCapability,
} from "@sixb/core"

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
  const lease = input.run.lease
  if (!lease) {
    throw new Error(
      `[SixbAgentWorker] Agent run '${input.run.id}' must hold a lease before creating API gateway access.`
    )
  }

  const capability = createAgentApiGatewayCapability({
    projectId: input.projectId,
    runId: input.run.id,
    leaseId: lease.id,
  })
  return `${normalizeApiBaseUrl(input.apiBaseUrl)}${AGENT_API_GATEWAY_PREFIX}/${encodeURIComponent(
    input.run.id
  )}/${encodeURIComponent(capability)}`
}
