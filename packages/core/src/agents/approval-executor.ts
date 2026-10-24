import { randomUUID } from "node:crypto"
import type { Broker } from "../broker"
import { SIXB_ERROR_CODES } from "../errors/catalog"
import { captureSixbFailure, createSixbError, isSixbError, toSixbFailure } from "../errors/internal"
import { bindDurableAgentExecution, createInheritedAgentExecutionRecord } from "../execution/agent"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { ExecutionScope } from "../execution/types"
import type { Sixb } from "../runtime/sixb"
import type { ActionRunRecord } from "../storage/action-runs"
import type {
  AgentApprovalCall,
  AgentApprovalOutcome,
  AgentApprovalRecord,
  AgentStorage,
} from "../storage/agents"
import type { WorkflowRunRecord } from "../storage/workflow-runs"
import { announceAgentApprovals } from "./approvals"
import { resolveInheritedAgentExecutionAuthorization } from "./authority"
import { AgentRequestError } from "./errors"
import {
  AgentRunScopeError,
  type AgentRunScopeHost,
  resolveAgentRunExecutionScope,
} from "./run-scope"

export interface AgentApprovalHost extends AgentRunScopeHost {
  readonly storage: AgentRunScopeHost["storage"] & {
    readonly agents?: AgentStorage
    readonly actionRuns?: {
      getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
    }
    readonly workflowRuns?: {
      getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null>
    }
  }
  readonly broker: Broker
  withScope(scope: ExecutionScope): object
}

/**
 * The request that decides, as its own bound SDK carries it. The call runs with this authority: the
 * requester's grants and credential at decision time, not those the turn started with.
 */
export type AgentApprovalDecider = ExecutionScope

/** Runs the calls a host's requesters approve. */
export interface AgentApprovalExecutor {
  /** Run the call the caller's decision just approved, and record its outcome. */
  run(approval: AgentApprovalRecord, decider: AgentApprovalDecider): Promise<AgentApprovalRecord>
  /**
   * Run an approved call a crash left without its outcome, as the run that made it, with the
   * authority its turn holds now. When that authority has ended, the outcome says so and the call
   * does not run. The caller holds the call's execution claim.
   */
  complete(approval: AgentApprovalRecord): Promise<AgentApprovalRecord>
  /**
   * The outcome of a call another decision approved, without starting it: the outcome of the run
   * this process is making, or the one the call's run recorded. Without either, the approval comes
   * back as it is.
   */
  settle(approval: AgentApprovalRecord): Promise<AgentApprovalRecord>
}

/**
 * One executor per host. It knows the calls this process is running, so that a second approval of
 * the same call, a double click or a retried request, waits for the first instead of starting it.
 */
class HostAgentApprovalExecutor implements AgentApprovalExecutor {
  private readonly running = new Map<string, Promise<AgentApprovalRecord>>()

  constructor(private readonly host: AgentApprovalHost) {}

  run(approval: AgentApprovalRecord, decider: AgentApprovalDecider): Promise<AgentApprovalRecord> {
    const key = runningKey(approval)
    const running = this.running.get(key)
    if (running) return running

    const started = this.execute(approval, () => this.bindDecision(approval, decider)).finally(() =>
      this.running.delete(key)
    )
    this.running.set(key, started)
    return started
  }

  complete(approval: AgentApprovalRecord): Promise<AgentApprovalRecord> {
    const key = runningKey(approval)
    const running = this.running.get(key)
    if (running) return running

    const started = this.completeLost(approval).finally(() => this.running.delete(key))
    this.running.set(key, started)
    return started
  }

  private async completeLost(approval: AgentApprovalRecord): Promise<AgentApprovalRecord> {
    let sixb: Sixb
    try {
      sixb = await this.bindCallerRun(approval)
    } catch (error) {
      if (!(error instanceof AgentRunScopeError)) throw error
      return this.record(approval, {
        kind: "error",
        error: toSixbFailure(
          createSixbError(
            "agent.approval_authority_lost",
            "[Sixb] The approved call did not run: the sign-in of whoever asked for it ended first. Ask the Agent again.",
            { cause: error }
          ),
          { allowedCodes: SIXB_ERROR_CODES }
        ),
      })
    }
    return this.execute(approval, async () => sixb)
  }

  /** The run that made the call, with the authority its execution holds now. */
  private async bindCallerRun(approval: AgentApprovalRecord): Promise<Sixb> {
    const run = await this.host.storage.agents?.runs.getById({
      projectId: approval.projectId,
      id: approval.callerRunId,
    })
    if (!run) throw new Error(`[Sixb] Agent run '${approval.callerRunId}' was not found.`)

    const scope = await resolveAgentRunExecutionScope(this.host, {
      runId: run.id,
      executionId: run.executionId,
      authority: { type: "inherited" },
    })
    return bindDurableAgentExecution(this.host, scope)
  }

  async settle(approval: AgentApprovalRecord): Promise<AgentApprovalRecord> {
    const running = this.running.get(runningKey(approval))
    if (running) return running

    return this.recordRanOutcome(approval)
  }

