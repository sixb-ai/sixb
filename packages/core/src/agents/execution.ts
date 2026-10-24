import { principalsEqual, type UserPrincipal } from "../auth"
import { AuthorizationError, assertAuthorized, isRuntimeAllowed } from "../authorization"
import { isSixbError } from "../errors/internal"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
import { canInheritAgentRequestAuthorization } from "../execution/agent"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { DecisionModelsRuntime, ModelCatalog } from "../models"
import { resolveExecutionCosts } from "../runtime/ai-cost"
import { resolveExecutionUsage } from "../runtime/ai-usage"
import type { SixbDependencies } from "../runtime/sixb"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SecurityDefinitionCatalog } from "../security"
import type {
  AgentApprovalMode,
  AgentApprovalRecord,
  AgentStorage,
  ConversationAgentRunRecord,
  ListAgentApprovalsInput,
  ListAgentApprovalsResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
} from "../storage/agents"
import type { AiCostSummary } from "../storage/ai-cost"
import type { AiModelCallUsage } from "../storage/ai-usage"
import { type AgentApprovalResume, registerAgentTurnResume } from "./approval-continuation"
import { getAgentApprovalExecutor } from "./approval-executor"
import {
  agentRunApprovalMode,
  approvalModeAllows,
  assertAgentApprovalMode,
  decideAgentApproval,
  defaultAgentApprovalMode,
  isAwaitingApprovalRun,
  leastApprovalModeAllowing,
  listTurnApprovals,
  type ResolvedAgentApprovalMode,
  resolveAgentApprovalMode,
  resumedApprovalMode,
  stopAgentTurn,
} from "./approvals"
import { cancelAgentRun } from "./cancel"
import { AgentRequestError } from "./errors"
import { forkAgentThread } from "./fork"
import { createAgentThreadId, createAgentThreadSandboxName } from "./ids"
import { type AgentMemoryRuntime, createAgentMemoryRuntime } from "./memory-execution"
import { createTurnModelRouter } from "./model-routing"
import {
  type AgentThreadParticipantInput,
  addAgentThreadParticipants,
  removeAgentThreadParticipant,
} from "./participants"
import {
  type RequestAgentRunInput,
  type RequestAgentRunResult,
  requestAgentRun,
  resumeAgentTurn,
  retryAgentRun,
} from "./request"
import { assertNoAgentSelector } from "./retired-config"
import { normalizeSandboxBinding } from "./sandbox"
import {
  type AgentThreadView,
  agentThreadViews,
  createAgentThreadAccessRule,
} from "./thread-access"
import type { AgentDescriptor } from "./types"

export type ExecutionAgentRequestInput = Omit<RequestAgentRunInput, "principal">

export type ListExecutionAgentThreadsInput = Omit<
  ListAgentThreadsInput,
  "projectId" | "ownerPrincipal" | "participantPrincipal"
> & {
  /** The threads other users added the caller to, instead of the caller's own. */
  readonly sharedWithMe?: boolean
}

export interface ListAgentThreadViewsResult extends Omit<ListAgentThreadsResult, "threads"> {
  readonly threads: readonly AgentThreadView[]
}

export type CreateExecutionAgentThreadInput<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly id?: string
  readonly title?: string
  readonly sandbox?: TParams
}

