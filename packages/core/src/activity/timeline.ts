import {
  readableSubjects,
  unreadableActionRunTypes,
  viewableActionRuns,
} from "../actions/run-authorization"
import { canViewWorkflowRun, isRuntimeAllowed } from "../authorization"
import { resolveExecutionCosts } from "../runtime/ai-cost"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ActionRunStatus } from "../storage/action-runs"
import { ACTIVITY_MAX_VISIT_MS, ACTIVITY_MIN_IDLE_TIMEOUT_MS } from "../storage/activity/policy"
import type { ActivityVisit, StoredActivityVisitPage } from "../storage/activity/types"
import type { AgentRunStatus, ConversationAgentRunRecord } from "../storage/agents"
import type { AiCostSummary } from "../storage/ai-cost"
import type { ExecutionRecord } from "../storage/executions"
import { objectBatchKey } from "../storage/objects/keys"
import type { ShareGrantRecord } from "../storage/share-grants"
import type { WorkflowRunStatus } from "../storage/workflow-runs"
import { type ActivityConnection, readActivityConnection } from "./connection"
import type { ActivityVisitView } from "./shares"

/**
 * At most this many page views and interactions together, and as many recorded executions, make a
 * visit's timeline.
 */
export const ACTIVITY_TIMELINE_LIMIT = 200

/**
 * How far around its activity a visit claims its session's executions. A click right after a
 * return reaches the server before the activity that opens the visit, and the last action before
 * leaving may come after the last activity sent. Half the shortest idle timeout keeps the visits of
 * one session from claiming the same execution.
 */
const SESSION_GRACE_MS = ACTIVITY_MIN_IDLE_TIMEOUT_MS / 2

export interface ActivityPageEntry {
  readonly kind: "page"
  readonly at: Date
  readonly sequence: number
  readonly route: string
}

/** An interaction the app marked, on the page it happened on. */
export interface ActivityInteractionEntry {
  readonly kind: "interaction"
  readonly at: Date
  readonly sequence: number
  readonly name: string
  readonly route: string
}

export interface ActivityActionEntry {
  readonly kind: "action"
  readonly at: Date
  readonly executionId: string
  readonly actionId: string
  readonly runId: string
  /** `incomplete` when no outcome is recorded: the run is in flight, or was interrupted. */
  readonly status: ActionRunStatus | "incomplete"
  /** Whether the viewer may read the run itself, as Observability › Runs shows it. */
  readonly runVisible: boolean
  /** The object it applied to, only when the viewer can read that object. */
  readonly object?: { readonly objectTypeId: string; readonly primaryId: string }
}

export interface ActivityWorkflowEntry {
  readonly kind: "workflow"
  readonly at: Date
  readonly executionId: string
  readonly workflowId: string
  readonly runId: string
  readonly status: WorkflowRunStatus | "incomplete"
  /** Whether the viewer may read the run itself, as Observability › Runs shows it. */
  readonly runVisible: boolean
}

/** A conversation's run: its metadata, and its thread's title only for those who read threads. */
export interface ActivityAgentEntry {
  readonly kind: "agent"
  readonly at: Date
  readonly executionId: string
  readonly runId: string
  readonly threadId: string
  /**
   * Present only when the viewer can read the conversation, with `can.observe(agent.threads)`.
   * Activity alone never shows a title or a message.
   */
  readonly thread?: { readonly title?: string }
  readonly status: AgentRunStatus
  /** Messages in the thread now, every run's. */
  readonly messages: number
  /** The run's model calls with those of its subagents and tools; absent without any. */
  readonly cost?: AiCostSummary
}

export type ActivityTimelineEntry =
  | ActivityPageEntry
  | ActivityInteractionEntry
  | ActivityActionEntry
  | ActivityWorkflowEntry
  | ActivityAgentEntry

export interface ActivityVisitTimeline {
  readonly visit: ActivityVisitView
  /** Absent once the session is gone, or without an auth or share store. */
  readonly connection?: ActivityConnection
  /**
   * By time. Page views and interactions come in their sequence, and before executions at the same
   * instant.
   */
  readonly entries: readonly ActivityTimelineEntry[]
  /**
   * More than {@link ACTIVITY_TIMELINE_LIMIT} page views and interactions, or recorded executions.
   * The timeline then stops at the last page view or interaction, or the last root execution, it
   * could keep.
   */
  readonly truncated: boolean
}

/**
 * A visit's timeline: its page views and interactions, and what its session started while it
 * lasted. One bounded read per source, each batched over the visit; see `README.md`.
 */
