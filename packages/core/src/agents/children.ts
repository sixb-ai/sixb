import type { SixbFailure } from "../errors/types"
import type { LanguageModelRef, LanguageModelTier } from "../models"
import { addCostSummaries } from "../runtime/ai-cost"
import { addUsageSummaries } from "../runtime/ai-usage"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentApprovalRecord,
  AgentRunFailureCode,
  AgentRunFinishReason,
  AgentRunRecord,
  AgentRunStatus,
  AgentStorage,
  AgentThreadRecord,
  SubagentRunFile,
  SubagentRunRecord,
  SubagentRunResult,
} from "../storage/agents"
import type { AiCostSummary } from "../storage/ai-cost"
import type { AiModelCallUsage } from "../storage/ai-usage"
import { resolveTurnAccounting } from "./accounting"
import { isPausedSubagentRun, turnResumeReadiness } from "./approvals"
import { cancelQueuedRun } from "./cancel"
import {
  type AgentChildQuestion,
  deferredChildQuestion,
  isAwaitingAnswerRun,
} from "./child-question"
import { AgentRequestError } from "./errors"
import { publishAgentRunCancel } from "./streams/protocol"
import { listSubagentThreadRuns } from "./subagent-runs"
import type { AgentReasoning } from "./types"

// A child the Agent spawned works in a thread of its own, however many runs it takes: a child that
// paused on its held calls or its question continues, once decided or answered, as the next run of
// its thread, under the turn that goes on. Readers see the thread as one child.

/** What a child waits for before it goes on. */
export type AgentChildAwaiting =
  | {
      /** Its calls still waiting for the turn's requester, filed on the turn that ran it. */
      readonly type: "approval"
      readonly approvalIds: readonly string[]
    }
  | {
      /** Its calls were decided: it continues once its turn resumes. */
      readonly type: "resume"
    }
  | {
      /**
       * It paused on the question it asked its parent when the parent's turn ended: a later turn of
       * the conversation answers it, and it continues with the answer.
       */
      readonly type: "answer"
      readonly question: AgentChildQuestion
    }

/**
 * Why a paused child never continues. On its calls: a new message set them aside, one expired, or
 * its turn was stopped, its requester leaving among the reasons. On its question: the Agent spawned
 * another child under its key, which a later answer would reach instead.
 */
export type AgentChildEndReason = "superseded" | "expired" | "stopped" | "replaced"

/** One run of a child: the one spawned, or one that continued it. */
export interface AgentChildRunView {
  readonly id: string
  /** The turn the run worked under: the one that spawned the child, or one that went on with it. */
  readonly parentRunId: string
  readonly status: AgentRunStatus
  readonly finishReason?: AgentRunFinishReason
  readonly error?: SixbFailure<AgentRunFailureCode>
  readonly modelId?: string
  readonly attempt: number
  readonly createdAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
  /** What it answered, and the files it wrote under `out/`. */
  readonly result?: SubagentRunResult
  /** Its own model calls and those of what it ran. */
  readonly usage?: AiModelCallUsage
  readonly cost?: AiCostSummary
}

/** A child of a conversation, its thread, with every run it took. */
export interface AgentChildView {
  /** Its first run's id: the one `spawn_agent` answered with. */
  readonly id: string
  /** Its own thread, whose messages are what it did. */
  readonly threadId: string
  readonly projectId: string
  /** The turn that spawned it. */
  readonly spawnedBy: string
  readonly key: string
  readonly task: string
  readonly model: LanguageModelRef
  readonly tier?: LanguageModelTier
  readonly reasoning?: AgentReasoning
  /** What its parent handed it, by path in its sandbox. */
  readonly handedFiles: readonly SubagentRunFile[]
  /** Its latest run's. */
  readonly status: AgentRunStatus
  readonly finishReason?: AgentRunFinishReason
  readonly error?: SixbFailure<AgentRunFailureCode>
  /** Set while its latest run paused, until it continues. */
  readonly awaiting?: AgentChildAwaiting
  /** Set when its latest run paused and it will not continue. */
  readonly ended?: { readonly reason: AgentChildEndReason }
  /** Its run at work, which streams; `null` when none is. */
  readonly activeRunId: string | null
  readonly createdAt: Date
  /** Its latest run's, once that ended. */
  readonly completedAt?: Date
  /** Every run of it. */
  readonly usage?: AiModelCallUsage
  readonly cost?: AiCostSummary
  /** Oldest first: the run spawned, then each that continued it. */
  readonly runs: readonly AgentChildRunView[]
}

const PAGE = 100

