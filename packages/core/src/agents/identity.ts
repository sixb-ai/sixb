/** Deterministic managed service-account id owned by one Agent definition. */
export function agentServiceAccountId(agentId: string): string {
  return `svc_agent_${agentId}`
}