export type AgentThreadsRuntime<TParams extends Record<string, unknown> = Record<string, unknown>> =
  {
    /** Start fresh after uncertain recovery; never deletes the previous sandbox. Owner only. */
    recreateSandbox(
      threadId: string,
      input: { readonly expectedSandboxName: string }
    ): Promise<AgentThreadView>
    create(input: CreateExecutionAgentThreadInput<TParams>): Promise<AgentThreadView>
    /**
     * Copy a thread of the caller's, or one shared with them, into a new one the caller owns alone,
     * with a new sandbox. A turn still running is not copied.
     */
    fork(threadId: string): Promise<AgentThreadView>
    /** A thread the caller owns or takes part in. */
    getById(threadId: string): Promise<AgentThreadView | null>
    /** The caller's own threads, or with `sharedWithMe` the ones other users added it to. */
    list(input?: ListExecutionAgentThreadsInput): Promise<ListAgentThreadViewsResult>
    /** Who else reads the conversation and talks in it. */
    readonly participants: AgentThreadParticipantsRuntime
    /**
     * The caller's mode in a thread they read, and where it comes from: their choice there, else
     * their default, else the fallback.
     */
    getApprovalMode(threadId: string): Promise<ResolvedAgentApprovalMode | null>
    /**
     * Choose the caller's own mode for their next turns in a thread; `null` follows their default
     * again. Others keep theirs.
     */
    setApprovalMode(
      threadId: string,
      mode: AgentApprovalMode | null
    ): Promise<ResolvedAgentApprovalMode>
  }

/**
 * The calls the Agent held for approval. Whoever reads a thread reads its approvals; only whoever
 * asked for the turn decides, since the call runs with their rights.
 */
export interface AgentApprovalsRuntime {
  /**
   * A thread's approvals, oldest first; without `threadId`, the caller's own in the threads they
   * can open.
   */
  list(input?: ListExecutionAgentApprovalsInput): Promise<ListAgentApprovalsResult>
  getById(approvalId: string): Promise<AgentApprovalRecord | null>
  /**
   * Approve or deny a pending call. An approved call runs now, and the approval comes back with its
   * outcome. Once every call the turn held is decided, the turn resumes: `run` is the turn that
   * continues it, and the model reads how each call ended. `always` also sets the caller's mode in
   * the thread to the least that runs such a call without asking, and approves the turn's other
   * calls that mode runs.
   */
  decide(
    approvalId: string,
    input: DecideExecutionAgentApprovalInput
  ): Promise<AgentApprovalDecision>
}

export interface AgentApprovalDecision {
  readonly approval: AgentApprovalRecord
  /** The turn that resumed the paused one, when this decision was its last. */
  readonly run?: AgentRunView
  /**
   * Present when the paused turn could not resume: the decision and the call's outcome stand.
   * `retrying`: Sixb resumes it once it can, for example when an AI limit resets; otherwise the
   * thread's next message tells the model how its calls ended.
   */
  readonly resume?: {
    readonly status: "refused"
    readonly code: string
    readonly message: string
    readonly retrying: boolean
  }
}

export type ListExecutionAgentApprovalsInput = Omit<
  ListAgentApprovalsInput,
  "projectId" | "requestedBy" | "reported"
>

export interface DecideExecutionAgentApprovalInput {
  readonly decision: "approve" | "deny"
  readonly always?: boolean
}

/** The caller's own Agent settings. */
export interface AgentPreferences {
  /** The mode of the caller's turns in threads where they chose none. */
  readonly approvalMode: AgentApprovalMode
  /** `fallback` until the caller chooses a default. */
  readonly approvalModeSource: "default" | "fallback"
}

export interface AgentPreferencesRuntime {
  get(): Promise<AgentPreferences>
  update(input: { readonly approvalMode?: AgentApprovalMode }): Promise<AgentPreferences>
}

/**
 * Participants read the whole conversation, its files and its live stream, and send messages that
 * run with their own rights. Nothing checks what they may see: the conversation holds what the
 * Agent read with the rights of whoever asked.
 */
export interface AgentThreadParticipantsRuntime {
  /**
   * Add active users of the project, by id or by email; only the thread's owner can. Someone
   * already taking part keeps when and by whom they were added. Returns the thread with every
   * participant.
   */
  add(threadId: string, users: readonly AgentThreadParticipantInput[]): Promise<AgentThreadView>
  /**
   * The owner removes anyone; a participant removes only themself, to leave. Removing someone who
   * does not take part changes nothing.
   */
  remove(threadId: string, user: UserPrincipal): Promise<void>
}

/**
 * Any user's conversation, read-only, for a caller with `can.observe(agent.threads)`. Nothing here
 * checks who owns or takes part in a thread, and nothing writes: those stay on `threads` and `runs`.
 */
