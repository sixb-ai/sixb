import type { Broker } from "../broker"
import { ensureExecutionRecord } from "../execution/durable"
import type { Queue, SubagentQueueJob } from "../queues"
import type { Storage } from "../storage"
import {
  type AgentApprovalRecord,
  type AgentMessageRecord,
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type CreateSubagentRunInput,
  type ListAgentMessagesInput,
  type ListAgentMessagesResult,
  type ListThreadSubagentsInput,
  type SubagentRunRecord,
} from "../storage/agents"
import type { CreateExecutionInput } from "../storage/executions/types"
import {
  type AgentChildApprovalAwaiting,
  hasActiveChildren,
  listChildApprovalsAwaiting,
} from "./approvals"
import { dispatchQueuedSubagentRuns } from "./dispatch"
import {
  type AgentInbox,
  type AgentMail,
  publishAgentMail,
  type ReceivedAgentMail,
  readAgentMail,
  subscribeAgentInbox,
} from "./streams/protocol"
import { listSubagentThreadRuns } from "./subagent-runs"

/**
 * A conversation turn's children, as its session reaches them: the runs it spawned, and those of
 * earlier turns of its conversation, with their threads and the approvals that hold them. Every
 * write is fenced by the turn's execution token.
 */
export interface AgentRunChildren {
  get(runId: string): Promise<AgentRunRecord | null>
  getMany(runIds: readonly string[]): Promise<readonly AgentRunRecord[]>
  /** The children of this conversation's turns, by spawn key or by how they paused. */
  inConversation(
    input: Omit<ListThreadSubagentsInput, "projectId" | "threadId">
  ): Promise<readonly SubagentRunRecord[]>
  /** One child thread's runs, oldest first: a child and its continuations. */
  threadRuns(threadId: string): Promise<readonly SubagentRunRecord[]>
  message(messageId: string): Promise<AgentMessageRecord | null>
  messages(input: Omit<ListAgentMessagesInput, "projectId">): Promise<ListAgentMessagesResult>
  /** The approvals a run's calls asked for, its children's included. */
  approvals(runId: string): Promise<readonly AgentApprovalRecord[]>
  holdsRun(runId: string): Promise<boolean>
  /** This turn's children's calls that wait for an approval, by child. */
  awaitingApproval(
    childRunIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly AgentChildApprovalAwaiting[]>>
  /** How many of this turn's children are queued or running. */
  activeCount(): Promise<number>
  hasActive(): Promise<boolean>
  /**
   * Create a child run of this turn, with its execution, in one transaction that refuses once the
   * turn no longer owns its run.
   */
  spawn(input: {
    readonly execution: CreateExecutionInput
    readonly run: Omit<CreateSubagentRunInput, "projectId" | "parentRunId" | "parentExecutionToken">
  }): Promise<SubagentRunRecord>
  /** Queue a spawned child for a worker; a failure is retried by the worker's reconciliation. */
  dispatch(runId: string): Promise<{ readonly failed?: unknown }>
  /**
   * Remove what a run left in a child thread under an earlier attempt of this turn, which failed,
   * so the turn can continue the child again. Refused once the turn no longer owns its run.
   */
  clearAttempt(input: { readonly threadId: string; readonly runId: string }): Promise<void>
}

/** Mail between a turn and its children, through their inboxes. */
export interface AgentRunMail {
  send(mail: AgentMail): Promise<void>
  /** An inbox's mail after `afterCursor`, with the cursor to read on from. */
  read(
    inbox: AgentInbox,
    afterCursor?: string
  ): Promise<{ readonly mail: readonly ReceivedAgentMail[]; readonly cursor?: string }>
  /** Hear an inbox from its start; a turn's also hears its children finish. Returns the stop. */
  subscribe(
    inbox: AgentInbox,
    on: {
      readonly mail: (mail: readonly ReceivedAgentMail[]) => void
      readonly childFinished?: (runIds: readonly string[]) => void
    }
  ): Promise<() => void>
}

export interface AgentRunChildrenHost {
  readonly projectId: string
  readonly storage: Storage & { readonly agents: AgentStorage }
  readonly broker: Broker
  /** Where spawned children wait for a worker. */
  readonly childQueue?: Queue<SubagentQueueJob>
}

export function agentRunChildren(
  host: AgentRunChildrenHost,
  run: AgentRunRecord,
  executionToken: string
): AgentRunChildren {
  const { projectId } = host
  const agents = host.storage.agents

  /** The turn still owns its run: a reclaim, or its end, fences it out of its children's writes. */
  const assertOwned = async () => {
    const current = await agents.runs.getById({ projectId, id: run.id })
    if (current?.status !== "running" || current.execution?.token !== executionToken) {
      throw new AgentStorageError(
        "execution_lost",
        `[Sixb] Agent run '${run.id}' is no longer owned by this session.`
      )
    }
  }

  return {
    get: (runId) => agents.runs.getById({ projectId, id: runId }),
    getMany: (runIds) => agents.runs.getByIds({ projectId, ids: runIds }),
    inConversation: (input) =>
      agents.runs.listThreadSubagents({ ...input, projectId, threadId: run.threadId }),
    threadRuns: (threadId) => listSubagentThreadRuns(agents, { projectId, threadId }),
    message: (messageId) => agents.messages.getById({ projectId, id: messageId }),
    messages: (input) => agents.messages.list({ ...input, projectId }),
    async approvals(runId) {
      return (await agents.approvals.list({ projectId, runId })).approvals
    },
    holdsRun: (runId) => agents.approvals.holdsRun({ projectId, runId }),
    awaitingApproval: (childRunIds) =>
      listChildApprovalsAwaiting(agents, { projectId, parentRunId: run.id, childRunIds }),
    async activeCount() {
      const active = await agents.runs.list({
        projectId,
        kinds: ["subagent"],
        parentRunId: run.id,
        statuses: ["queued", "running"],
        limit: 1,
      })
      return active.total
    },
    hasActive: () => hasActiveChildren(agents, run),
    spawn: (input) =>
      host.storage.transaction(async (tx) => {
        if (!tx.agents) throw new Error("[Sixb] Agent storage disappeared during child admission.")
        await ensureExecutionRecord(tx.executions, input.execution)
        return tx.agents.runs.createSubagent({
          ...input.run,
          projectId,
          parentRunId: run.id,
          parentExecutionToken: executionToken,
        })
      }),
    async dispatch(runId) {
      if (!host.childQueue) return { failed: new Error("[Sixb] No queue takes child runs.") }
      const dispatched = await dispatchQueuedSubagentRuns({
        projectId,
        storage: agents,
        queue: host.childQueue,
        runIds: [runId],
      })
      const failure = dispatched.failures[0]
      return failure === undefined ? {} : { failed: failure.error }
    },
    async clearAttempt({ threadId, runId }) {
      await assertOwned()
      await agents.messages.deleteByRunId({ projectId, threadId, runId })
    },
  }
}

export function agentRunMail(
  host: Pick<AgentRunChildrenHost, "projectId" | "broker">
): AgentRunMail {
  const { projectId, broker } = host
  return {
    send: (mail) => publishAgentMail(broker, { projectId, mail }),
    read: (inbox, afterCursor) =>
      readAgentMail(broker, {
        projectId,
        inbox,
        ...(afterCursor === undefined ? {} : { afterCursor }),
      }),
    subscribe: (inbox, on) => subscribeAgentInbox(broker, { projectId, inbox }, on),
  }
}