/** A conversation's children, oldest first: all of them, or those one of its turns spawned. */
export async function listAgentChildren(
  runtime: SixbRuntimeContext,
  conversation: AgentThreadRecord,
  options: { readonly spawnedBy?: string } = {}
): Promise<readonly AgentChildView[]> {
  const agents = requireAgents(runtime)
  const threads: AgentThreadRecord[] = []
  for (;;) {
    const page = await agents.threads.listChildren({
      projectId: runtime.projectId,
      parentThreadId: conversation.id,
      ...(options.spawnedBy === undefined ? {} : { parentRunId: options.spawnedBy }),
      limit: PAGE,
      offset: threads.length,
    })
    threads.push(...page)
    if (page.length < PAGE) break
  }
  return readChildren(runtime, conversation, threads)
}

/** The child that works in `thread`, a sub-agent's thread of `conversation`. */
export async function readAgentChild(
  runtime: SixbRuntimeContext,
  conversation: AgentThreadRecord,
  thread: AgentThreadRecord
): Promise<AgentChildView | null> {
  if (thread.parent?.threadId !== conversation.id) return null
  const [child] = await readChildren(runtime, conversation, [thread])
  return child ?? null
}

/**
 * Stop a child's run at work. A queued one is cancelled here; a running one receives the stop signal
 * its worker obeys, so it is still running when this returns. Who may stop it is the caller's
 * decision.
 */
export async function cancelAgentChildRun(
  runtime: SixbRuntimeContext,
  run: SubagentRunRecord
): Promise<AgentRunRecord> {
  let current: AgentRunRecord | null = run
  if (run.status === "queued") {
    const queued = await cancelQueuedRun(runtime, requireAgents(runtime), run)
    if (queued.cancelled) return queued.run
    current = queued.run
  }

  if (current?.status !== "running") {
    throw new AgentRequestError(
      "run_not_active",
      `[Sixb] Sub-agent run '${run.id}' is not at work: it is ${current?.status ?? run.status}.`
    )
  }
  await publishAgentRunCancel(runtime.broker, { projectId: runtime.projectId, runId: run.id })
  return current
}

async function readChildren(
  runtime: SixbRuntimeContext,
  conversation: AgentThreadRecord,
  threads: readonly AgentThreadRecord[]
): Promise<readonly AgentChildView[]> {
  if (threads.length === 0) return []

  const agents = requireAgents(runtime)
  const runsOf = await Promise.all(threads.map((thread) => listThreadRuns(agents, thread)))
  const runs = runsOf.flat()
  const approvals = createTurnApprovals(agents, runtime.projectId)

  const accounting = await resolveTurnAccounting(
    runtime,
    runs.map((run) => run.executionId)
  )
  const accounted = new Map(runs.map((run, index) => [run.id, accounting[index] ?? {}]))

  const children = await Promise.all(
    threads.map(async (thread, index) => {
      const own = runsOf[index] ?? []
      const first = own[0]
      const latest = own.at(-1)
      if (!first || !latest) return null

      const views = own.map((run) => childRunView(run, accounted.get(run.id) ?? {}))
      const usage = addUsageSummaries(views.flatMap((view) => (view.usage ? [view.usage] : [])))
      const cost = addCostSummaries(views.flatMap((view) => (view.cost ? [view.cost] : [])))
      const paused = isPausedSubagentRun(latest)
        ? await pausedState(agents, approvals, latest)
        : await questionState(agents, conversation.id, thread, own)

      return {
        id: first.id,
        threadId: thread.id,
        projectId: thread.projectId,
        spawnedBy: first.parentRunId,
        key: first.spawnKey,
        task: first.spec.task,
        model: first.spec.model,
        ...(first.spec.tier === undefined ? {} : { tier: first.spec.tier }),
        ...(first.spec.reasoning === undefined ? {} : { reasoning: first.spec.reasoning }),
        handedFiles: first.spec.files ?? [],
        status: latest.status,
        ...(latest.finishReason === undefined ? {} : { finishReason: latest.finishReason }),
        ...(latest.error === undefined ? {} : { error: latest.error }),
        ...paused,
        activeRunId: thread.activeRunId,
        createdAt: thread.createdAt,
        ...(latest.completedAt === undefined ? {} : { completedAt: latest.completedAt }),
        ...(usage === undefined ? {} : { usage }),
        ...(cost === undefined ? {} : { cost }),
        runs: views,
      } satisfies AgentChildView
    })
  )
  return children.filter((child) => child !== null)
}

/** A child thread's runs, in the order they ran. */
function listThreadRuns(
  agents: AgentStorage,
  thread: AgentThreadRecord
): Promise<readonly SubagentRunRecord[]> {
  return listSubagentThreadRuns(agents, { projectId: thread.projectId, threadId: thread.id })
}

