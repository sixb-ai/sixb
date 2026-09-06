const agentNavigationStateKey = "__sixbAgentNavigation"

/** History state attached to reversible route changes initiated through app-control tools. */
export function appAgentNavigationState(): Record<string, unknown> {
  return {
    [agentNavigationStateKey]: { source: "agent" },
  }
}

/** Detect agent navigation intent without trusting arbitrary history state. */
export function isAppAgentNavigation(state: unknown): boolean {
  if (!isRecord(state)) return false
  const navigation = state[agentNavigationStateKey]
  return isRecord(navigation) && navigation.source === "agent"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
