import type { BlobStorage } from "../blob-storage"
import type { Broker } from "../broker"
import { createSixbError } from "../errors/internal"
import type { AuthorizationRef } from "../execution"
import {
  type AgentExecutionHost,
  bindAgentModelExecution,
  bindDurableAgentExecution,
} from "../execution/agent"
import type { RunLogSession } from "../logging/run-logger"
import { type LoggingService, resolveLoggingService } from "../logging/service"
import type { LogFields } from "../logging/types"
import type { LanguageModelRef } from "../models/catalog"
import {
  AiModelCallRecorder,
  createAiModelCallLimitController,
  type ModelCallAccountingStorage,
  type RecoverAiModelCall,
} from "../models/execution/index"
import type { LanguageModel } from "../models/language-model"
import { resolveLanguageModel } from "../models/resolve"
import type { Sixb } from "../runtime/sixb"
import type { SecurityDefinitionCatalog } from "../security"
import type { Storage } from "../storage"
import {
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadSandboxState,
  type AppendAgentMessageInput,
  type ConversationAgentRunRecord,
  type CreateAgentContextCheckpointInput,
  type FinishAgentRunInput,
  type SubagentRunFile,
  type SubagentRunRecord,
  type TransitionAgentThreadSandboxInput,
} from "../storage/agents"
import type { AuthStorage, UserRecord } from "../storage/auth"
import { turnPausesOnHeldCalls } from "./approvals"
import {
  type AgentExecutionAuthorization,
  resolveAgentPropertyClearance,
  resolveInheritedAgentExecutionAuthorization,
  userCanRunAgent,
} from "./authority"
import {
  type AgentModelTokenRateSample,
  readAgentContextTokenRates,
  recordAgentContextTokenRate,
} from "./context-token-rate"
import { AgentToolPublicError } from "./errors"
import { createAgentRunExecutionToken } from "./ids"
import { type AgentRunArtifacts, agentRunArtifacts } from "./run-artifacts"
import type { StreamSink } from "./run-events"
import {
  AgentExecutionLostError,
  AgentRunRefusedError,
  assertAgentRunOwned,
  fenced,
  isTerminalOrExecutionGone,
} from "./run-fence"
import {
  type AgentRunMemory,
  type AgentRunPlan,
  type AgentRunPlanDefinitions,
  readAgentRunMemory,
  readAgentRunPlan,
} from "./run-plan"
import {
  type AgentRunChildren,
  type AgentRunChildrenHost,
  type AgentRunThreads,
  agentRunChildren,
  agentRunScope,
  agentRunThreads,
} from "./run-session-children"
import {
  type AgentToolCall,
  type AgentToolCallOptions,
  type AgentToolCallResult,
  handedToolAttachments,
  runAgentTool,
  threadToolAttachments,
} from "./run-tools"
import {
  type AgentRunContext,
  type AgentTurnContext,
  type AgentTurnHistory,
  readAgentRunContext,
  readAgentTurnHistory,
} from "./run-turn"
import { subscribeAgentRunCancel } from "./streams/protocol"
import { subagentSandboxFiles } from "./subagent-runs"
import { conversationThreadId } from "./thread-access"
import type { AgentToolRunInfo } from "./types"

/**
 * A run's session: the one way its runner reads and writes shared state for it. Claiming the run
 * creates it, with a fresh execution token, and every write it makes is fenced by that token: once
 * another delivery reclaims the run, this session's writes fail with
 * {@link AgentExecutionLostError} and the runner stops touching the run.
 *
 * The worker uses an in-process session. A runner elsewhere will reach the same operations over
 * HTTP, so nothing here may assume it shares a process with storage.
 */