export interface ObservedAgentThreadsRuntime {
  /** Throws an `AuthorizationError` without `can.observe(agent.threads)`. */
  getById(threadId: string): Promise<AgentThreadView | null>
  /** The thread's conversation runs; `null` when the thread does not exist. */
  listRuns(
    threadId: string,
    input?: Omit<ListAgentRunsInput, "projectId" | "threadId">
  ): Promise<AgentRunListResult | null>
}

export interface AgentRunsRuntime {
  request(input: ExecutionAgentRequestInput): Promise<ExecutionAgentRunResult>
  /** Retry a failed or interrupted turn; only whoever asked for it can, as it runs with their rights. */
  retry(runId: string): Promise<ExecutionAgentRunResult>
  /**
   * Stop a turn; whoever asked for it, or the thread's owner, can. A queued turn is cancelled when
   * this returns; a running one is still running, with the stop signal sent to its worker. A turn
   * paused for approval stays as it ended, with its held calls cancelled: it never resumes.
   */
  cancel(runId: string): Promise<AgentRunView>
  getById(runId: string): Promise<AgentRunView | null>
  listForThread(
    threadId: string,
    input?: Omit<ListAgentRunsInput, "projectId" | "threadId">
  ): Promise<AgentRunListResult | null>
}

/** Execution-facing run view with provenance resolved from the immutable execution ledger. */
export interface AgentRunView extends ConversationAgentRunRecord {
  readonly requestedBy?: AuthorizablePrincipal
  /** Derived from the model-call ledger; never persisted on the Agent run row. */
  readonly usage?: AiModelCallUsage
  /** Preferred valuation; omitted when there are no calls or cost storage is unavailable. */
  readonly cost?: AiCostSummary
}

export interface AgentRunListResult extends Omit<ListAgentRunsResult, "runs"> {
  readonly runs: readonly AgentRunView[]
}

export interface ExecutionAgentRunResult extends Omit<RequestAgentRunResult, "run"> {
  readonly run: AgentRunView
}

export type AgentRuntime<TParams extends Record<string, unknown> = Record<string, unknown>> = {
  /** Null when no language models are configured or the caller cannot run the Agent. */
  get(): AgentDescriptor | null
  readonly threads: AgentThreadsRuntime<TParams>
  readonly runs: AgentRunsRuntime
  /** Other users' conversations, read-only, with `can.observe(agent.threads)`. */
  readonly observed: ObservedAgentThreadsRuntime
  readonly memory: AgentMemoryRuntime
  readonly approvals: AgentApprovalsRuntime
  readonly preferences: AgentPreferencesRuntime
}

export function createAgentRuntime<
  TParams extends Record<string, unknown> = Record<string, unknown>,