export async function composeActivityTimeline(
  runtime: SixbRuntimeContext,
  input: {
    readonly page: StoredActivityVisitPage
    /** The visit, named by its link's share. */
    readonly visit: ActivityVisitView
    /** That link's grant, read with the name. */
    readonly grant?: ShareGrantRecord
  },
  now: Date
): Promise<ActivityVisitTimeline> {
  const { page, visit } = input
  const { storage, projectId } = runtime

  const [ledger, connection] = await Promise.all([
    storage.executions.listBySession({
      projectId,
      session: { type: visit.actor.type, id: page.sessionId },
      ...sessionWindow(visit),
      limit: ACTIVITY_TIMELINE_LIMIT,
    }),
    readActivityConnection(runtime, page, input.grant, now),
  ])
  const executions = ledger.executions

  const ofKind = (kind: "action" | "workflow") =>
    executions.flatMap((execution) =>
      execution.executor.type === "primitive" && execution.executor.kind === kind
        ? [execution.id]
        : []
    )
  const agentRunIds = executions.flatMap((execution) =>
    execution.executor.type === "agent" ? [execution.executor.runId] : []
  )

  // Only what an Agent ran can count toward a conversation's cost.
  const byId = new Map(executions.map((execution) => [execution.id, execution]))
  const withAgent = executions.filter((execution) =>
    lineage(execution, byId).some((ancestor) => ancestor.executor.type === "agent")
  )

  const [actionRuns, workflowRuns, agentRuns, costs] = await Promise.all([
    storage.actionRuns?.getByExecutionIds({ projectId, executionIds: ofKind("action") }) ?? [],
    storage.workflowRuns?.getByExecutionIds({ projectId, executionIds: ofKind("workflow") }) ?? [],
    storage.agents?.runs.getByIds({ projectId, ids: agentRunIds }) ?? [],
    resolveExecutionCosts({
      storage: storage.aiCosts,
      projectId,
      executionIds: withAgent.map((execution) => execution.id),
    }),
  ])

  // A subagent's cost goes to the conversation above it. A Workflow's Agent steps have none.
  const conversations = new Map(
    agentRuns.flatMap((run) =>
      run.kind === "conversation" ? [[run.executionId, run] as const] : []
    )
  )
  const subjects = actionRuns.flatMap((run) => (run.subject.kind === "object" ? [run.subject] : []))

  const [threads, readable, unreadableRunTypes, viewableRuns] = await Promise.all([
    storage.agents?.threads.getByIds({
      projectId,
      ids: [...conversations.values()].map((run) => run.threadId),
    }) ?? [],
    readableSubjects(runtime.objectReader, subjects),
    subjects.length > 0 ? unreadableActionRunTypes(runtime.objectReader) : new Set<string>(),
    viewableActionRuns(runtime.objectReader, runtime.authorization, actionRuns),
  ])

  const actionRunByExecution = new Map(actionRuns.map((run) => [run.executionId, run]))
  const viewableRunIds = new Set(viewableRuns.map((run) => run.id))
  const workflowRunByExecution = new Map(workflowRuns.map((run) => [run.executionId, run]))
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  const observesThreads = isRuntimeAllowed(runtime, { kind: "agentThreads.observe" })
  const costByAgent = rollUpCosts(byId, conversations, withAgent, costs)

  const executionEntries = executions.flatMap((execution): ActivityTimelineEntry[] => {
    const at = new Date(execution.createdAt)
    const executor = execution.executor
    const authority = execution.authorizationRef

    if (executor.type === "primitive" && authority.type === "trustedPrimitive") {
      if (executor.kind === "action") {
        const run = actionRunByExecution.get(execution.id)
        const subject = run?.subject.kind === "object" ? run.subject : undefined
        const object =
          subject && readable.has(objectBatchKey(subject.objectTypeId, subject.primaryId))
            ? { objectTypeId: subject.objectTypeId, primaryId: subject.primaryId }
            : undefined

        // As the runs page decides: the action, its subject's type or, through a condition, the
        // subject itself, and the type's markings.
        const runVisible =
          run !== undefined &&
          viewableRunIds.has(run.id) &&
          (subject === undefined || !unreadableRunTypes.has(subject.objectTypeId))

        return [
          {
            kind: "action",
            at,
            executionId: execution.id,
            actionId: authority.primitive.id,
            runId: executor.runId,
            status: run?.status ?? "incomplete",
            runVisible,
            ...(object === undefined ? {} : { object }),
          },
        ]
      }

      if (executor.kind === "workflow") {
        const run = workflowRunByExecution.get(execution.id)
        return [
          {
            kind: "workflow",
            at,
            executionId: execution.id,
            workflowId: authority.primitive.id,
            runId: executor.runId,
            status: run?.status ?? "incomplete",
            runVisible: run !== undefined && canViewWorkflowRun(runtime.authorization, run),
          },
        ]
      }
    }

    const conversation = conversations.get(execution.id)
    if (conversation) {
      const cost = costByAgent.get(execution.id)
      const thread = threadById.get(conversation.threadId)
      const title = thread?.title

      return [
        {
          kind: "agent",
          at,
          executionId: execution.id,
          runId: conversation.id,
          threadId: conversation.threadId,
          ...(observesThreads && thread ? { thread: title === undefined ? {} : { title } } : {}),
          status: conversation.status,
          messages: thread?.messageCount ?? 0,
          ...(cost === undefined ? {} : { cost }),
        },
      ]
    }

    return []
  })

  // Recorded entries come first at an equal instant, in their sequence: the sort is stable.
  const recorded = [
    ...page.pageViews.map(
      (pageView): ActivityPageEntry => ({
        kind: "page",
        at: new Date(pageView.receivedAt),
        sequence: pageView.sequence,
        route: pageView.route,
      })
    ),
    ...page.interactions.map(
      (interaction): ActivityInteractionEntry => ({
        kind: "interaction",
        at: new Date(interaction.receivedAt),
        sequence: interaction.sequence,
        name: interaction.name,
        route: interaction.route,
      })
    ),
  ].sort((left, right) => left.sequence - right.sequence)

  // Past the last page view, interaction or root kept, a source left rows out: the timeline stops
  // there.
  const cutoffs = [
    page.hasMore ? recorded.at(-1)?.at : undefined,
    ledger.truncated
      ? executions.filter((execution) => execution.source.type !== "execution").at(-1)?.createdAt
      : undefined,
  ].flatMap((at) => (at === undefined ? [] : [at.getTime()]))
  const cutoff = cutoffs.length > 0 ? Math.min(...cutoffs) : Number.POSITIVE_INFINITY

  const entries = [...recorded, ...executionEntries]
    .filter((entry) => entry.at.getTime() <= cutoff)
    .sort((left, right) => left.at.getTime() - right.at.getTime())

  return {
    visit,
    ...(connection === undefined ? {} : { connection }),
    entries,
    truncated: page.hasMore || ledger.truncated,
  }
}