export interface AgentRunSession<TRun extends AgentRunRecord = AgentRunRecord> {
  /** The run as the claim left it: `running`, with this session's execution. */
  readonly run: TRun
  readonly executionToken: string
  /**
   * Aborts once the run, or any run named in `cancelWith`, is cancelled: when the broker's cancel
   * arrives, or at the claim or a lease renewal that reads a cancel recorded on the run. Also aborts,
   * with an {@link AgentExecutionLostError}, once a renewal finds the run ended or taken over.
   */
  readonly cancelled: AbortSignal
  /**
   * The models the run calls. Each call is admitted against the AI limits of whoever the run works
   * for, and records itself before its reader sees it finish (see
   * AiModelCallRecorder.wrapModel): the runner never reports what a call used.
   */
  readonly models: AgentRunModels
  /**
   * Live records for whoever watches the run: its start, chunks, compaction, finalized message and
   * end. Best effort: a record that cannot be delivered never fails the run, whose finish is the
   * durable record.
   */
  readonly events: StreamSink
  /** Approvals that hold the run: they are created by the API its commands call, never here. */
  readonly heldCalls: AgentRunHeldCalls
  /** A conversation turn's children: spawning them, and reading them and their threads. */
  readonly children: AgentRunChildren
  /**
   * Record that the runner still holds the run until `leaseExpiresAt`. A run token fails closed
   * once the last lease recorded lapses, so the session renews it as the queue does. A renewal that
   * reads a recorded cancel aborts `cancelled`.
   */
  renewLease(leaseExpiresAt: string): Promise<void>
  /**
   * End the run, with what it did appended first in the same transaction. Absorbs a transient
   * storage failure with a few short retries; see {@link AgentExecutionLostError} and
   * {@link AgentFinalizationError} for what it throws.
   */
  finish(
    outcome: AgentRunOutcome,
    messages?: readonly AppendAgentMessageInput[]
  ): Promise<AgentRunRecord>
  /**
   * Note what the run's latest model call measured of its model's tokenizer. The session keeps the
   * latest until `finish`, which records it after the run's end: the project's next runs on that
   * model start their context estimate from it.
   */
  noteTokenRate(sample: AgentModelTokenRateSample): void
  /**
   * Throws {@link AgentExecutionLostError} unless the run still runs under this session, within
   * its lease. Run it right before a side effect the run must not make once another delivery owns
   * it.
   */
  assertOwned(): Promise<void>
  /**
   * What the run is set up with: its model, the project's instructions, skills and tools, and the
   * ontology docs its requester's view gives.
   */
  plan(): Promise<AgentRunPlan>
  /**
   * The memory its requester reads, now and as of `asOf`: the start of the conversation, or its
   * latest compaction, which the prompt shows.
   */
  memory(input: { readonly asOf: Date }): Promise<AgentRunMemory>
  /**
   * What the run starts from, in one read: a turn's thread, the people it names and its history,
   * or a child's parent, threads and messages.
   */
  context(): Promise<TRun extends ConversationAgentRunRecord ? AgentTurnContext : AgentRunContext>
  /**
   * Summarize the conversation up to a point, and answer its history from the new checkpoint on.
   * Refused with {@link AgentExecutionLostError} once the run is no longer this session's.
   */
  checkpoint(input: AgentRunCheckpoint): Promise<AgentTurnHistory>
  /** A conversation's persistent workspace, as this run holds it. */
  readonly workspace: AgentRunWorkspace
  /** The messages of the run's conversation, its children's threads included. */
  readonly threads: AgentRunThreads
  /**
   * Run one call of a project tool the run offers, as the run (see runAgentTool): with the run's
   * SDK, its attachments and its logger, its model calls billed to the run. The files it puts are
   * stored and returned, for the runner to copy into its sandbox.
   */
  callTool(call: AgentToolCall, options: AgentToolCallOptions): Promise<AgentToolCallResult>
  /** Its conversation's artifacts: what it reads of them as its requester, and what it publishes. */
  readonly artifacts: AgentRunArtifacts
  /**
   * The files it stores and reads: its attachments, what its tools and children write, its
   * artifacts' files. Through the run's SDK, as an API request with the run's token stores them.
   */
  readonly files: AgentRunFileStore
  /**
   * The authority the run's execution carries now: its requester's groups, as they are today. A
   * runner that binds the project in its own process needs it; a runner over HTTP never holds it.
   */
  authorization(ref: AuthorizationRef): Promise<AgentExecutionAuthorization>
  /**
   * Stop watching for cancellation, stop its tools' model calls, and flush their logs. The run
   * itself is unaffected.
   */
  close(): Promise<void>
}

/** The models a run calls, by the ref its plan names. */
export interface AgentRunModels {
  /** A language model of the project, resolved once for the session. */
  language(ref: LanguageModelRef): Promise<LanguageModel>
}

