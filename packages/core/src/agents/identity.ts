/** Deterministic managed service-account id owned by one framework Agent actor. */
export function agentServiceAccountId(actorId: string): string {
  return `svc_agent_${actorId}`
}
