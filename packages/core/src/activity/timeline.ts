import type { ActionObjectSubject } from "../actions"
import { unreadableActionRunTypes } from "../actions/run-authorization"
import { AuthorizationError, canViewActionRun, canViewWorkflowRun } from "../authorization"
import { resolveExecutionCosts } from "../runtime/ai-cost"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ActionRunStatus } from "../storage/action-runs"
import { ACTIVITY_MAX_VISIT_MS, ACTIVITY_MIN_IDLE_TIMEOUT_MS } from "../storage/activity/policy"
import type { ActivityVisit, StoredActivityVisitPage } from "../storage/activity/types"
import type { AgentRunStatus, ConversationAgentRunRecord } from "../storage/agents"
import type { AiCostSummary } from "../storage/ai-cost"
import type { ExecutionRecord } from "../storage/executions"
import { objectBatchKey } from "../storage/objects/keys"
import type { WorkflowRunStatus } from "../storage/workflow-runs"
import { type ActivityConnection, readActivityConnection } from "./connection"

/** At most this many page views, and as many recorded executions, make a visit's timeline. */
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

/** A conversation's run: its metadata only, never its title or messages. */
export interface ActivityAgentEntry {
  readonly kind: "agent"
  readonly at: Date
  readonly executionId: string
  readonly runId: string
  readonly threadId: string
  readonly status: AgentRunStatus
  /** Messages in the thread now, every run's. */
  readonly messages: number
  /** The run's model calls with those of its subagents and tools; absent without any. */
  readonly cost?: AiCostSummary
}

export type ActivityTimelineEntry =
  | ActivityPageEntry
  | ActivityActionEntry
  | ActivityWorkflowEntry
  | ActivityAgentEntry

export interface ActivityVisitTimeline {
  readonly visit: ActivityVisit
  /** Absent once the session is gone, or without an auth or share store. */
  readonly connection?: ActivityConnection
  /** By time. Page views and executions at the same instant keep that order. */
  readonly entries: readonly ActivityTimelineEntry[]
  /**
   * More than {@link ACTIVITY_TIMELINE_LIMIT} page views or recorded executions. The timeline then
   * stops at the last page view, or the last root execution, it could keep.
   */
  readonly truncated: boolean
}

/**
 * A visit's timeline: its page views, and what its session started while it lasted. One bounded
 * read per source, each batched over the visit; see `README.md`.
 */
export async function composeActivityTimeline(
  runtime: SixbRuntimeContext,
  page: StoredActivityVisitPage,
  now: Date
): Promise<ActivityVisitTimeline> {
  const { visit } = page
  const { storage, projectId } = runtime

  const [ledger, connection] = await Promise.all([
    storage.executions.listBySession({
      projectId,
      session: { type: visit.actor.type, id: page.sessionId },
      ...sessionWindow(visit),
      limit: ACTIVITY_TIMELINE_LIMIT,
    }),
    readActivityConnection(runtime, page, now),
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

  const [threads, readable, unreadableRunTypes] = await Promise.all([
    storage.agents?.threads.getByIds({
      projectId,
      ids: [...conversations.values()].map((run) => run.threadId),
    }) ?? [],
    readableObjects(runtime, subjects),
    subjects.length > 0 ? unreadableActionRunTypes(runtime.objectReader) : new Set<string>(),
  ])

  const actionRunByExecution = new Map(actionRuns.map((run) => [run.executionId, run]))
  const workflowRunByExecution = new Map(workflowRuns.map((run) => [run.executionId, run]))
  const messagesByThread = new Map(threads.map((thread) => [thread.id, thread.messageCount]))
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

        // As the runs page decides: the action and its subject's type, and the type's markings.
        const runVisible =
          run !== undefined &&
          canViewActionRun(runtime.authorization, run) &&
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
      return [
        {
          kind: "agent",
          at,
          executionId: execution.id,
          runId: conversation.id,
          threadId: conversation.threadId,
          status: conversation.status,
          messages: messagesByThread.get(conversation.threadId) ?? 0,
          ...(cost === undefined ? {} : { cost }),
        },
      ]
    }

    return []
  })

  // Past the last page view or root kept, a source left rows out: the timeline stops there.
  const cutoffs = [
    page.hasMore ? page.pageViews.at(-1)?.receivedAt : undefined,
    ledger.truncated
      ? executions.filter((execution) => execution.source.type !== "execution").at(-1)?.createdAt
      : undefined,
  ].flatMap((at) => (at === undefined ? [] : [at.getTime()]))
  const cutoff = cutoffs.length > 0 ? Math.min(...cutoffs) : Number.POSITIVE_INFINITY

  // Page views come first at an equal instant: the sort is stable.
  const entries = [
    ...page.pageViews.map(
      (pageView): ActivityPageEntry => ({
        kind: "page",
        at: new Date(pageView.receivedAt),
        sequence: pageView.sequence,
        route: pageView.route,
      })
    ),
    ...executionEntries,
  ]
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

/**
 * The action subjects the viewer can read, through its own object reader: object type grants,
 * markings and existence alike. One batch per object type, as a type the viewer cannot see fails
 * its whole batch.
 */
async function readableObjects(
  runtime: SixbRuntimeContext,
  subjects: readonly ActionObjectSubject[]
): Promise<ReadonlySet<string>> {
  const byType = new Map<string, Map<string, ActionObjectSubject>>()
  for (const subject of subjects) {
    const items = byType.get(subject.objectTypeId) ?? new Map()
    items.set(subject.primaryId, subject)
    byType.set(subject.objectTypeId, items)
  }

  const readable = new Set<string>()
  await Promise.all(
    [...byType.values()].map(async (items) => {
      try {
        const rows = await runtime.objectReader.getByPrimaryIdBatch({ items: [...items.values()] })
        for (const key of rows.keys()) {
          readable.add(key)
        }
      } catch (error) {
        if (!(error instanceof AuthorizationError)) {
          throw error
        }
      }
    })
  )
  return readable
}