/** Where a run's files are stored: put one, open or stat one by its blob id. */
export type AgentRunFileStore = Pick<BlobStorage, "put" | "open" | "stat">

/** A context checkpoint a turn writes; the session adds which run, and its token. */
export type AgentRunCheckpoint = Omit<
  CreateAgentContextCheckpointInput,
  "projectId" | "createdByRunId" | "executionToken"
>

/** The project's members as a workflow step needs them, and the authority its execution carries. */
export interface AgentRunPeople {
  /** A member: a message's author, or whoever the run works for. */
  user(userId: string): Promise<UserRecord | null>
  /** Whether a member may run the Agent now: a shared conversation's readers are those who may. */
  canRunAgent(userId: string): Promise<boolean>
  /** The authority a run's execution carries now: its requester's groups, as they are today. */
  authorization(ref: AuthorizationRef): Promise<AgentExecutionAuthorization>
}

/** A thread's persistent workspace state, moved only by the run that holds the thread. */
export interface AgentRunWorkspace {
  /** Acquire, replace or settle the thread's workspace; refused once the run lost its execution. */
  transition(input: AgentRunWorkspaceTransition): Promise<AgentThreadSandboxState>
}

/** A workspace transition a run makes; the session adds which run, and its token. */
export type AgentRunWorkspaceTransition = TransitionAgentThreadSandboxInput extends infer T
  ? T extends { readonly runId: string }
    ? Omit<T, "projectId" | "runId" | "executionToken">
    : never
  : never

export interface AgentRunHeldCalls {
  /** Whether a call of this run, or of one of its children, waits for an approval. */
  holdsRun(): Promise<boolean>
  /**
   * Whether a conversation turn pauses after the step it just took: a call of its own is held, or
   * a child's is and no child is still at work.
   */
  pausesAfterStep(): Promise<boolean>
}

/** How a run ended; the session supplies which run, and its token. */
export type AgentRunOutcome = FinishAgentRunInput extends infer Finish
  ? Finish extends FinishAgentRunInput
    ? Omit<Finish, "projectId" | "id" | "executionToken">
    : never
  : never

/** What an in-process session works against. */
export interface AgentRunSessionHost extends AgentRunChildrenHost {
  readonly projectId: string
  readonly storage: Storage & {
    readonly agents: AgentStorage
    readonly auth: AuthStorage
  } & ModelCallAccountingStorage
  readonly broker: Broker
  /** Queues a model call's record when storage cannot take it while the run goes on. */
  readonly recoverAiModelCall: RecoverAiModelCall
  /** Where live records go; the host keeps them best effort (see isolateStreamSink). */
  readonly events: StreamSink
  /** The project's security definitions, which decide a run's authority. */
  readonly security: SecurityDefinitionCatalog
  /** Where a project tool's logs go; the project's logging service when absent. */
  readonly logging?: LoggingService
  /**
   * Binds the run's SDK as its requester, as the API binds a request with the run's token: what
   * the run reads and publishes through its session goes through it.
   */
  readonly sdk: AgentExecutionHost
  /** The definitions a run's plan is read from. */
  readonly definitions: AgentRunPlanDefinitions
  /**
   * What follows a run's end, once `finish` recorded it: a turn's children still at work are
   * stopped, and a turn paused on calls already decided goes on. Best effort: a failure is logged,
   * and the host's repair passes catch up.
   */
  readonly afterFinish?: (run: AgentRunRecord) => Promise<void>
}

export interface ClaimAgentRunInput<TRun extends AgentRunRecord> {
  /** A queued run, or a running one whose last delivery's lease lapsed. */
  readonly run: TRun
  readonly modelId?: string
  /** When the queue delivery that claims the run expires unless renewed. */
  readonly leaseExpiresAt: string
  /** Other runs whose cancellation cancels this one: a child's parent. */
  readonly cancelWith?: readonly string[]
  /**
   * The runner's own stop: its process shutting down, or its delivery lost. The calls its project
   * tools make stop with it, as the run's own do.
   */
  readonly stop?: AbortSignal
}

/**
 * Start a queued run, or reclaim a running one, and open its session. Returns null when the run
 * ended meanwhile, so there is nothing to claim.
 */