  /** Run the call bound by `bind`, and record what it gave. A refusal becomes the outcome. */
  private async execute(
    approval: AgentApprovalRecord,
    bind: () => Promise<Sixb>
  ): Promise<AgentApprovalRecord> {
    try {
      const sixb = await bind()
      return await this.record(approval, await runCall(sixb, approval.call))
    } catch (error) {
      // The call's own run is running in another request: its record holds the outcome, not this.
      if (isSixbError(error) && error.code === "action.run_in_progress") {
        return this.recordRanOutcome(approval)
      }
      return this.record(approval, {
        kind: "error",
        error: captureSixbFailure(error, {
          allowedCodes: ["internal.unexpected", "runtime.stopping"],
          defaultCode: "internal.unexpected",
        }),
      })
    }
  }

  /** Record the outcome the call's run already has, if it has one. */
  private async recordRanOutcome(approval: AgentApprovalRecord): Promise<AgentApprovalRecord> {
    const outcome = await this.ranOutcome(approval.projectId, approval.call)
    return outcome ? this.record(approval, outcome) : approval
  }

  private async ranOutcome(
    projectId: string,
    call: AgentApprovalCall
  ): Promise<AgentApprovalOutcome | undefined> {
    const storage = this.host.storage
    if (call.kind === "workflow") {
      const run = await storage.workflowRuns?.getById({ projectId, id: call.workflowRunId })
      return run
        ? workflowRunOutcome(run.id, (run.queuedAt ?? run.startedAt).toISOString())
        : undefined
    }

    const run = await storage.actionRuns?.getById({ projectId, id: call.actionRunId })
    return run ? actionRunOutcome(run) : undefined
  }

  /** Record the outcome, once, and announce it. */
  private async record(
    approval: AgentApprovalRecord,
    outcome: AgentApprovalOutcome
  ): Promise<AgentApprovalRecord> {
    const agents = this.host.storage.agents
    if (!agents) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    const recorded = await agents.approvals.recordOutcome({
      projectId: approval.projectId,
      id: approval.id,
      outcome,
    })
    await announceAgentApprovals(this.host.broker, [recorded])
    return recorded
  }

  /**
   * Bind the call to an execution of its own, as the run that made it: its executor is that run, as
   * if the gateway had let the call through. It is a child of the deciding request and carries its
   * authority: the turn's credential may have ended since, a logout or an expired session, and the
   * decider's request is live.
   */
  private async bindDecision(
    approval: AgentApprovalRecord,
    decider: AgentApprovalDecider
  ): Promise<Sixb> {
    const { projectId } = approval
    const storage = this.host.storage
    const request = await ensureExecutionRecord(
      storage.executions,
      executionRecordInputFromRuntime({
        execution: decider.execution,
        runtimeAuthorization: decider.authorization,
      })
    )
    const execution = await storage.executions.create(
      createInheritedAgentExecutionRecord({
        id: `exec_${randomUUID()}`,
        parent: request,
        runId: approval.callerRunId,
      })
    )

    // Grants come from the server's records for that credential, as the gateway resolves them.
    const authorization = await resolveInheritedAgentExecutionAuthorization({
      auth: storage.auth,
      projectId,
      authorizationRef: execution.authorizationRef,
      security: this.host.definitions.security,
    })
    return bindDurableAgentExecution(this.host, {
      execution,
      runId: approval.callerRunId,
      authorization,
    })
  }
}

function runningKey(approval: AgentApprovalRecord): string {
  return JSON.stringify([approval.projectId, approval.id])
}

/** The call names its run, so asking for it again returns the same run instead of another. */
async function runCall(sixb: Sixb, call: AgentApprovalCall): Promise<AgentApprovalOutcome> {
  if (call.kind === "workflow") {
    const started = await sixb.workflows.requestById({
      workflowId: call.workflowId,
      input: call.input,
      runId: call.workflowRunId,
      source: { type: "manual" },
    })
    return workflowRunOutcome(started.runId, started.queuedAt)
  }

  return actionRunOutcome(
    await sixb.actions.request({
      actionId: call.actionId,
      subject: call.subject,
      params: call.params,
      runId: call.actionRunId,
    })
  )
}

function actionRunOutcome(run: ActionRunRecord): AgentApprovalOutcome {
  return {
    kind: "action-run",
    runId: run.id,
    status: run.status,
    ...(run.status === "failed" && run.error ? { error: run.error } : {}),
  }
}

function workflowRunOutcome(runId: string, queuedAt: string): AgentApprovalOutcome {
  return { kind: "workflow-run", runId, queuedAt }
}

const approvalExecutorKey = Symbol("sixb.agentApprovalExecutor")

interface ApprovalExecutorOwner {
  readonly [approvalExecutorKey]?: AgentApprovalExecutor
}

export function createAgentApprovalExecutor(host: AgentApprovalHost): AgentApprovalExecutor {
  return new HostAgentApprovalExecutor(host)
}

/**
 * Attach the host's approval executor to the host, for its workers, and to its context.
 * Enumerable, like the Action run executor, so that the runtime context of every bound SDK carries
 * it: deciding needs to bind another execution.
 */
export function registerAgentApprovalExecutor(
  owner: object,
  executor: AgentApprovalExecutor
): void {
  Object.defineProperty(owner, approvalExecutorKey, {
    configurable: false,
    enumerable: true,
    value: executor,
    writable: false,
  })
}

export function getAgentApprovalExecutor(owner: object): AgentApprovalExecutor {
  const executor = (owner as ApprovalExecutorOwner)[approvalExecutorKey]
  if (!executor) {
    throw new Error(
      "[Sixb] Agent approvals cannot run from this runtime context: it was not bound by SixbHost.withScope()."
    )
  }
  return executor
}
