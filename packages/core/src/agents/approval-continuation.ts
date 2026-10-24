import type { Sixb } from "../runtime/sixb"
import type { AgentTurnResume } from "./request"

/** Where a resume left the paused turn, as whoever asked it learns. */
export type AgentApprovalResume =
  | AgentTurnResume
  /**
   * The turn could not resume as its requester: an AI limit, a lost grant or a thread they left.
   * `retrying`: Sixb tries again; otherwise the thread's next message reports the calls.
   */
  | {
      readonly status: "refused"
      readonly code: string
      readonly message: string
      readonly retrying: boolean
    }

const resumeKey = Symbol("sixb.agentTurnResume")

interface ResumeOwner {
  readonly [resumeKey]?: (runId: string) => Promise<AgentApprovalResume>
}

/**
 * Let code without a request resume a paused turn with a bound SDK's authority: the worker, after a
 * turn paused on calls already decided, and its repair pass. The call side of a decision is the
 * host's approval executor.
 */
export function registerAgentTurnResume(
  agent: object,
  resume: (runId: string) => Promise<AgentApprovalResume>
): void {
  Object.defineProperty(agent, resumeKey, {
    configurable: false,
    enumerable: false,
    value: resume,
    writable: false,
  })
}

/** Resume a paused turn as the bound SDK's principal, its requester. */
export function resumeDecidedAgentTurn(sixb: Sixb, runId: string): Promise<AgentApprovalResume> {
  const resume = (sixb.agent as ResumeOwner)[resumeKey]
  if (!resume) {
    throw new Error("[Sixb] Agent turns cannot resume from this SDK: it was not bound by Sixb.")
  }
  return resume(runId)
}