>(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: ModelCatalog | undefined,
  decision: DecisionModelsRuntime,
  sandbox: SixbDependencies["sandbox"] | undefined,
  security: SecurityDefinitionCatalog
): AgentRuntime<TParams> {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const turnModels = {
    language: models?.language,
    router: createTurnModelRouter(models, decision),
  }
  const rule = createAgentThreadAccessRule(runtime, authority)
  const principal = rule.caller
  const allowed = () => isRuntimeAllowed(runtime, { kind: "agent.run" })

  const getVisibleThreadRecord = async (threadId: string): Promise<AgentThreadView | null> =>
    (await rule.read(threadId))?.thread ?? null

  const getAgent = (): AgentDescriptor | null => {
    if (authority.type === "denied" || authority.type === "delegated") return null
    const model = models?.language?.default
    if (!model || !allowed()) return null
    return {
      name: "Sixb",
      model: { provider: model.provider, modelId: model.modelId },
    }
  }

  const getVisibleRunRecord = async (runId: string): Promise<ConversationAgentRunRecord | null> => {
    if (authority.type === "denied" || authority.type === "delegated") return null
    const run =
      (await runtime.storage.agents?.runs.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    if (!run || run.kind !== "conversation") return null
    const thread = await getVisibleThreadRecord(run.threadId)
    return thread ? run : null
  }

  const getRun = async (runId: string): Promise<AgentRunView | null> => {
    const run = await getVisibleRunRecord(runId)
    return run ? attachRunView(runtime, run) : null
  }

  /**
   * A turn the caller may stop or retry. Whoever asked for it may do both; the thread's owner may
   * also stop any turn, but retrying one would run it again with the owner's rights on someone
   * else's words. Code without a caller acts on every turn.
   */
  const getControllableRun = async (
    runId: string,
    action: "cancel" | "retry"
  ): Promise<ConversationAgentRunRecord> => {
    const run = await runtime.storage.agents?.runs.getById({
      projectId: runtime.projectId,
      id: runId,
    })
    const readable = run?.kind === "conversation" ? await rule.read(run.threadId) : null
    if (run?.kind !== "conversation" || !readable) {
      throw new AgentRequestError("run_not_found", `[Sixb] Agent run '${runId}' was not found.`)
    }

    if (authority.type !== "principal") return run
    if (action === "cancel" && readable.access === "owner") return run

    const execution = await runtime.storage.executions.getById({
      projectId: runtime.projectId,
      id: run.executionId,
    })
    if (execution?.requestedBy && principalsEqual(execution.requestedBy, principal)) return run

    throw new AgentRequestError(
      "not_run_requester",
      action === "cancel"
        ? `[Sixb] Only whoever asked for Agent run '${runId}', or the thread's owner, can stop it.`
        : `[Sixb] Only whoever asked for Agent run '${runId}' can retry it: it runs again with their rights.`
    )
  }

  const requireAgents = (): AgentStorage => {
    const storage = runtime.storage.agents
    if (!storage) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    return storage
  }

  /** Settings belong to whoever calls: a shared link or a delegated execution has none. */
  const settingsPrincipal = () => {
    if (authority.type === "denied" || authority.type === "delegated") {
      throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
    }
    return principal
  }

  const getVisibleApproval = async (approvalId: string): Promise<AgentApprovalRecord | null> => {
    if (authority.type === "denied" || authority.type === "delegated") return null
    const approval = await runtime.storage.agents?.approvals.getById({
      projectId: runtime.projectId,
      id: approvalId,
    })
    return approval && (await rule.read(approval.threadId)) ? approval : null
  }

  const getThreadApprovalMode = async (
    threadId: string
  ): Promise<ResolvedAgentApprovalMode | null> => {
    if (!(await getVisibleThreadRecord(threadId))) return null
    return resolveAgentApprovalMode(requireAgents(), {
      projectId: runtime.projectId,
      principal: settingsPrincipal(),
      threadId,
    })
  }

  const setThreadApprovalMode = async (
    threadId: string,
    mode: AgentApprovalMode | null
  ): Promise<ResolvedAgentApprovalMode> => {
    if (mode !== null) assertAgentApprovalMode(mode)
    if (!(await getVisibleThreadRecord(threadId))) {
      throw new AgentRequestError(
        "thread_not_found",
        `[Sixb] Agent thread '${threadId}' not found.`
      )
    }
    const agents = requireAgents()
    const scope = { projectId: runtime.projectId, principal: settingsPrincipal() }
    await agents.approvalModes.setForThread({ ...scope, threadId, mode })
    return resolveAgentApprovalMode(agents, { ...scope, threadId })
  }

  /** The caller's own approvals, in the threads they can still open. */
  const listOwnApprovals = async (
    storage: AgentStorage,
    { limit, offset = 0, ...input }: ListExecutionAgentApprovalsInput
  ): Promise<ListAgentApprovalsResult> => {
    const { approvals } = await storage.approvals.list({
      ...input,
      projectId: runtime.projectId,
      requestedBy: principal,
    })
    const readable = new Map<string, Promise<boolean>>()
    const canRead = (threadId: string) => {
      const known = readable.get(threadId)
      if (known) return known
      const read = rule.read(threadId).then((thread) => thread !== null)
      readable.set(threadId, read)
      return read
    }

    const visible: AgentApprovalRecord[] = []
    for (const approval of approvals) {
      if (await canRead(approval.threadId)) visible.push(approval)
    }
    const end = limit === undefined ? visible.length : offset + limit
    return {
      approvals: visible.slice(offset, end),
      hasMore: end < visible.length,
      total: visible.length,
    }
  }

  const approvals: AgentApprovalsRuntime = {
    list: async (input = {}) => {
      const none = { approvals: [], hasMore: false, total: 0 }
      if (authority.type === "denied" || authority.type === "delegated") return none
      const storage = runtime.storage.agents
      if (!storage) return none

      if (input.threadId === undefined) return listOwnApprovals(storage, input)
      if (!(await getVisibleThreadRecord(input.threadId))) return none
      return storage.approvals.list({ ...input, projectId: runtime.projectId })
    },
    getById: getVisibleApproval,
    decide: async (approvalId, input) => {
      const approval = await getVisibleApproval(approvalId)
      if (!approval) {
        throw new AgentRequestError(
          "approval_not_found",
          `[Sixb] Agent approval '${approvalId}' was not found.`
        )
      }

      // The call runs with the deciding request's authority: it must be one a turn can inherit.
      if (!canInheritAgentRequestAuthorization(runtime.runtimeAuthorization)) {
        throw new AgentRequestError(
          "authority_not_inheritable",
          "[Sixb] Deciding on an Agent call requires an authenticated user request or disabled authorization."
        )
      }

      // "Always allow" raises the thread's mode first: nothing has run yet if that fails.
      const always = input.always === true && input.decision === "approve"
      const raisedMode = always ? leastApprovalModeAllowing(approval.call) : undefined
      if (raisedMode !== undefined && approval.status === "pending") {
        await allowInThread(approval, raisedMode)
      }

      const decided = await decide(
        approval,
        input.decision === "approve" ? "approved" : "denied",
        raisedMode
      )
      if (raisedMode !== undefined && decided.status === "approved") {
        await approveAllowed(decided, raisedMode)
      }

      // The decision and the call's outcome stand from here: a resume that fails is reported.
      const resume = await resumeDecidedTurn(decided.runId)
      if (resume.status === "refused") return { approval: decided, resume }
      if (resume.status !== "resumed") return { approval: decided }

      // The resume reported it to the model.
      const reported = await requireAgents().approvals.getById({
        projectId: runtime.projectId,
        id: decided.id,
      })
      return { approval: reported ?? decided, run: await attachRunView(runtime, resume.run) }
    },
  }

  const decide = (
    approval: AgentApprovalRecord,
    decision: "approved" | "denied",
    raisedMode?: AgentApprovalMode
  ) =>
    decideAgentApproval(requireAgents(), getAgentApprovalExecutor(runtime), {
      approval,
      decision,
      decidedBy: principal,
      decider: { execution, authorization: runtime.runtimeAuthorization },
      ...(raisedMode === undefined ? {} : { raisedMode }),
      broker: runtime.broker,
    })

  /**
   * "Always allow": the caller's thread mode rises to the least that runs such a call, unless what
   * they chose already runs it. The fallback is no choice: it would hide the raise.
   */
  const allowInThread = async (
    approval: AgentApprovalRecord,
    raised: AgentApprovalMode
  ): Promise<void> => {
    const current = await getThreadApprovalMode(approval.threadId)
    const chosen = current?.approvalModeSource === "fallback" ? undefined : current?.approvalMode
    if (chosen === undefined || !approvalModeAllows(chosen, approval.call)) {
      await setThreadApprovalMode(approval.threadId, raised)
    }
  }

  /** "Always allow" also approves the turn's other calls the raised mode runs. */
  const approveAllowed = async (
    approval: AgentApprovalRecord,
    raised: AgentApprovalMode
  ): Promise<void> => {
    const { approvals: waiting } = await requireAgents().approvals.list({
      projectId: runtime.projectId,
      runId: approval.runId,
      requestedBy: principal,
      statuses: ["pending"],
    })
    for (const other of waiting) {
      if (!approvalModeAllows(raised, other.call)) continue
      try {
        await decide(other, "approved", raised)
      } catch (error) {
        // Decided, set aside or expired meanwhile: that outcome stands.
        if (!(error instanceof AgentRequestError)) throw error
      }
    }
  }

  /**
   * Resume a paused turn once its requester decided on every call it held, as that requester. It
   * never throws: what keeps the turn from resuming comes back as `refused`, and unless Sixb can
   * try again, the turn is stopped so that the thread's next message reports its calls.
   */
  const resumeDecidedTurn = async (runId: string): Promise<AgentApprovalResume> => {
    const agents = requireAgents()
    const run = await agents.runs.getById({ projectId: runtime.projectId, id: runId })
    if (run?.kind !== "conversation" || !isAwaitingApprovalRun(run)) return { status: "closed" }

    const requester = (
      await runtime.storage.executions.getById({
        projectId: runtime.projectId,
        id: run.executionId,
      })
    )?.requestedBy
    if (authority.type === "principal" && !(requester && principalsEqual(requester, principal))) {
      return { status: "closed" }
    }

    const stop = () => stopAgentTurn(agents, runtime.broker, run)
    try {
      // A requester who left the thread no longer runs turns in it.
      if (!(await rule.read(run.threadId))) {
        throw new AgentRequestError(
          "thread_not_found",
          `[Sixb] Agent thread '${run.threadId}' is no longer readable by whoever asked for its turn.`
        )
      }

      const approvalMode = resumedApprovalMode(
        agentRunApprovalMode(run),
        await listTurnApprovals(agents, { projectId: runtime.projectId, runId: run.id })
      )
      const resumed = await resumeAgentTurn(runtime, execution, models?.language, run, {
        approvalMode,
        principal,
      })
      if (resumed.status === "closed") await stop()
      return resumed
    } catch (error) {
      const refused = refusedResume(error)
      if (!refused.retrying) await stop()
      return refused
    }
  }

  const preferences: AgentPreferencesRuntime = {
    get: async () => {
      const { approvalMode, approvalModeSource } = await defaultAgentApprovalMode(requireAgents(), {
        projectId: runtime.projectId,
        principal: settingsPrincipal(),
      })
      return {
        approvalMode,
        approvalModeSource: approvalModeSource === "default" ? "default" : "fallback",
      }
    },
    update: async (input) => {
      if (input.approvalMode !== undefined) {
        await requireAgents().approvalModes.setDefault({
          projectId: runtime.projectId,
          principal: settingsPrincipal(),
          mode: assertAgentApprovalMode(input.approvalMode),
        })
      }
      return preferences.get()
    },
  }

  const agentRuntime: AgentRuntime<TParams> = {
    get: getAgent,
    memory: createAgentMemoryRuntime(runtime),
    approvals,
    preferences,
    threads: {
      recreateSandbox: async (threadId, input) => {
        const readable = await rule.read(threadId)
        if (!readable)
          throw new AgentRequestError("thread_not_found", "[Sixb] Agent thread not found.")
        if (readable.access !== "owner") {
          throw new AgentRequestError(
            "not_thread_owner",
            `[Sixb] Only the owner of Agent thread '${threadId}' can recreate its sandbox.`
          )
        }

        const thread = readable.thread
        const storage = runtime.storage.agents
        if (!storage)
          throw new AgentRequestError(
            "storage_unavailable",
            "[Sixb] Agent storage is not configured."
          )
        const sandboxState = await storage.threads.transitionSandbox({
          projectId: runtime.projectId,
          id: threadId,
          action: "recreate",
          expectedSandboxName: input.expectedSandboxName,
          name: createAgentThreadSandboxName(runtime.projectId, threadId),
        })
        const [view] = await agentThreadViews(runtime, [{ ...thread, sandboxState }])
        return view ?? thread
      },
      create: async (input) => {
        assertNoAgentSelector(input)
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }
        const storage = runtime.storage.agents
        if (!storage) {
          throw new AgentRequestError(
            "storage_unavailable",
            "[Sixb] Agent storage is not configured."
          )
        }
        if (input.sandbox !== undefined && !sandbox?.supportsPersistence) {
          throw new AgentRequestError(
            "sandbox_not_configured",
            "[Sixb] Thread sandboxes require a provider with persistence support."
          )
        }
        const binding =
          input.sandbox === undefined
            ? undefined
            : normalizeSandboxBinding(sandbox?.definition, input.sandbox, runtime.ontology)
        const created = await storage.threads.create({
          ...(binding === undefined ? {} : { sandboxParams: binding }),
          id: input.id ?? createAgentThreadId(),
          projectId: runtime.projectId,
          ownerPrincipal: principal,
          ...(input.title === undefined ? {} : { title: input.title }),
        })
        return { ...created, participants: [] }
      },
      fork: async (threadId) => {
        // Checked before the copy's transaction: an access removed in between can still fork once.
        const readable = await rule.read(threadId)
        if (!readable) {
          throw new AgentRequestError(
            "thread_not_found",
            `[Sixb] Agent thread '${threadId}' not found.`
          )
        }

        if (!getAgent()) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }

        const fork = await forkAgentThread(runtime, {
          source: readable.thread,
          ownerPrincipal: principal,
          sandbox,
        })
        const [view] = await agentThreadViews(runtime, [fork])
        return view ?? { ...fork, participants: [] }
      },
      getById: getVisibleThreadRecord,
      list: async ({ sharedWithMe, ...input } = {}) => {
        assertNoAgentSelector(input)
        const none = { threads: [], hasMore: false, total: 0 }
        if (authority.type === "denied" || authority.type === "delegated") return none

        const storage = runtime.storage.agents
        if (!storage || !allowed()) return none

        // Code without a caller owns every thread, so nothing is shared with it.
        const caller = authority.type === "principal" ? principal : undefined
        if (sharedWithMe && caller?.type !== "user") return none

        const result = await storage.threads.list({
          ...input,
          projectId: runtime.projectId,
          ...(sharedWithMe && caller?.type === "user"
            ? { participantPrincipal: caller }
            : { ownerPrincipal: caller }),
        })
        return { ...result, threads: await agentThreadViews(runtime, result.threads) }
      },
      participants: {
        add: (threadId, users) =>
          addAgentThreadParticipants(runtime, rule, security, threadId, users),
        remove: (threadId, user) => removeAgentThreadParticipant(runtime, rule, threadId, user),
      },
      getApprovalMode: getThreadApprovalMode,
      setApprovalMode: setThreadApprovalMode,
    },
    runs: {
      request: async (input) => {
        assertNoAgentSelector(input)
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }
        assertAuthorized(runtime, { kind: "agent.run" })
        if (input.threadId && !(await getVisibleThreadRecord(input.threadId))) {
          throw new AgentRequestError(
            "thread_not_found",
            `[Sixb] Agent thread '${input.threadId}' not found.`
          )
        }
        const result = await requestAgentRun(runtime, execution, turnModels, {
          ...input,
          principal,
        })
        return { ...result, run: await attachRunView(runtime, result.run) }
      },
      retry: async (runId) => {
        const failedRun = await getControllableRun(runId, "retry")
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }
        const result = await retryAgentRun(runtime, execution, models?.language, failedRun)
        return { ...result, run: await attachRunView(runtime, result.run) }
      },
      cancel: async (runId) => {
        const run = await getControllableRun(runId, "cancel")
        return attachRunView(runtime, await cancelAgentRun(runtime, run))
      },
      getById: getRun,
      listForThread: async (threadId, input = {}) => {
        assertNoAgentSelector(input)
        if (!(await getVisibleThreadRecord(threadId))) return null
        return listConversationRuns(runtime, threadId, input)
      },
    },
    observed: createObservedAgentThreadsRuntime(runtime),
  }
  registerAgentTurnResume(agentRuntime, resumeDecidedTurn)
  return agentRuntime
}

