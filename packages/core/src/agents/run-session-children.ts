import { createInheritedAgentExecutionRecord } from "../execution/agent"
import { ensureExecutionRecord } from "../execution/durable"
import type { Storage } from "../storage"
import type {
  AgentApprovalRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentStorage,
  CreateSubagentRunInput,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListThreadSubagentsInput,
  SubagentRunRecord,
} from "../storage/agents"
import { type AgentChildApprovalAwaiting, listChildApprovalsAwaiting } from "./approvals"
import { createSubagentExecutionId, createSubagentRunId, createSubagentThreadId } from "./ids"
import { fenced } from "./run-fence"
import { listSubagentThreadRuns } from "./subagent-runs"
import { conversationThreadId } from "./thread-access"

/**
 * A conversation turn's children, as its session reaches them: the runs it spawned, and those of
 * earlier turns of its conversation, with their threads and the approvals that hold them. Every
 * read answers only for runs of the run's own conversation, and every write is fenced by the
 * turn's execution token.
 */
export interface AgentRunChildren {
  /** A run of this conversation: one of its turns, or a child of one; null for any other. */
  get(runId: string): Promise<AgentRunRecord | null>
  getMany(runIds: readonly string[]): Promise<readonly AgentRunRecord[]>
  /** The children of this conversation's turns, by spawn key or by how they paused. */
  inConversation(
    input: Omit<ListThreadSubagentsInput, "projectId" | "threadId">
  ): Promise<readonly SubagentRunRecord[]>
  /** One child thread's runs, oldest first: a child and its continuations. */
  threadRuns(threadId: string): Promise<readonly SubagentRunRecord[]>
  /** The approvals a run's calls asked for, its children's included. */
  approvals(runId: string): Promise<readonly AgentApprovalRecord[]>
  holdsRun(runId: string): Promise<boolean>
  /** This turn's children's calls that wait for an approval, by child. */
  awaitingApproval(
    childRunIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly AgentChildApprovalAwaiting[]>>
  /** How many of this turn's children are queued or running. */
  activeCount(): Promise<number>
  /**
   * Create a child run of this turn, with its execution, in one transaction that refuses once the
   * turn no longer owns its run. The session decides what the runner may not: the child's id and
   * thread from its key, its authority from the turn's, and how many children may be at work.
   */
  spawn(child: AgentChildDraft): Promise<SubagentRunRecord>
  /**
   * Remove what a run left in a child thread under an earlier attempt of this turn, which failed,
   * so the turn can continue the child again. Refused once the turn no longer owns its run.
   */
  clearAttempt(input: { readonly threadId: string; readonly runId: string }): Promise<void>
}

/**
 * A child as the turn asks for it: under its key, with its task, either in a thread of its own or
 * continuing one of the conversation's child threads.
 */
export type AgentChildDraft = Pick<CreateSubagentRunInput, "spawnKey" | "spec" | "trigger"> & {
  readonly thread: { readonly create: true } | { readonly id: string; readonly create: false }
  readonly createdAt?: Date
}

/** How many children one turn may have queued or running at once, unless its host says. */
export const DEFAULT_MAX_ACTIVE_CHILDREN = 4

/** The messages of the run's conversation: its threads, and its children's. */
export interface AgentRunThreads {
  /** A message of the conversation; null for one anywhere else. */
  message(messageId: string): Promise<AgentMessageRecord | null>
  /** A thread of the conversation's messages; any other thread is refused. */
  messages(input: Omit<ListAgentMessagesInput, "projectId">): Promise<ListAgentMessagesResult>
}

/**
 * Which threads a run may read: its conversation's own, and the threads of its children. A runner
 * over HTTP can name any id, so the session answers for these alone. A thread's place never
 * changes, so each is looked up once.
 */
export interface AgentRunScope {
  includes(threadId: string): Promise<boolean>
}

export function agentRunScope(host: AgentRunChildrenHost, run: AgentRunRecord): AgentRunScope {
  const conversations = new Map<string, Promise<string | null>>()
  const conversationOf = (threadId: string) => {
    let conversation = conversations.get(threadId)
    if (!conversation) {
      conversation = host.storage.agents.threads
        .getById({ projectId: host.projectId, id: threadId })
        .then((thread) => (thread ? conversationThreadId(thread) : null))
      // A failed read is read again next time.
      conversation.catch(() => conversations.delete(threadId))
      conversations.set(threadId, conversation)
    }
    return conversation
  }
  return {
    async includes(threadId) {
      const [own, theirs] = await Promise.all([
        conversationOf(run.threadId),
        conversationOf(threadId),
      ])
      return own !== null && own === theirs
    },
  }
}

export function agentRunThreads(
  host: AgentRunChildrenHost,
  run: AgentRunRecord,
  scope: AgentRunScope
): AgentRunThreads {
  const { projectId } = host
  const agents = host.storage.agents
  return {
    async message(messageId) {
      const message = await agents.messages.getById({ projectId, id: messageId })
      return message && (await scope.includes(message.threadId)) ? message : null
    },
    async messages(input) {
      if (!(await scope.includes(input.threadId))) {
        throw new Error(
          `[Sixb] Agent run '${run.id}' reads only its conversation's threads, not '${input.threadId}'.`
        )
      }
      return agents.messages.list({ ...input, projectId })
    },
  }
}

export interface AgentRunChildrenHost {
  readonly projectId: string
  readonly storage: Storage & { readonly agents: AgentStorage }
  /** How many children one turn may have queued or running at once. */
  readonly maxActiveChildren?: number
}

/** What a turn may hand its children: the project's tools, and the models it delegates to. */
export interface AgentRunDelegable {
  readonly tools: readonly string[]
  readonly models: readonly { readonly provider: string; readonly modelId: string }[]
}

export function agentRunChildren(
  host: AgentRunChildrenHost,
  run: AgentRunRecord,
  executionToken: string,
  scope: AgentRunScope,
  delegable: () => AgentRunDelegable
): AgentRunChildren {
  const { projectId } = host
  const agents = host.storage.agents
  const get = async (runId: string) => {
    const found = await agents.runs.getById({ projectId, id: runId })
    return found && (await scope.includes(found.threadId)) ? found : null
  }

  return {
    get,
    async getMany(runIds) {
      const found = await agents.runs.getByIds({ projectId, ids: runIds })
      const included = await Promise.all(found.map((each) => scope.includes(each.threadId)))
      return found.filter((_, index) => included[index])
    },
    inConversation: (input) =>
      agents.runs.listThreadSubagents({ ...input, projectId, threadId: run.threadId }),
    async threadRuns(threadId) {
      if (!(await scope.includes(threadId))) return []
      return listSubagentThreadRuns(agents, { projectId, threadId })
    },
    async approvals(runId) {
      if (!(await get(runId))) return []
      return (await agents.approvals.list({ projectId, runId })).approvals
    },
    async holdsRun(runId) {
      return (await get(runId)) !== null && agents.approvals.holdsRun({ projectId, runId })
    },
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
    async spawn(child) {
      assertDelegable(run, child, delegable())
      const id = createSubagentRunId(run.id, child.spawnKey)
      const executionId = createSubagentExecutionId(id)
      const [parentExecution, maxActiveChildren] = await Promise.all([
        host.storage.executions.getById({ projectId, id: run.executionId }),
        childLimit(host, run, child),
      ])
      if (!parentExecution) {
        throw new Error(`[Sixb] Agent run '${run.id}' has no execution to hand its children.`)
      }
      const execution = createInheritedAgentExecutionRecord({
        id: executionId,
        parent: parentExecution,
        runId: id,
      })
      return fenced(run.id, () =>
        host.storage.transaction(async (tx) => {
          if (!tx.agents)
            throw new Error("[Sixb] Agent storage disappeared during child admission.")
          await ensureExecutionRecord(tx.executions, execution)
          return tx.agents.runs.createSubagent({
            id,
            projectId,
            executionId,
            parentRunId: run.id,
            parentExecutionToken: executionToken,
            spawnKey: child.spawnKey,
            spec: child.spec,
            thread: child.thread.create
              ? { id: createSubagentThreadId(run.id, child.spawnKey), create: true }
              : child.thread,
            trigger: child.trigger,
            maxActiveChildren,
            ...(child.createdAt === undefined ? {} : { createdAt: child.createdAt }),
          })
        })
      )
    },
    async clearAttempt({ threadId, runId }) {
      // Only an attempt that ended, of a child of this conversation, in that child's thread.
      const attempt = await get(runId)
      if (
        attempt?.kind !== "subagent" ||
        attempt.threadId !== threadId ||
        attempt.status === "queued" ||
        attempt.status === "running"
      ) {
        throw new Error(
          `[Sixb] Agent run '${run.id}' clears only an ended attempt of its conversation's children, not '${runId}'.`
        )
      }
      await fenced(run.id, () =>
        agents.messages.deleteByRunId({
          projectId,
          threadId,
          runId,
          fence: { runId: run.id, executionToken },
        })
      )
    },
  }
}

function assertDelegable(
  run: AgentRunRecord,
  child: AgentChildDraft,
  delegable: AgentRunDelegable
): void {
  const { model, toolNames } = child.spec
  const unknownTool = toolNames.find((name) => !delegable.tools.includes(name))
  if (unknownTool !== undefined) {
    throw new Error(`[Sixb] Agent run '${run.id}' cannot hand a child tool '${unknownTool}'.`)
  }
  if (
    !delegable.models.some(
      (each) => each.provider === model.provider && each.modelId === model.modelId
    )
  ) {
    throw new Error(
      `[Sixb] Agent run '${run.id}' cannot delegate to model '${model.provider}/${model.modelId}'.`
    )
  }
}

/**
 * A turn keeps at most the host's limit of children at work. One that resumes children paused on
 * calls its trigger decided starts with all of them at once: each was admitted within the limit.
 */
async function childLimit(
  host: AgentRunChildrenHost,
  run: AgentRunRecord,
  child: AgentChildDraft
): Promise<number> {
  const limit = host.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN
  if (child.thread.create) return limit
  const trigger = await host.storage.agents.messages.getById({
    projectId: host.projectId,
    id: run.triggerMessageId,
  })
  const continuing = new Set(
    (trigger?.parts ?? []).flatMap((part) =>
      part.type === "approval-outcome" && part.caller?.continues ? [part.caller.runId] : []
    )
  )
  return Math.max(limit, continuing.size)
}