function childRunView(
  run: SubagentRunRecord,
  accounting: { readonly usage?: AiModelCallUsage; readonly cost?: AiCostSummary }
): AgentChildRunView {
  return {
    id: run.id,
    parentRunId: run.parentRunId,
    status: run.status,
    ...(run.finishReason === undefined ? {} : { finishReason: run.finishReason }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
    attempt: run.attempt,
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(accounting.usage === undefined ? {} : { usage: accounting.usage }),
    ...(accounting.cost === undefined ? {} : { cost: accounting.cost }),
  }
}

/** A turn's approvals, read once per turn however many of its children ask. */
interface TurnApprovals {
  of(turnId: string): Promise<readonly AgentApprovalRecord[]>
}

function createTurnApprovals(agents: AgentStorage, projectId: string): TurnApprovals {
  const read = new Map<string, Promise<readonly AgentApprovalRecord[]>>()

  return {
    of(turnId) {
      const known = read.get(turnId)
      if (known) return known

      const approvals = listAllApprovals(agents, projectId, turnId)
      read.set(turnId, approvals)
      return approvals
    },
  }
}

/**
 * Where a paused child stands, from its calls and its turn's: still waiting for decisions, decided
 * and continuing once the turn resumes, or ended without continuing. Every call reported by a
 * message: only a resume that continues it keeps it going.
 */
async function pausedState(
  agents: AgentStorage,
  approvals: TurnApprovals,
  run: SubagentRunRecord
): Promise<Pick<AgentChildView, "awaiting" | "ended">> {
  const turnApprovals = await approvals.of(run.parentRunId)
  const own = turnApprovals.filter((approval) => approval.callerRunId === run.id)

  const pending = own.filter((approval) => approval.status === "pending")
  if (pending.length > 0) {
    return { awaiting: { type: "approval", approvalIds: pending.map((approval) => approval.id) } }
  }

  const ended = { ended: { reason: endReason(own, turnApprovals) } }
  const reportedIn = new Set(own.flatMap((approval) => approval.reportedInMessageId ?? []))
  if (reportedIn.size === 0) {
    // A stopped turn never resumes, even on a call still running when it was stopped.
    const stopped = turnApprovals.some((approval) => approval.turnStoppedAt !== undefined)
    const closed = stopped || turnResumeReadiness(turnApprovals) === "closed"
    return closed ? ended : { awaiting: { type: "resume" } }
  }

  for (const messageId of reportedIn) {
    const message = await agents.messages.getById({ projectId: run.projectId, id: messageId })
    const continues = message?.parts.some(
      (part) =>
        part.type === "approval-outcome" &&
        part.caller?.runId === run.id &&
        part.caller.continues === true
    )
    // Reported by the resume, whose turn admits its continuation before its model runs.
    if (continues) return { awaiting: { type: "resume" } }
  }
  return ended
}

/**
 * Where a child that paused on its question stands: waiting for a later turn's answer while its
 * thread is the latest under its key in the conversation, else replaced. A continuation that
 * failed or was stopped leaves the question open again, so the run waiting is the one before it.
 */
async function questionState(
  agents: AgentStorage,
  conversationId: string,
  thread: AgentThreadRecord,
  runs: readonly SubagentRunRecord[]
): Promise<Pick<AgentChildView, "awaiting" | "ended">> {
  const waiting = [...runs]
    .reverse()
    .find((run) => run.status !== "failed" && run.status !== "cancelled")
  if (!waiting || !isAwaitingAnswerRun(waiting)) return {}

  const [latest] = await agents.runs.listThreadSubagents({
    projectId: waiting.projectId,
    threadId: conversationId,
    spawnKey: waiting.spawnKey,
    limit: 1,
  })
  if (latest && latest.threadId !== thread.id) return { ended: { reason: "replaced" } }

  // Its question is in the last message of the run that paused.
  const { messages } = await agents.messages.list({
    projectId: thread.projectId,
    threadId: thread.id,
    order: "desc",
    limit: 2,
  })
  const work = messages.find(
    (message) => message.runId === waiting.id && message.role === "assistant"
  )
  const question = work ? deferredChildQuestion([work]) : undefined
  return question ? { awaiting: { type: "answer", question } } : {}
}

/** Its own calls say why first, then its turn's: a sibling's call set aside closes the turn too. */
function endReason(
  own: readonly AgentApprovalRecord[],
  turn: readonly AgentApprovalRecord[]
): AgentChildEndReason {
  for (const approvals of [own, turn]) {
    if (approvals.some((approval) => approval.status === "superseded")) return "superseded"
    if (approvals.some((approval) => approval.status === "expired")) return "expired"
  }
  return "stopped"
}

async function listAllApprovals(
  agents: AgentStorage,
  projectId: string,
  runId: string
): Promise<readonly AgentApprovalRecord[]> {
  const approvals: AgentApprovalRecord[] = []
  for (;;) {
    const page = await agents.approvals.list({
      projectId,
      runId,
      limit: PAGE,
      offset: approvals.length,
    })
    approvals.push(...page.approvals)
    if (!page.hasMore || page.approvals.length === 0) return approvals
  }
}

function requireAgents(runtime: SixbRuntimeContext): AgentStorage {
  const agents = runtime.storage.agents
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return agents
}
