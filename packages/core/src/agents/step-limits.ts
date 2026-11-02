import { RuntimeError } from "../runtime/errors"

/**
 * The most model calls a run nobody watches takes when nothing sets its own limit: a sub-agent's or
 * a workflow agent step's. Long legitimate tasks run to several hundred tool calls.
 */
export const UNATTENDED_AGENT_MAX_STEPS = 500

/** How the project's Agent runs. A step is one model call. */
export interface AgentOptions {
  /**
   * At most this many steps in one conversation turn. No limit by default: someone watches a turn
   * and can stop it.
   */
  readonly maxSteps?: number
  /** At most this many steps in one run of a sub-agent. Defaults to 500. */
  readonly subagentMaxSteps?: number
}

/** Reject a step limit that is not a positive integer, naming where it was set. */
export function assertMaxSteps(value: unknown, name: string): asserts value is number | undefined {
  if (value === undefined) return

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError(`[Sixb] ${name} must be a positive integer.`)
  }
}
