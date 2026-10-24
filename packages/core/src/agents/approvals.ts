import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { type Principal, principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import type { Broker } from "../broker"
import type {
  AgentApprovalCall,
  AgentApprovalMode,
  AgentApprovalRecord,
  AgentRunRecord,
  AgentStorage,
} from "../storage/agents"
import { isAgentApprovalMode } from "../storage/agents/provider"
import { AGENT_APPROVAL_MODES } from "../storage/agents/types"
import type { AgentApprovalDecider, AgentApprovalExecutor } from "./approval-executor"
import { AgentRequestError } from "./errors"
import type { AgentApprovalCallSummary, AgentApprovalOutcomePart } from "./message"
import { publishAgentApprovalActivity } from "./streams/protocol"

/**
 * The mode of a turn whose requester chose none, in the thread or as their default: every action
 * and workflow waits for them. A run admitted before approval modes keeps `auto`
 * ({@link agentRunApprovalMode}).
 */
const FALLBACK_AGENT_APPROVAL_MODE: AgentApprovalMode = "manual"

/** How long a held call waits for its requester. */
export const AGENT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000

/** From least to most allowed. */
const APPROVAL_MODE_RANK: Readonly<Record<AgentApprovalMode, number>> = {
  manual: 0,
  "accept-edits": 1,
  auto: 2,
}

/** What a call does, as far as approval modes tell calls apart. */
export type AgentApprovalCallEffect =
  | { readonly kind: "action"; readonly effect: "ontology" | "external" }
  | { readonly kind: "workflow" }

/** Where a user's mode in a thread comes from: their choice there, their default, or neither. */
export type AgentApprovalModeSource = "thread" | "default" | "fallback"

export interface ResolvedAgentApprovalMode {
  readonly approvalMode: AgentApprovalMode
  readonly approvalModeSource: AgentApprovalModeSource
}

/** Whether a turn with this mode runs the call without asking. */
export function approvalModeAllows(
  mode: AgentApprovalMode,
  call: AgentApprovalCallEffect
): boolean {
  return APPROVAL_MODE_RANK[mode] >= APPROVAL_MODE_RANK[leastApprovalModeAllowing(call)]
}

/** The least the requester has to allow for this call to run without asking. */
export function leastApprovalModeAllowing(call: AgentApprovalCallEffect): AgentApprovalMode {
  return call.kind === "action" && call.effect === "ontology" ? "accept-edits" : "auto"
}

/** A mode a caller asked for, refused as a request error when it is not one. */
export function assertAgentApprovalMode(value: unknown): AgentApprovalMode {
  if (!isAgentApprovalMode(value)) {
    throw new AgentRequestError(
      "invalid_approval_mode",
      `[Sixb] Agent approval mode must be one of: ${AGENT_APPROVAL_MODES.join(", ")}.`
    )
  }
  return value
}

/** A user's mode in a thread: their choice there, then their default, then the fallback. */
export async function resolveAgentApprovalMode(
  agents: AgentStorage,
  input: {
    readonly projectId: string
    readonly principal: Principal
    /** Omitted for a thread the turn creates. */
    readonly threadId?: string
  }
): Promise<ResolvedAgentApprovalMode> {
  const chosen =
    input.threadId === undefined
      ? null
      : await agents.approvalModes.getForThread({
          projectId: input.projectId,
          threadId: input.threadId,
          principal: input.principal,
        })
  return chosen === null
    ? defaultAgentApprovalMode(agents, input)
    : { approvalMode: chosen, approvalModeSource: "thread" }
}

/** The requester's default, or the fallback when they chose none. */
export async function defaultAgentApprovalMode(
  agents: AgentStorage,
  input: { readonly projectId: string; readonly principal: Principal }
): Promise<ResolvedAgentApprovalMode> {
  const chosen = await agents.approvalModes.getDefault({
    projectId: input.projectId,
    principal: input.principal,
  })
  return chosen === null
    ? { approvalMode: FALLBACK_AGENT_APPROVAL_MODE, approvalModeSource: "fallback" }
    : { approvalMode: chosen, approvalModeSource: "default" }
}

/** The mode a run's calls are held by. A run admitted before approval modes has none: `auto`. */
export function agentRunApprovalMode(run: AgentRunRecord): AgentApprovalMode {
  return run.spec?.approvalMode ?? "auto"
}

/** What became of a call the Agent made through the gateway. */
export type AgentApprovalHold =
  /** The run's mode lets it run, or its requester approved it already. */
  | { readonly kind: "pass" }
  /** It waits for its requester: the route must not run it. */
  | { readonly kind: "held"; readonly approval: AgentApprovalRecord }
  | { readonly kind: "denied"; readonly approval: AgentApprovalRecord }
  /** The call's run id already names another call in the thread. */
  | { readonly kind: "conflict"; readonly approval: AgentApprovalRecord }

/**
 * Hold a call the run's mode does not run, until whoever asked for the turn decides on it. A
 * child's call waits for the turn that spawned it. Asking again with the same run id finds the same
 * approval: an approved call passes, as its route returns the run the decision started.
 */
export async function holdAgentApprovalCall(
  agents: AgentStorage,
  input: {
    readonly projectId: string
    /** The running conversation turn or child that makes the call. */
    readonly run: AgentRunRecord
    /** The run's requester; absent when auth is disabled. */
    readonly requestedBy?: Principal
    /** Prepared as it would run. */
    readonly call: AgentApprovalCall
    readonly now?: Date
  }
): Promise<AgentApprovalHold> {
  const { run, call } = input
  const mode = agentRunApprovalMode(run)
  if (mode === "auto" || approvalModeAllows(mode, call)) return { kind: "pass" }

  const executionToken = run.execution?.token
  if (!executionToken) {
    throw new Error(`[Sixb] Agent run '${run.id}' holds no delivery to fence its approval with.`)
  }

  const createdAt = input.now ?? new Date()
  const { approval, created } = await agents.approvals.request({
    id: `apr_${randomUUID()}`,
    projectId: input.projectId,
    runId: run.kind === "subagent" ? run.parentRunId : run.id,
    callerRunId: run.id,
    executionToken,
    requestedBy: input.requestedBy ?? SYSTEM_PRINCIPAL,
    mode,
    call,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + AGENT_APPROVAL_TTL_MS),
  })
  if (!created && !isDeepStrictEqual(approval.call, call)) return { kind: "conflict", approval }

  switch (approval.status) {
    case "approved":
      return { kind: "pass" }
    case "denied":
      return { kind: "denied", approval }
    default:
      return { kind: "held", approval }
  }
}

