const MAX_TIMER_DURATION_MS = 2_147_483_647

/**
 * Resolve the agent turn timeout from the CLI flag or environment. `undefined` leaves the worker's
 * built-in default in authority.
 */
export function resolveAgentTurnTimeoutMs(value: string | undefined): number | undefined {
  const configured = nonblank(value) ?? nonblank(process.env.SIXB_AGENT_TURN_TIMEOUT)
  if (configured === undefined) return undefined

  const match = configured.match(/^(\d+)(ms|s|m|h)$/)
  if (!match) throw invalidAgentTurnTimeout(configured)

  const amount = Number(match[1])
  const unit = match[2] as "ms" | "s" | "m" | "h"
  const multipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 60 * 60_000,
  } as const
  const timeoutMs = amount * multipliers[unit]

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DURATION_MS) {
    throw invalidAgentTurnTimeout(configured)
  }

  return timeoutMs
}

function nonblank(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function invalidAgentTurnTimeout(value: string): Error {
  return new Error(
    `[SixbCLI] Invalid agent turn timeout '${value}'. Use a positive duration like 30s, 10m, or 1h ` +
      "with --agent-turn-timeout or SIXB_AGENT_TURN_TIMEOUT."
  )
}