function createObservedAgentThreadsRuntime(
  runtime: SixbRuntimeContext
): ObservedAgentThreadsRuntime {
  const getById = async (threadId: string): Promise<AgentThreadView | null> => {
    assertAuthorized(runtime, { kind: "agentThreads.observe" })

    const thread = await runtime.storage.agents?.threads.getById({
      projectId: runtime.projectId,
      id: threadId,
    })
    if (!thread) return null

    const [view] = await agentThreadViews(runtime, [thread])
    return view ?? null
  }

  return {
    getById,

    async listRuns(threadId, input = {}) {
      assertNoAgentSelector(input)
      if (!(await getById(threadId))) {
        return null
      }
      return listConversationRuns(runtime, threadId, input)
    },
  }
}

/** A thread's conversation runs with their views; whoever calls it has decided who may read them. */
async function listConversationRuns(
  runtime: SixbRuntimeContext,
  threadId: string,
  input: Omit<ListAgentRunsInput, "projectId" | "threadId">
): Promise<AgentRunListResult | null> {
  const storage = runtime.storage.agents
  if (!storage) return null

  const result = await storage.runs.list({ ...input, projectId: runtime.projectId, threadId })
  return {
    ...result,
    runs: await attachRunViews(
      runtime,
      result.runs.filter((run) => run.kind === "conversation")
    ),
  }
}

