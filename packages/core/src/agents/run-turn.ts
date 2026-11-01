import type { Principal, UserPrincipal } from "../auth/types"
import type {
  AgentContextCheckpointRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  SubagentRunRecord,
} from "../storage/agents"
import type { AiModelCallUsageRecord } from "../storage/ai-usage"
import type { ExecutionRecord } from "../storage/executions/types"
import { isPausedSubagentRun } from "./approvals"
import { userCanRunAgent } from "./authority"
import type { AgentRunSessionHost } from "./run-session"
import { listSubagentThreadRuns } from "./subagent-runs"
import { conversationThreadId } from "./thread-access"

// What a run reads to prepare, read in one go when it starts. Plain data: a runner in the worker
// gets it in process, and a runner over HTTP gets the same thing as one answer.

/** What a run starts from: a conversation turn's, or a child's. */
export type AgentRunContext = AgentTurnContext | AgentChildContext

export interface AgentTurnContext {
  readonly kind: "conversation"
  readonly thread: AgentThreadRecord | null
  readonly execution: ExecutionRecord | null
  /** Everyone added to the thread, even someone who cannot read it now. */
  readonly participants: readonly AgentThreadParticipantRecord[]
  /** The participants who can read the thread now: active users the project lets use the Agent. */
  readonly readers: readonly UserPrincipal[]
  /**
   * Display names of the people the turn names, by `type:id`: its requester, the thread's owner,
   * its readers and who wrote its retained messages. Someone without one is absent.
   */
  readonly names: Readonly<Record<string, string>>
  readonly history: AgentTurnHistory
}

/** A conversation's history as a turn reads it: the latest checkpoint and what follows it. */
export interface AgentTurnHistory {
  readonly checkpoint: AgentContextCheckpointRecord | null
  /** The messages after the checkpoint, oldest first. */
  readonly messages: readonly AgentMessageRecord[]
  /** The time zone of the run that answered each retained user message, by message id. */
  readonly sentTimeZones: Readonly<Record<string, string>>
  /**
   * The locale of the run that answered each retained user message, by message id. Absent from a
   * project that predates it.
   */
  readonly sentLocales?: Readonly<Record<string, string>>
  /**
   * The model call that ended the latest assistant message after the checkpoint: what a token
   * estimate anchors on, as the provider counted it. None when that message's run compacted the
   * thread and did not succeed.
   */
  readonly usageAnchor?: {
    readonly messageId: string
    readonly modelCall: AiModelCallUsageRecord
  }
}

export interface AgentChildContext {
  readonly kind: "subagent"
  /** The turn that spawned the child, as it is now. */
  readonly parent: AgentRunRecord | null
  readonly execution: ExecutionRecord | null
  /** The child's own thread. */
  readonly thread: AgentThreadRecord | null
  /** The thread of the conversation the child works for. */
  readonly conversation: AgentThreadRecord | null
  /** The child's thread as a run reads it: its latest checkpoint and what follows it. */
  readonly history: AgentTurnHistory
  /**
   * The message that started the thread, its task, when a checkpoint summarized it: a child's
   * requests keep it as it is, ahead of the summary.
   */
  readonly task?: AgentMessageRecord
  /** The run of the thread that paused on its held calls, when this run continues it. */
  readonly paused?: SubagentRunRecord
  /** The display name of whoever asked for the parent turn, by `type:id`, when they have one. */
  readonly names: Readonly<Record<string, string>>
}