export async function claimAgentRun<TRun extends AgentRunRecord>(
  host: AgentRunSessionHost,
  input: ClaimAgentRunInput<TRun>
): Promise<AgentRunSession<TRun> | null> {
  const run = await startOrReclaim(host.storage.agents, host.projectId, input)
  if (!run) return null
  return openAgentRunSession(host, run, input.cancelWith, input.stop)
}

/**
 * The session of a run already claimed: the one its execution token names. A server answering a
 * remote runner opens it per request; the worker opens it once, when it claims the run.
 */
export async function openAgentRunSession<TRun extends AgentRunRecord>(
  host: AgentRunSessionHost,
  run: TRun,
  cancelWith: readonly string[] = [],
  stop?: AbortSignal
): Promise<AgentRunSession<TRun>> {
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw new Error(`[Sixb] Agent run '${run.id}' has no execution token, so it was never claimed.`)
  }

  let tokenRate: AgentModelTokenRateSample | undefined
  let modelCalls: Promise<AiModelCallRecorder> | undefined
  const openedModelCalls = () => {
    modelCalls ??= openModelCalls(host, run).catch((error: unknown) => {
      modelCalls = undefined
      throw error
    })
    return modelCalls
  }
  // Each model is pinned once per session: a later catalog refresh does not change a run's model.
  const languageModels = new Map<string, Promise<LanguageModel>>()
  let bound: Promise<BoundRun> | undefined
  const bind = () => {
    bound ??= bindRun(host, run).catch((error: unknown) => {
      bound = undefined
      throw error
    })
    return bound
  }
  const runSdk = async () => (await bind()).sixb
  const cancel = await watchAgentRunCancel(host, [run.id, ...cancelWith])
  // A cancel recorded on the run reaches a runner the broker's cancel did not: at the claim, and at
  // each renewal of its lease.
  const recordedCancel = new AbortController()
  const readCancel = (current: AgentRunRecord) => {
    if (current.cancelRequestedAt) recordedCancel.abort()
  }
  readCancel(run)
  const cancelled = AbortSignal.any([cancel.signal, recordedCancel.signal])
  const scope = agentRunScope(host, run)
  const threads = agentRunThreads(host, run, scope)
  const files: AgentRunFileStore = {
    put: async (input) => (await runSdk()).blobs.put(input),
    open: async (blobId) => (await runSdk()).blobs.open(blobId),
    stat: async (blobId) => (await runSdk()).blobs.stat(blobId),
  }
  // Ends with the session: a tool call that outlived its run stops calling models.
  const ended = new AbortController()
  let toolsBound: Promise<Sixb> | undefined
  // A project tool's own model calls bill to the run, admitted and recorded with its own.
  const toolSdk = () => {
    toolsBound ??= (async () => {
      const sixb = await runSdk()
      bindAgentModelExecution(sixb, {
        signal: AbortSignal.any([cancelled, ended.signal, ...(stop ? [stop] : [])]),
        accounting: await openedModelCalls(),
      })
      return sixb
    })().catch((error: unknown) => {
      toolsBound = undefined
      throw error
    })
    return toolsBound
  }
  let logs: RunLogSession | undefined
  // Labeled with the conversation its run works in: a child's is its parent's.
  let toolLabels: Promise<LogFields> | undefined
  const toolLogger = async () => {
    toolLabels ??= (async (): Promise<LogFields> => {
      if (run.kind !== "subagent") return { threadId: run.threadId }
      const thread = await host.storage.agents.threads.getById({
        projectId: host.projectId,
        id: run.threadId,
      })
      return {
        parentRunId: run.parentRunId,
        threadId: thread ? conversationThreadId(thread) : run.threadId,
      }
    })().catch((error: unknown) => {
      toolLabels = undefined
      throw error
    })
    const labels = await toolLabels
    logs ??= resolveLoggingService(host.projectId, host.logging).startExecution({
      kind: "agent",
      id: run.id,
    })
    return logs.logger.child(labels)
  }
  const fence = { projectId: host.projectId, id: run.id, executionToken }
  const agents = host.storage.agents
  // What a child's sandbox holds: what it was handed, and what a paused run it continues left in
  // out/. Its tools open those, by the paths $SIXB_ATTACHMENTS lists.
  let handed: Promise<readonly SubagentRunFile[]> | undefined
  const childFiles = (child: SubagentRunRecord) => {
    handed ??= readAgentRunContext(host, child)
      .then((context) =>
        subagentSandboxFiles(child, context.kind === "subagent" ? context.paused : undefined)
      )
      .catch((error: unknown) => {
        handed = undefined
        throw error
      })
    return handed
  }

  return {
    run,
    executionToken,
    cancelled,
    events: host.events,
    children: agentRunChildren(host, run, executionToken, scope, () => ({
      tools: host.definitions.tools.list().map((tool) => tool.name),
      models: host.definitions.models?.language?.list() ?? [],
    })),
    heldCalls: {
      holdsRun: () =>
        host.storage.agents.approvals.holdsRun({ projectId: host.projectId, runId: run.id }),
      pausesAfterStep: () => turnPausesOnHeldCalls(host.storage.agents, run),
    },
    models: {
      async language(ref) {
        const key = `${ref.provider}/${ref.modelId}`
        let resolved = languageModels.get(key)
        if (!resolved) {
          const entry = host.definitions.models?.language?.getByRef(ref)
          if (!entry) {
            throw createSixbError(
              "agent.execution_failed",
              `[Sixb] Language model '${key}' is not available in models.language.`
            )
          }
          resolved = resolveLanguageModel(entry.model)
          languageModels.set(key, resolved)
          resolved.catch(() => languageModels.delete(key))
        }
        return (await openedModelCalls()).wrapModel(await resolved)
      },
    },
    async renewLease(leaseExpiresAt) {
      try {
        readCancel(
          await fenced(
            run.id,
            () =>
              host.storage.agents.runs.confirmExecutionOwnership({
                ...fence,
                queueLeaseExpiresAt: new Date(leaseExpiresAt),
              }),
            { ended: true }
          )
        )
        // A child stops with its parent: a cancel recorded on it too.
        if (cancelWith.length > 0) {
          const others = await agents.runs.getByIds({ projectId: host.projectId, ids: cancelWith })
          for (const other of others) readCancel(other)
        }
      } catch (error) {
        // A repair pass ended the run, or another runner took it over: this one stops now rather
        // than at its next write, as it does when its queue lease is lost.
        if (error instanceof AgentExecutionLostError) cancel.abort(error)
        throw error
      }
    },
    async finish(outcome, messages) {
      const finished = await finishWithRetries(
        host.storage,
        { ...outcome, ...fence },
        messages ?? []
      )
      await host.afterFinish?.(finished).catch((error: unknown) => {
        console.error(`[Sixb] What follows agent run '${run.id}' failed; repair retries it.`, error)
      })

      if (tokenRate) {
        await recordAgentContextTokenRate({
          tokenRates: agents.tokenRates,
          projectId: host.projectId,
          runId: run.id,
          sample: tokenRate,
          measuredAt: finished.completedAt ?? new Date(),
        })
      }
      return finished
    },
    noteTokenRate(sample) {
      tokenRate = sample
    },
    assertOwned: () => assertAgentRunOwned(agents, fence),
    threads,
    artifacts: agentRunArtifacts(host, run, executionToken, runSdk),
    files,
    async callTool(call, { signal, maxFileBytes, contextDirectory }) {
      // Only a tool the run offers: a child's are the ones its parent chose.
      const offered = run.kind === "subagent" ? run.spec.toolNames : undefined
      const definition =
        offered === undefined || offered.includes(call.toolName)
          ? host.definitions.tools.getByName(call.toolName)
          : null
      if (!definition) {
        throw new AgentToolPublicError(`[Sixb] Tool '${call.toolName}' is not available.`)
      }
      // A tool acts on the project: only for the runner that still holds the run.
      await assertAgentRunOwned(agents, fence)
      return runAgentTool({
        definition,
        valueTypesById: host.definitions.ontology.getValueTypesById(),
        call,
        signal,
        run: toolRunInfo(run),
        sixb: await toolSdk(),
        logger: await toolLogger(),
        attachments:
          run.kind === "subagent"
            ? handedToolAttachments({ files: await childFiles(run), store: files })
            : threadToolAttachments({
                threadId: run.threadId,
                message: (messageId) => threads.message(messageId),
                files,
              }),
        files,
        ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
        ...(contextDirectory === undefined ? {} : { contextDirectory }),
      })
    },
    authorization: (ref) =>
      resolveInheritedAgentExecutionAuthorization({
        auth: host.storage.auth,
        projectId: host.projectId,
        authorizationRef: ref,
        security: host.security,
      }),
    async plan() {
      const { sixb, authorization } = await bind()
      const propertyClearance = resolveAgentPropertyClearance(
        host.definitions.ontology,
        authorization
      )
      const plan = readAgentRunPlan(host.definitions, run, {
        sixb,
        ...(propertyClearance === undefined ? {} : { propertyClearance }),
      })

      const tokenRates = await readAgentContextTokenRates({
        tokenRates: agents.tokenRates,
        projectId: host.projectId,
        model: { providerId: plan.model.provider, modelId: plan.model.modelId },
      })
      return Object.freeze({ ...plan, tokenRates })
    },
    async memory({ asOf }) {
      // Others read a shared conversation, so its runs reach no one's own memory.
      const participants =
        run.kind === "conversation"
          ? await agents.threads.listParticipants({
              projectId: host.projectId,
              threadIds: [run.threadId],
            })
          : []
      return readAgentRunMemory(await runSdk(), { shared: participants.length > 0, asOf })
    },
    context: async () => {
      const context = await readAgentRunContext(host, run)
      if (run.kind === "conversation" && context.kind !== "conversation") {
        throw new Error(`[Sixb] Agent run '${run.id}' changed kind.`)
      }
      return context as Awaited<ReturnType<AgentRunSession<TRun>["context"]>>
    },
    async checkpoint(input) {
      await fenced(run.id, () =>
        agents.checkpoints.create({
          ...input,
          projectId: host.projectId,
          createdByRunId: run.id,
          executionToken,
        })
      )
      return readAgentTurnHistory(host, input.threadId)
    },
    workspace: {
      async transition(input) {
        // A run moves its own thread's workspace, never another's.
        if (input.id !== run.threadId) {
          throw new AgentRunRefusedError(
            `[Sixb] Agent run '${run.id}' moves only its own thread's workspace, not '${input.id}'.`
          )
        }
        return fenced(run.id, () =>
          host.storage.agents.threads.transitionSandbox({
            ...input,
            projectId: host.projectId,
            runId: run.id,
            executionToken,
          })
        )
      },
    },
    async close() {
      cancel.stop()
      ended.abort(new DOMException("The Agent run's session has closed.", "AbortError"))
      await logs?.flush().catch((error: unknown) => {
        console.error(`[Sixb] Agent run '${run.id}' could not flush its tools' logs.`, error)
      })
    },
  }
}