async function attachRunView(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<AgentRunView> {
  const [view] = await attachRunViews(runtime, [run])
  if (!view) throw new Error(`[Sixb] Could not build Agent run '${run.id}' view.`)
  return view
}

async function attachRunViews(
  runtime: SixbRuntimeContext,
  runs: readonly ConversationAgentRunRecord[]
): Promise<readonly AgentRunView[]> {
  const executionIds = runs.map((run) => run.executionId)
  const [executions, usages, costs] = await Promise.all([
    Promise.all(
      runs.map((run) =>
        runtime.storage.executions.getById({
          projectId: runtime.projectId,
          id: run.executionId,
        })
      )
    ),
    resolveExecutionUsage({
      storage: runtime.storage.aiUsage,
      projectId: runtime.projectId,
      executionIds,
    }),
    resolveExecutionCosts({
      storage: runtime.storage.aiCosts,
      projectId: runtime.projectId,
      executionIds,
    }),
  ])

  return runs.map((run, index) => {
    const execution = executions[index]
    if (!execution) {
      throw new Error(
        `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }
    const usage = usages[index]
    const cost = usage === undefined ? undefined : costs[index]
    return {
      ...run,
      ...(execution.requestedBy === undefined
        ? {}
        : { requestedBy: structuredClone(execution.requestedBy) }),
      ...(usage === undefined ? {} : { usage }),
      ...(cost === undefined ? {} : { cost }),
    }
  })
}

/**
 * Why a resume was refused. An AI limit, or a failure Sixb did not expect, is tried again by the
 * worker's repair pass; a lost grant, a thread left or a sandbox to recreate is not.
 */
function refusedResume(error: unknown): Extract<AgentApprovalResume, { status: "refused" }> {
  if (error instanceof AgentRequestError) {
    return { status: "refused", code: error.code, message: error.message, retrying: false }
  }
  if (error instanceof AuthorizationError) {
    return { status: "refused", code: "forbidden", message: error.message, retrying: false }
  }
  if (isSixbError(error)) {
    return { status: "refused", code: error.code, message: error.message, retrying: true }
  }
  console.error("[Sixb] Could not resume an Agent turn after its approvals; retrying later.", error)
  return {
    status: "refused",
    code: "internal.unexpected",
    message: "[Sixb] The Agent turn could not resume. Sixb tries again.",
    retrying: true,
  }
}