/** The call as the model asked for it, without its params. */
export function approvalCallSummary(call: AgentApprovalCall): AgentApprovalCallSummary {
  return call.kind === "action"
    ? { kind: "action", actionId: call.actionId, subject: call.subject }
    : { kind: "workflow", workflowId: call.workflowId }
}

/**
 * In the transaction that admits a thread's next message: set its pending approvals aside, and
 * return one part per approval that left `pending` and no message reported yet, for the message to
 * carry. An approved call reports once it ran.
 */
export async function reportAgentApprovals(
  agents: AgentStorage,
  input: { readonly projectId: string; readonly threadId: string; readonly messageId: string }
): Promise<{
  readonly parts: readonly AgentApprovalOutcomePart[]
  /** The approvals this message set aside, to announce once it is admitted. */
  readonly superseded: readonly AgentApprovalRecord[]
}> {
  const superseded = await agents.approvals.settle({ ...input, status: "superseded" })
  return { parts: await reportSettledAgentApprovals(agents, input), superseded }
}

/** Whether the turn paused on held calls: it succeeded, waiting for its requester's decisions. */
export function isAwaitingApprovalRun(run: AgentRunRecord | null | undefined): boolean {
  return (
    run?.kind === "conversation" &&
    run.status === "succeeded" &&
    run.finishReason === "awaiting_approval"
  )
}

/**
 * How long a process keeps an approved call it took to run. Longer than an Action's 30-second
 * limit, so a claim still held is a call still running; a claim older than this was lost in a crash.
 */
export const AGENT_APPROVAL_EXECUTION_LEASE_MS = 2 * 60_000

/** Where a paused turn stands, from the calls it held. */
export type AgentTurnReadiness =
  /** Every call was decided, every approved one ran, and none was reported yet. */
  | "ready"
  /** A call still waits for its decision, or an approved one has not run yet. */
  | "waiting"
  /**
   * It never resumes: a call was set aside, cancelled or expired, the turn was stopped, or it
   * resumed already. The thread's next message reports what is left.
   */
  | "closed"

export function turnResumeReadiness(approvals: readonly AgentApprovalRecord[]): AgentTurnReadiness {
  if (
    approvals.some(
      (approval) =>
        approval.status === "pending" ||
        (approval.status === "approved" && approval.outcome === undefined)
    )
  ) {
    return "waiting"
  }
  const resumable =
    approvals.length > 0 &&
    approvals.every(
      (approval) =>
        (approval.status === "approved" || approval.status === "denied") &&
        approval.turnStoppedAt === undefined
    ) &&
    approvals.some((approval) => approval.reportedInMessageId === undefined)
  return resumable ? "ready" : "closed"
}

/** The calls a conversation turn held, its children's included. */
export async function listTurnApprovals(
  agents: AgentStorage,
  input: { readonly projectId: string; readonly runId: string }
): Promise<readonly AgentApprovalRecord[]> {
  return (await agents.approvals.list({ projectId: input.projectId, runId: input.runId })).approvals
}

/**
 * The mode a resumed turn runs with: the paused turn's, raised only by "Always allow" on one of its
 * own calls. A choice made elsewhere in the thread never reaches it, and nothing lowers it.
 */
export function resumedApprovalMode(
  paused: AgentApprovalMode,
  approvals: readonly AgentApprovalRecord[]
): AgentApprovalMode {
  return approvals.reduce<AgentApprovalMode>(
    (mode, { raisedMode }) =>
      raisedMode !== undefined && APPROVAL_MODE_RANK[raisedMode] > APPROVAL_MODE_RANK[mode]
        ? raisedMode
        : mode,
    paused
  )
}