/** The run a project tool is told it runs in. */
function toolRunInfo(run: AgentRunRecord): AgentToolRunInfo {
  return run.kind === "subagent"
    ? { kind: "subagent", id: run.id, parentRunId: run.parentRunId }
    : { kind: "conversation", id: run.id, threadId: run.threadId }
}

interface BoundRun {
  readonly sixb: Sixb
  readonly authorization: AgentExecutionAuthorization
}

/** The run's SDK, bound to its execution with the authority its requester holds now. */
async function bindRun(host: AgentRunSessionHost, run: AgentRunRecord): Promise<BoundRun> {
  const execution = await host.storage.executions.getById({
    projectId: host.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }
  const authorization = await resolveInheritedAgentExecutionAuthorization({
    auth: host.storage.auth,
    projectId: host.projectId,
    authorizationRef: execution.authorizationRef,
    security: host.security,
  })
  return {
    sixb: bindDurableAgentExecution(host.sdk, { execution, runId: run.id, authorization }),
    authorization,
  }
}

async function openModelCalls(
  host: AgentRunSessionHost,
  run: AgentRunRecord
): Promise<AiModelCallRecorder> {
  const execution = await host.storage.executions.getById({
    projectId: host.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }
  return new AiModelCallRecorder({
    storage: host.storage,
    projectId: host.projectId,
    executionId: run.executionId,
    attempt: run.attempt,
    requesterGroupIds: execution.requesterGroupIds,
    limits: createAiModelCallLimitController({
      storage: host.storage,
      projectId: host.projectId,
      requestedBy: execution.requestedBy,
      requesterGroupIds: execution.requesterGroupIds,
    }),
    recoverAiModelCall: host.recoverAiModelCall,
  })
}

/** A project's members and a run's authority, as the in-process session reads them. */
export function agentRunPeople(
  host: Pick<AgentRunSessionHost, "projectId" | "security"> & {
    readonly storage: { readonly auth: AuthStorage }
  }
): AgentRunPeople {
  return {
    user: (userId) => host.storage.auth.users.getById({ projectId: host.projectId, id: userId }),
    canRunAgent: (userId) =>
      userCanRunAgent({
        auth: host.storage.auth,
        projectId: host.projectId,
        userId,
        security: host.security,
      }),
    authorization: (ref) =>
      resolveInheritedAgentExecutionAuthorization({
        auth: host.storage.auth,
        projectId: host.projectId,
        authorizationRef: ref,
        security: host.security,
      }),
  }
}

/**
 * Watch runs for a cancel, best effort: failing to attach a watch costs that run its
 * cancellability, never the run itself. `stop` unsubscribes.
 */
export async function watchAgentRunCancel(
  host: Pick<AgentRunSessionHost, "projectId" | "broker">,
  runIds: readonly string[]
): Promise<{
  readonly signal: AbortSignal
  abort(reason: unknown): void
  readonly stop: () => void
}> {
  const controller = new AbortController()
  const unsubscribes = await Promise.all(
    runIds.map((runId) =>
      subscribeAgentRunCancel(host.broker, { projectId: host.projectId, runId }, () =>
        controller.abort()
      ).catch((error: unknown) => {
        console.error(`[Sixb] Agent run '${runId}' cancel watch failed to start:`, error)
        return undefined
      })
    )
  )
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    stop: () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.()
    },
  }
}

