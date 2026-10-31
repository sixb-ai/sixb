import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import {
  AGENT_APPROVAL_EXECUTION_LEASE_MS,
  AgentRunScopeError,
  announceAgentApprovals,
  getAgentApprovalExecutor,
  isAwaitingApprovalRun,
  listTurnApprovals,
  resolveAgentRunExecutionScope,
  resumeDecidedAgentTurn,
  stopAgentTurn,
  turnResumeReadiness,
} from "@sixb/core/internal/agents"
import type { AgentApprovalCursor, AgentApprovalRecord, AgentStorage } from "@sixb/core/storage"
import type { AgentWorkerHost } from "./types"

const REPAIR_PAGE_SIZE = 100

/**
 * The repair pass for held calls, after a crash or a resume held back:
 * - expire the calls nobody decided in time;
 * - run the approved calls whose run was lost, once their claim is stale, so that two workers, or a
 *   worker and the decision still running the call, never both run it;
 * - resume the paused turns whose calls are all decided, and stop the ones that never can, so that
 *   no turn is tried again and again. The thread's next message reports their calls.
 */
export async function repairAgentApprovals(input: {
  readonly host: AgentWorkerHost
  readonly agents: AgentStorage
  readonly now?: Date
}): Promise<void> {
  const { host, agents } = input
  const now = input.now ?? new Date()

  for (;;) {
    const expired = await agents.approvals.expireDue({
      projectId: host.id,
      now,
      limit: REPAIR_PAGE_SIZE,
    })
    await announceAgentApprovals(host.broker, expired)
    if (expired.length < REPAIR_PAGE_SIZE) break
  }

  const staleBefore = new Date(now.getTime() - AGENT_APPROVAL_EXECUTION_LEASE_MS)
  const turns = new Map<string, AgentApprovalRecord[]>()
  let after: AgentApprovalCursor | undefined
  for (;;) {
    const page = await agents.approvals.listRepairable({
      projectId: host.id,
      claimableBefore: staleBefore,
      limit: REPAIR_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    })
    for (const approval of page) {
      turns.set(approval.runId, [...(turns.get(approval.runId) ?? []), approval])
    }

    const last = page.at(-1)
    if (!last || page.length < REPAIR_PAGE_SIZE) break
    after = { createdAt: last.createdAt, id: last.id }
  }

  for (const [runId, approvals] of turns) {
    try {
      await repairTurn({ host, agents, runId, approvals, now, staleBefore })
    } catch (error) {
      console.error(
        `[SixbAgentWorker] Could not repair the approvals of Agent run '${runId}'; retrying.`,
        error
      )
    }
  }
}

async function repairTurn(input: {
  readonly host: AgentWorkerHost
  readonly agents: AgentStorage
  readonly runId: string
  readonly approvals: readonly AgentApprovalRecord[]
  readonly now: Date
  readonly staleBefore: Date
}): Promise<void> {
  const { host, agents, runId, now, staleBefore } = input

  for (const approval of input.approvals) {
    if (approval.status !== "approved" || approval.outcome !== undefined) continue

    const claimed = await agents.approvals.claimExecution({
      projectId: host.id,
      id: approval.id,
      claimedAt: now,
      staleBefore,
    })
    // An outcome is recorded either way: when the turn's sign-in ended, it says the call did not run.
    if (claimed) await getAgentApprovalExecutor(host).complete(claimed)
  }

  const run = await agents.runs.getById({ projectId: host.id, id: runId })
  if (run?.kind !== "conversation") return
  const stop = async (why: string) => {
    await stopAgentTurn(agents, host.broker, run)
    console.warn(`[SixbAgentWorker] Agent run '${run.id}' will not resume: ${why}`)
  }

  if (!isAwaitingApprovalRun(run)) return stop("it did not pause for approval.")
  const readiness = turnResumeReadiness(
    await listTurnApprovals(agents, { projectId: host.id, runId })
  )
  if (readiness === "waiting") return
  if (readiness === "closed") return stop("one of its calls was set aside.")

  let sixb: ReturnType<typeof bindDurableAgentExecution>
  try {
    // As its requester, with the grants they have now: what a decision would have done.
    const scope = await resolveAgentRunExecutionScope(host, {
      runId: run.id,
      executionId: run.executionId,
      authority: { type: "inherited" },
    })
    sixb = bindDurableAgentExecution(host, scope)
  } catch (error) {
    if (!(error instanceof AgentRunScopeError)) throw error
    return stop("the sign-in its requester asked with has ended.")
  }

  // A refusal Sixb can try again, such as an AI limit, waits for the next pass; any other stops it.
  await resumeDecidedAgentTurn(sixb, run.id)
}