/**
 * Roots created in `[start - grace, last activity + grace)`, cut where the session's next visit
 * may start once this one is a day old.
 */
function sessionWindow(visit: ActivityVisit): { readonly from: Date; readonly to: Date } {
  const startedAt = visit.startedAt.getTime()
  return {
    from: new Date(startedAt - SESSION_GRACE_MS),
    to: new Date(
      Math.min(
        visit.lastSeenAt.getTime() + SESSION_GRACE_MS,
        startedAt + ACTIVITY_MAX_VISIT_MS - SESSION_GRACE_MS
      )
    ),
  }
}

/** An execution, then its parent and the parent's, as far as the visit's executions go. */
function lineage(
  execution: ExecutionRecord,
  byId: ReadonlyMap<string, ExecutionRecord>
): readonly ExecutionRecord[] {
  const chain: ExecutionRecord[] = []
  let current: ExecutionRecord | undefined = execution

  while (current) {
    chain.push(current)
    current = current.source.type === "execution" ? byId.get(current.source.executionId) : undefined
  }
  return chain
}

/** Each conversation's cost: its own calls and those of everything below it, each counted once. */
function rollUpCosts(
  byId: ReadonlyMap<string, ExecutionRecord>,
  conversations: ReadonlyMap<string, ConversationAgentRunRecord>,
  withAgent: readonly ExecutionRecord[],
  costs: readonly (AiCostSummary | undefined)[]
): ReadonlyMap<string, AiCostSummary> {
  const grouped = new Map<string, AiCostSummary[]>()

  withAgent.forEach((execution, index) => {
    const cost = costs[index]
    const owner = lineage(execution, byId).find((ancestor) => conversations.has(ancestor.id))
    if (!cost || !owner) {
      return
    }

    const summaries = grouped.get(owner.id) ?? []
    summaries.push(cost)
    grouped.set(owner.id, summaries)
  })

  return new Map(
    [...grouped].flatMap(([owner, summaries]) => {
      const total = addCosts(summaries)
      return total ? [[owner, total] as const] : []
    })
  )
}

function addCosts(summaries: readonly AiCostSummary[]): AiCostSummary | undefined {
  const amounts = new Map<string, bigint>()
  let ratedCallCount = 0
  let unpriceableCallCount = 0
  let unvaluedCallCount = 0

  for (const summary of summaries) {
    for (const money of summary.amounts) {
      amounts.set(money.currency, (amounts.get(money.currency) ?? 0n) + BigInt(money.amountNanos))
    }
    ratedCallCount += summary.ratedCallCount
    unpriceableCallCount += summary.unpriceableCallCount
    unvaluedCallCount += summary.unvaluedCallCount
  }

  if (ratedCallCount + unpriceableCallCount + unvaluedCallCount === 0) {
    return undefined
  }

  return {
    amounts: [...amounts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([currency, amount]) => ({ currency, amountNanos: amount.toString() })),
    ratedCallCount,
    unpriceableCallCount,
    unvaluedCallCount,
  }
}