/**
 * The run's end could not be recorded: storage stayed unavailable across the retries. The runner
 * leaves the delivery for another attempt rather than acknowledging a run that never ended.
 */
export class AgentFinalizationError extends Error {
  readonly name = "AgentFinalizationError"
  constructor(
    readonly runId: string,
    options?: ErrorOptions
  ) {
    super(`[Sixb] Could not finalize agent execution '${runId}'; storage is unavailable.`, options)
  }
}

async function startOrReclaim<TRun extends AgentRunRecord>(
  agents: AgentStorage,
  projectId: string,
  input: ClaimAgentRunInput<TRun>
): Promise<TRun | null> {
  const { run } = input
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(input.leaseExpiresAt),
  }
  if (run.status !== "queued" && run.status !== "running") return null
  // The read the caller made is already old: a run that ended since, or that another worker
  // started, is not this caller's.
  try {
    return run.status === "queued"
      ? sameKind(
          run,
          await agents.runs.start({ projectId, id: run.id, modelId: input.modelId, execution }),
          "starting"
        )
      : sameKind(
          run,
          await agents.runs.reclaim({ projectId, id: run.id, execution, ifLapsedBy: new Date() }),
          "reclaiming"
        )
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "invalid_state") return null
    throw error
  }
}

function sameKind<TRun extends AgentRunRecord>(
  run: TRun,
  claimed: AgentRunRecord,
  while_: string
): TRun {
  if (claimed.kind !== run.kind) {
    throw new Error(`[Sixb] Agent run '${run.id}' changed kind while ${while_}.`)
  }
  return claimed as TRun
}

/** Short in-place retries that absorb a transient storage blip without re-running the model. */
const FINISH_BACKOFF_MS = [50, 200, 600] as const

async function finishWithRetries(
  storage: AgentRunSessionHost["storage"],
  finish: FinishAgentRunInput,
  messages: readonly AppendAgentMessageInput[]
): Promise<AgentRunRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (messages.length === 0) return await storage.agents.runs.finish(finish)
      return await storage.transaction(async (tx) => {
        const agents = tx.agents
        if (!agents) throw new Error("[Sixb] Agent storage is not configured.")
        for (const message of messages) await agents.messages.append(message)
        return agents.runs.finish(finish)
      })
    } catch (error) {
      if (isTerminalOrExecutionGone(error)) throw new AgentExecutionLostError(finish.id)
      const delay = FINISH_BACKOFF_MS[attempt]
      if (delay === undefined) throw new AgentFinalizationError(finish.id, { cause: error })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