/** Read what a run starts from. */
export async function readAgentRunContext(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<AgentRunContext> {
  const execution = await host.storage.executions.getById({
    projectId: host.projectId,
    id: run.executionId,
  })
  return run.kind === "conversation"
    ? readTurnContext(host, run, execution)
    : readChildContext(host, run, execution)
}

/** A conversation's history: its latest checkpoint and the messages after it. */
export async function readAgentTurnHistory(
  host: AgentRunSessionHost,
  threadId: string
): Promise<AgentTurnHistory> {
  const { projectId } = host
  const agents = host.storage.agents
  const checkpoint = await agents.checkpoints.getLatest({ projectId, threadId })
  const { messages } = await agents.messages.list({
    projectId,
    threadId,
    ...(checkpoint ? { afterSeq: checkpoint.summarizedThroughSeq } : {}),
    order: "asc",
  })
  const [sent, usageAnchor] = await Promise.all([
    readSentSettings(host, threadId, messages),
    readUsageAnchor(host, messages, checkpoint),
  ])
  return { checkpoint, messages, ...sent, ...(usageAnchor ? { usageAnchor } : {}) }
}

async function readTurnContext(
  host: AgentRunSessionHost,
  run: AgentRunRecord & { readonly kind: "conversation" },
  execution: ExecutionRecord | null
): Promise<AgentTurnContext> {
  const { projectId } = host
  const [thread, participants, history] = await Promise.all([
    host.storage.agents.threads.getById({ projectId, id: run.threadId }),
    host.storage.agents.threads.listParticipants({ projectId, threadIds: [run.threadId] }),
    readAgentTurnHistory(host, run.threadId),
  ])
  const readers = await readReaders(host, participants)
  const named: Principal[] = [
    ...(execution?.requestedBy?.type === "user" ? [execution.requestedBy] : []),
    ...(thread ? [thread.ownerPrincipal] : []),
    ...readers,
    ...history.messages.flatMap((message) =>
      message.role === "user" && message.authorPrincipal ? [message.authorPrincipal] : []
    ),
  ]
  return {
    kind: "conversation",
    thread,
    execution,
    participants,
    readers,
    names: await readNames(host, named),
    history,
  }
}

async function readChildContext(
  host: AgentRunSessionHost,
  run: SubagentRunRecord,
  execution: ExecutionRecord | null
): Promise<AgentChildContext> {
  const { projectId } = host
  const agents = host.storage.agents
  const [parent, thread, history, runs] = await Promise.all([
    agents.runs.getById({ projectId, id: run.parentRunId }),
    agents.threads.getById({ projectId, id: run.threadId }),
    readAgentTurnHistory(host, run.threadId),
    listSubagentThreadRuns(agents, { projectId, threadId: run.threadId }),
  ])
  const [conversation, task] = await Promise.all([
    thread ? agents.threads.getById({ projectId, id: conversationThreadId(thread) }) : null,
    history.checkpoint
      ? agents.messages
          .list({ projectId, threadId: run.threadId, order: "asc", limit: 1 })
          .then(({ messages }) => messages[0])
      : undefined,
  ])
  // A continuation goes on from the latest run that succeeded: only a child paused on its calls
  // succeeds without ending its thread.
  const previous = runs.filter((each) => each.status === "succeeded").at(-1)
  const paused = previous && isPausedSubagentRun(previous) ? previous : undefined
  return {
    kind: "subagent",
    parent,
    execution,
    thread,
    conversation,
    history,
    ...(task ? { task } : {}),
    ...(paused ? { paused } : {}),
    names: await readNames(host, execution?.requestedBy ? [execution.requestedBy] : []),
  }
}

/**
 * The participants who can read the thread now: active users the project's roles let use the
 * Agent. Someone added before losing access is not named to the model as taking part.
 */
async function readReaders(
  host: AgentRunSessionHost,
  participants: readonly AgentThreadParticipantRecord[]
): Promise<readonly UserPrincipal[]> {
  const readers = await Promise.all(
    participants.map(async ({ principal }) => {
      const user = await readUser(host, principal.id)
      if (user?.status !== "active") return null
      const allowed = await userCanRunAgent({
        auth: host.storage.auth,
        projectId: host.projectId,
        userId: principal.id,
        security: host.security,
      })
      return allowed ? principal : null
    })
  )
  return readers.filter((reader) => reader !== null)
}

async function readNames(
  host: AgentRunSessionHost,
  principals: readonly Principal[]
): Promise<Readonly<Record<string, string>>> {
  const users = [
    ...new Set(
      principals.flatMap((principal) => (principal.type === "user" ? [principal.id] : []))
    ),
  ]
  const names: Record<string, string> = {}
  await Promise.all(
    users.map(async (id) => {
      const name = (await readUser(host, id))?.displayName
      if (name) names[`user:${id}`] = name
    })
  )
  return names
}

function readUser(host: AgentRunSessionHost, id: string) {
  return host.storage.auth.users.getById({ projectId: host.projectId, id })
}

/**
 * The time zone and locale each retained user message was sent in: those of the run that answered
 * it, as its requester's settings froze them.
 */
async function readSentSettings(
  host: AgentRunSessionHost,
  threadId: string,
  messages: readonly AgentMessageRecord[]
): Promise<Pick<AgentTurnHistory, "sentTimeZones" | "sentLocales">> {
  const userMessages = messages.filter((message) => message.role === "user")
  const oldest = userMessages[0]
  if (!oldest) return { sentTimeZones: {}, sentLocales: {} }

  // A run starts after its trigger message, so this window holds every run that answered one.
  const { runs } = await host.storage.agents.runs.list({
    projectId: host.projectId,
    threadId,
    kinds: ["conversation"],
    startedAfter: new Date(oldest.createdAt.getTime() - 1),
  })
  const retained = new Set(userMessages.map((message) => message.id))
  const zones: Record<string, string> = {}
  const locales: Record<string, string> = {}
  for (const run of runs) {
    if (run.kind !== "conversation" || !retained.has(run.triggerMessageId)) continue

    if (run.spec?.timeZone) zones[run.triggerMessageId] = run.spec.timeZone
    if (run.spec?.locale) locales[run.triggerMessageId] = run.spec.locale
  }
  return { sentTimeZones: zones, sentLocales: locales }
}

async function readUsageAnchor(
  host: AgentRunSessionHost,
  messages: readonly AgentMessageRecord[],
  checkpoint: AgentContextCheckpointRecord | null
): Promise<AgentTurnHistory["usageAnchor"]> {
  const afterSeq = checkpoint?.observedHeadSeq ?? 0
  const anchor = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.seq > afterSeq && message.runId)
  if (!anchor?.runId) return undefined
  const run = await host.storage.agents.runs.getById({
    projectId: host.projectId,
    id: anchor.runId,
  })
  if (!run) return undefined

  // A run that compacted the thread and did not finish may have ended on its summary's call, which
  // read the history the summary replaced: it anchors nothing.
  if (run.id === checkpoint?.createdByRunId && run.status !== "succeeded") return undefined

  const modelCall = await host.storage.aiUsage.getLatestForExecution({
    projectId: host.projectId,
    executionId: run.executionId,
  })
  return modelCall ? { messageId: anchor.id, modelCall } : undefined
}