/**
 * Stop a paused turn from resuming: its calls still waiting are cancelled, and the decided ones are
 * reported by the thread's next message. Returns how many calls it stopped; none means the turn had
 * nothing left to resume on.
 */
export async function stopAgentTurn(
  agents: AgentStorage,
  broker: Broker,
  turn: { readonly projectId: string; readonly threadId: string; readonly id: string }
): Promise<number> {
  const { cancelled, stopped } = await agents.approvals.stop({
    projectId: turn.projectId,
    threadId: turn.threadId,
    runId: turn.id,
  })
  await announceAgentApprovals(broker, cancelled)
  return stopped
}

/** Announce changed approvals on the activity feed. Clients learn it best-effort. */
export async function announceAgentApprovals(
  broker: Broker,
  approvals: readonly AgentApprovalRecord[]
): Promise<void> {
  try {
    await publishAgentApprovalActivity(broker, approvals)
  } catch (error) {
    console.error("[Sixb] Agent approval activity stream publish failed:", error)
  }
}

/**
 * Mark and return, as message parts, the thread's approvals that left `pending` and no message
 * reported yet. An approved call reports once it ran: one still running when this message is
 * admitted stays for a later one.
 */
export async function reportSettledAgentApprovals(
  agents: AgentStorage,
  input: {
    readonly projectId: string
    readonly threadId: string
    readonly messageId: string
    /** A resume: the approvals of a stopped turn stay for the next message. */
    readonly resuming?: boolean
  }
): Promise<readonly AgentApprovalOutcomePart[]> {
  const { approvals } = await agents.approvals.list({
    projectId: input.projectId,
    threadId: input.threadId,
    statuses: ["approved", "denied", "cancelled", "superseded", "expired"],
    reported: false,
  })
  const reportable = approvals.filter(
    (approval) => approval.status !== "approved" || approval.outcome !== undefined
  )
  if (reportable.length === 0) return []

  const marked = new Set(
    await agents.approvals.markReported({ ...input, ids: reportable.map(({ id }) => id) })
  )
  return reportable.filter(({ id }) => marked.has(id)).map(approvalOutcomePart)
}

function approvalOutcomePart(approval: AgentApprovalRecord): AgentApprovalOutcomePart {
  return {
    type: "approval-outcome",
    approvalId: approval.id,
    status: approval.status === "pending" ? "superseded" : approval.status,
    call: approvalCallSummary(approval.call),
    ...(approval.outcome === undefined ? {} : { outcome: approval.outcome }),
  }
}

/**
 * Decide on a held call as `decidedBy`, who must be who asked for the turn: the call runs with their
 * rights. Only the decision that approves it runs it, as the run that made it and with the deciding
 * request's authority, and records its outcome. Approving again never starts it: it returns the
 * outcome, waiting for the run this process is making, or reading the call's run.
 */
export async function decideAgentApproval(
  agents: AgentStorage,
  executor: AgentApprovalExecutor,
  input: {
    readonly approval: AgentApprovalRecord
    readonly decision: "approved" | "denied"
    readonly decidedBy: Principal
    /** The deciding request: an approved call runs with its authority. */
    readonly decider: AgentApprovalDecider
    /** "Always allow": the mode the requester raises the turn's calls to with this approval. */
    readonly raisedMode?: AgentApprovalMode
    /** Where the decision is announced; the executor announces the call's outcome. */
    readonly broker: Broker
  }
): Promise<AgentApprovalRecord> {
  const { approval } = input
  if (!principalsEqual(approval.requestedBy, input.decidedBy)) {
    throw new AgentRequestError(
      "not_run_requester",
      `[Sixb] Only whoever asked for Agent run '${approval.runId}' can decide on its approval '${approval.id}': the call runs with their rights.`
    )
  }

  const result = await agents.approvals.decide({
    projectId: approval.projectId,
    id: approval.id,
    decision: input.decision,
    decidedBy: input.decidedBy,
    ...(input.raisedMode === undefined ? {} : { raisedMode: input.raisedMode }),
  })
  const decided = result?.approval
  if (!result || !decided) {
    throw new AgentRequestError(
      "approval_not_found",
      `[Sixb] Agent approval '${approval.id}' was not found.`
    )
  }
  if (decided.status === "expired") {
    await announceAgentApprovals(input.broker, [decided])
    throw new AgentRequestError(
      "approval_expired",
      `[Sixb] Agent approval '${approval.id}' expired before it was decided. Ask the Agent again.`
    )
  }
  if (decided.status !== input.decision) {
    throw new AgentRequestError(
      "approval_not_pending",
      `[Sixb] Agent approval '${approval.id}' is already ${decided.status}.`
    )
  }

  if (decided.status !== "approved" || decided.outcome !== undefined) {
    if (result.decided) await announceAgentApprovals(input.broker, [decided])
    return decided
  }

  // Started before anything else is awaited, so a second approval finds it running.
  const running = result.decided ? executor.run(decided, input.decider) : executor.settle(decided)
  if (result.decided) await announceAgentApprovals(input.broker, [decided])
  return running
}
