import { randomUUID } from "node:crypto"
import type { Principal } from "../auth"
import { SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized } from "../authorization"
import type { FileRef } from "../blob-storage"
import { isValidFileRef } from "../blob-storage/validation"
import {
  canInheritAgentRequestAuthorization,
  createInheritedAgentExecutionRecord,
} from "../execution/agent"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type {
  LanguageModelCatalog,
  LanguageModelEntry,
  LanguageModelRef,
  LanguageModelTierProbabilities,
} from "../models"
import { isModelReasoning, modelReasoningSupportIssue } from "../models/language-model"
import { resolveLanguageModel } from "../models/resolve"
import { canonicalLocale, canonicalTimeZone } from "../runtime/locale"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type AgentApprovalMode,
  type AgentApprovalRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
  type ConversationAgentRunRecord,
  type ConversationAgentRunSpec,
} from "../storage/agents"
import {
  aiLimitSubjectsFromAttribution,
  aiUsageLimitExceededError,
  aiUsageLimitUnavailableError,
  applicableAiLimitPolicyStatuses,
} from "../storage/ai-limits/enforcement"
import type { AiLimitPolicyStatus } from "../storage/ai-limits/types"
import type { ExecutionRecord } from "../storage/executions"
import {
  type AgentTurnReadiness,
  announceAgentApprovals,
  assertAgentApprovalMode,
  isAwaitingApprovalRun,
  listTurnApprovals,
  reportAgentApprovals,
  reportSettledAgentApprovals,
  resolveAgentApprovalMode,
  turnResumeReadiness,
} from "./approvals"
import type { AgentContextEntryInput } from "./context/entries"
import { resolveAgentContextParts } from "./context-resolution"
import { dispatchQueuedAgentRuns } from "./dispatch"
import { AgentRequestError } from "./errors"
import { createAgentMessageId, createAgentRunId, createAgentThreadId } from "./ids"
import type { AgentMessagePart } from "./message"
import type { TurnModelRouter } from "./model-routing"
import { assertNoAgentSelector } from "./retired-config"
import { publishAgentRunActivity } from "./streams/protocol"
import { AGENT_REASONING_LEVELS, type AgentReasoning } from "./types"

export interface RequestAgentRunInput {
  /** The user's message that triggers the turn. Omitted only to {@link continue}. */
  readonly text?: string
  /**
   * Continue an answer the turn limit cut short, in an existing thread. Sixb writes the
   * instruction the model reads, so the request carries no text, attachments, or context.
   */
  readonly continue?: boolean
  /** Blob-backed files attached to the trigger message. */
  readonly attachments?: readonly FileRef[]
  /** Structured page/object context snapshotted onto the triggering user message. */
  readonly context?: readonly AgentContextEntryInput[]
  /** Continue an existing thread. Omitted → a fresh thread is created for this agent. */
  readonly threadId?: string
  /** Configured language model selected for this turn. Omitted uses the agent default. */
  readonly model?: LanguageModelRef
  /** Reasoning effort or token budget for this turn. Omitted uses the model's default. */
  readonly reasoning?: AgentReasoning
  /**
   * IANA time zone of the person asking, such as their browser's. The Agent presents dates and
   * times in it. Omitted uses the project time zone.
   */
  readonly timeZone?: string
  /** BCP 47 language of the person asking. Omitted uses the project locale. */
  readonly locale?: string
  /**
   * What the turn may change without asking whoever sent it. Omitted uses their choice in the
   * thread, then their default, then `auto`.
   */
  readonly approvalMode?: AgentApprovalMode
  /** Title to stamp on the thread when one is created. */
  readonly title?: string
  /** Explicit id for the trigger (user) message. Defaults to a generated id. */
  readonly messageId?: string
  /** Caller principal for privileged integrations; scoped runtimes use their authorization principal. */
  readonly principal?: Principal
}

/** What a turn's model is chosen from. */
export interface AgentRequestModels {
  readonly language?: LanguageModelCatalog
  /** Picks the model of a turn that names none; absent without tiers and `models.decision`. */
  readonly router?: TurnModelRouter
}

export interface RequestAgentRunResult {
  /** The durable queued run exactly as it was created (`status: "queued"`, attempt 0). */
  readonly run: ConversationAgentRunRecord
  /** The enqueued job id, when the queue returns one. */
  readonly jobId?: string
  /** Whether this call created the thread. */
  readonly createdThread: boolean
}

/**
 * Trigger an agent turn.
 *
 * The user message and a `queued` run are persisted atomically before the queue intent is
 * published. This makes accepted work visible immediately and lets refresh reconstruct queue state.
 * The run's thread claim is the single-flight authority; a second request receives
 * `active_run_exists` before it can leave an orphan message.
 */
export async function requestAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: AgentRequestModels,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertNoAgentSelector(input)
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const trigger = triggerParts(input)
  const continued = input.continue ? await continuedSelection(runtime, models.language, input) : {}
  const selection = {
    model: input.model ?? continued.model,
    reasoning: input.reasoning ?? continued.reasoning,
  }
  const settings = requesterSettings(input)
  if (input.approvalMode !== undefined) assertAgentApprovalMode(input.approvalMode)

  // Any other turn's spec is checked now, before anything is written. A routed turn holds its
  // router until its model is picked, last.
  const routed = routedTurn(models.router, selection, input.text)
  const requested =
    routed ?? (await resolveConversationRunSpec({ models: models.language, selection, settings }))
  assertAttachments(input.attachments)

  // Resolve context before creating a thread: invalid or inaccessible references must not leave an
  // empty conversation behind. The resulting parts are the exact snapshot persisted below.
  const contextParts = await resolveAgentContextParts(runtime, input.context)

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  // Attribution comes from the exact capability/execution pair, never the optional context cache
  // on the runtime. `input.principal` remains available to unrestricted server integrations that
  // have already authenticated their request.
  const principal =
    authority.type === "principal"
      ? authority.context.principal
      : (input.principal ?? SYSTEM_PRINCIPAL)
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)

  const existingThread = input.threadId
    ? await agents.threads.getById({ projectId, id: input.threadId })
    : null
  if (existingThread) assertThreadAcceptsRun(existingThread)
  // The message's mode, else the sender's in the thread.
  const approvalMode =
    input.approvalMode ??
    (await resolveAgentApprovalMode(agents, { projectId, principal, threadId: existingThread?.id }))
      .approvalMode

  // Last before anything is written, so a message the checks above refuse never reaches the
  // decision model. Concurrent messages to an idle thread can still each ask before one of them is
  // refused with `active_run_exists` below.
  const selected =
    "router" in requested
      ? await routedConversationRunSpec(agents, {
          ...requested,
          projectId,
          threadId: existingThread?.id,
          settings,
          language: models.language,
        })
      : requested
  const spec: ConversationAgentRunSpec = Object.freeze({ ...selected, approvalMode })

  const createdThread = existingThread === null
  const thread =
    existingThread ??
    (await createThread(agents, {
      projectId,
      threadId: input.threadId,
      title: input.title,
      principal,
    }))

  const triggerMessageId = input.messageId ?? createAgentMessageId()
  let run: ConversationAgentRunRecord
  let superseded: readonly AgentApprovalRecord[] = []
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      await tx.executions.create(durableExecution)
      // The model learns, once, how the calls it made earlier ended: the ones still waiting are
      // set aside by this message.
      const reported = createdThread
        ? { parts: [], superseded: [] }
        : await reportAgentApprovals(agents, {
            projectId,
            threadId: thread.id,
            messageId: triggerMessageId,
          })
      superseded = reported.superseded
      await agents.messages.append({
        id: triggerMessageId,
        projectId,
        threadId: thread.id,
        runId: null,
        role: "user",
        parts: [
          ...reported.parts,
          ...contextParts,
          ...trigger,
          ...(input.attachments ?? []).map((fileRef) => ({ type: "file" as const, fileRef })),
        ],
        authorPrincipal: principal,
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: thread.id,
        triggerMessageId,
        spec,
      })
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      throw new AgentRequestError("active_run_exists", error.message)
    }
    throw error
  }

  await announceAgentApprovals(runtime.broker, superseded)
  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)

  return {
    run,
    ...(jobId ? { jobId } : {}),
    createdThread,
  }
}

/** A failed turn, or one its worker died during, can run again from the same trigger message. */
export function isRetryableAgentRun(
  run: Pick<ConversationAgentRunRecord, "status" | "finishReason">
): boolean {
  return (
    run.status === "failed" || (run.status === "cancelled" && run.finishReason === "interrupted")
  )
}

/** Retry a failed turn as a new child execution while reusing its immutable trigger message. */
export async function retryAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  failedRun: ConversationAgentRunRecord
): Promise<RequestAgentRunResult> {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  if (!isRetryableAgentRun(failedRun)) {
    throw new AgentRequestError(
      "run_not_retryable",
      `[Sixb] Only failed or interrupted Agent runs can be retried.`
    )
  }

  const agents = requireAgentStorage(runtime)
  const thread = await agents.threads.getById({
    projectId: runtime.projectId,
    id: failedRun.threadId,
  })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${failedRun.threadId}' was not found.`
    )
  }
  assertSandboxExecutionAvailable(thread)
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)
  const run = await runtime.storage.transaction(async (tx) => {
    const agents = tx.agents
    if (!agents) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    await agents.messages.deleteByRunId({
      projectId: runtime.projectId,
      threadId: failedRun.threadId,
      runId: failedRun.id,
    })
    // What the failed turn published goes with what it said, so the retry starts clean. Its
    // children published into the thread too, each as its own run.
    const artifacts = tx.artifacts
    if (artifacts) {
      for (const publishedBy of [failedRun.id, ...(await childRunIds(agents, failedRun))]) {
        await artifacts.deleteVersionsByOrigin({ projectId: runtime.projectId, runId: publishedBy })
      }
    }
    await tx.executions.create(durableExecution)
    return agents.runs.create({
      id: runId,
      projectId: runtime.projectId,
      executionId: durableExecution.id,
      threadId: failedRun.threadId,
      triggerMessageId: failedRun.triggerMessageId,
      spec:
        failedRun.spec ??
        (await resolveConversationRunSpec({ models, selection: {}, settings: {} })),
    })
  })
  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)
  return { run, ...(jobId ? { jobId } : {}), createdThread: false }
}

/** Where a resume left a paused turn. */
export type AgentTurnResume =
  | { readonly status: "resumed"; readonly run: ConversationAgentRunRecord }
  | { readonly status: Exclude<AgentTurnReadiness, "ready"> }

/**
 * Resume a turn that paused on held calls, once its requester decided on all of them: a new turn
 * with the paused one's spec and the given mode, whose trigger message carries how each call ended,
 * and that the chat shows no text for. It checks what a retry checks, and throws what a retry
 * throws; there are no words for Sixb to pick a model from.
 *
 * It writes nothing while a call still waits or an approved one has not run (`waiting`), and once
 * the turn cannot resume (`closed`): a call was set aside, the turn was stopped or resumed already,
 * or a message moved the thread on.
 */
export async function resumeAgentTurn(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  pausedRun: ConversationAgentRunRecord,
  input: { readonly approvalMode: AgentApprovalMode; readonly principal?: Principal }
): Promise<AgentTurnResume> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  if (!isAwaitingApprovalRun(pausedRun)) return { status: "closed" }

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const scope = { projectId, runId: pausedRun.id }
  // Read first, so a decision that leaves calls waiting never meets a check below.
  const readiness = turnResumeReadiness(await listTurnApprovals(agents, scope))
  if (readiness !== "ready") return { status: readiness }

  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const thread = await agents.threads.getById({ projectId, id: pausedRun.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${pausedRun.threadId}' was not found.`
    )
  }
  assertSandboxExecutionAvailable(thread)

  const runId = createAgentRunId()
  const durableExecution = await prepareResumedExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)
  const spec = await resumedConversationRunSpec(models, pausedRun.spec, input.approvalMode)
  const principal =
    authority.type === "principal"
      ? authority.context.principal
      : (input.principal ?? SYSTEM_PRINCIPAL)
  const triggerMessageId = createAgentMessageId()

  let run: ConversationAgentRunRecord
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      // Checked again where it is written: a message sent meanwhile moved the thread on.
      const latest = await latestConversationRun(agents, projectId, pausedRun.threadId)
      if (latest?.id !== pausedRun.id) throw new TurnClosed()
      const approvals = await listTurnApprovals(agents, scope)
      if (turnResumeReadiness(approvals) !== "ready") throw new TurnClosed()

      // The report's compare-and-swap lets one of two racing final decisions resume the turn, and
      // a stop that lands first keeps it from resuming.
      const parts = await reportSettledAgentApprovals(agents, {
        projectId,
        threadId: pausedRun.threadId,
        messageId: triggerMessageId,
        resuming: true,
      })
      const reported = new Set(parts.map((part) => part.approvalId))
      const unreported = approvals.filter((approval) => approval.reportedInMessageId === undefined)
      if (!unreported.every((approval) => reported.has(approval.id))) throw new TurnClosed()

      await tx.executions.create(durableExecution)
      await agents.messages.append({
        id: triggerMessageId,
        projectId,
        threadId: pausedRun.threadId,
        runId: null,
        role: "user",
        parts,
        authorPrincipal: principal,
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: pausedRun.threadId,
        triggerMessageId,
        spec,
      })
    })
  } catch (error) {
    if (error instanceof TurnClosed) return { status: "closed" }
    // Another turn took the thread first; its message reports what this one would have.
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      return { status: "closed" }
    }
    throw error
  }

  await publishRunActivity(runtime, run)
  await dispatchAgentRun(runtime, agents, runId)
  return { status: "resumed", run }
}

/** Rolls the resume's transaction back: the turn cannot resume. */
class TurnClosed extends Error {
  constructor() {
    super("[Sixb] The paused Agent turn can no longer resume.")
  }
}

/**
 * A resumed turn's execution. From a request, it is that request's child, like a retry. From the
 * paused turn's own execution, as the worker resumes it, it is a sibling of the paused turn: a
 * child of the request that started it, so that resumes never nest.
 */
async function prepareResumedExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  runId: string
): Promise<Omit<ExecutionRecord, "createdAt">> {
  if (execution.executor.type !== "agent" || execution.source.type !== "execution") {
    return prepareDurableAgentExecution(runtime, execution, runId)
  }

  const parent = await runtime.storage.executions.getById({
    projectId: runtime.projectId,
    id: execution.source.executionId,
  })
  if (!parent) {
    throw new AgentRequestError(
      "authority_not_inheritable",
      `[Sixb] Agent execution '${execution.id}' has no parent to resume under.`
    )
  }
  return createInheritedAgentExecutionRecord({ id: `exec_${randomUUID()}`, parent, runId })
}

/** The paused turn's spec, with defaults for a model that has since left the catalog. */
async function resumedConversationRunSpec(
  models: LanguageModelCatalog | undefined,
  paused: ConversationAgentRunSpec | undefined,
  approvalMode: AgentApprovalMode
): Promise<ConversationAgentRunSpec> {
  const kept =
    paused && models?.getByRef(paused.model)
      ? paused
      : await resolveConversationRunSpec({
          models,
          selection: {},
          settings: {
            ...(paused?.timeZone === undefined ? {} : { timeZone: paused.timeZone }),
            ...(paused?.locale === undefined ? {} : { locale: paused.locale }),
          },
        })
  return Object.freeze({ ...kept, approvalMode })
}

/** Every child a turn spawned, whatever its status. */
async function childRunIds(
  agents: AgentStorage,
  parent: ConversationAgentRunRecord
): Promise<string[]> {
  const ids: string[] = []
  for (;;) {
    const page = await agents.runs.list({
      projectId: parent.projectId,
      kinds: ["subagent"],
      parentRunId: parent.id,
      order: "asc",
      limit: 100,
      offset: ids.length,
    })
    ids.push(...page.runs.map((run) => run.id))
    if (!page.hasMore || page.runs.length === 0) return ids
  }
}

/**
 * A continuation picks up where the cut-short turn stopped, with its model and reasoning unless the
 * request chooses others. A model that has since left the catalog falls back to the defaults.
 */
async function continuedSelection(
  runtime: SixbRuntimeContext,
  models: LanguageModelCatalog | undefined,
  input: RequestAgentRunInput
): Promise<Pick<RequestAgentRunInput, "model" | "reasoning">> {
  const agents = requireAgentStorage(runtime)
  const threadId = input.threadId ?? ""
  if (!(await agents.threads.getById({ projectId: runtime.projectId, id: threadId }))) {
    throw new AgentRequestError(
      "thread_not_found",
      "[Sixb] An Agent continuation needs an existing thread."
    )
  }
  if (input.model !== undefined || input.reasoning !== undefined) return {}
  const spec = (await latestConversationRun(agents, runtime.projectId, threadId))?.spec
  if (!spec || !models?.getByRef(spec.model)) return {}
  return {
    model: spec.model,
    ...(spec.reasoning === undefined ? {} : { reasoning: spec.reasoning }),
  }
}

/** A turn Sixb picks the model of, with the words it judges. */
interface RoutedTurn {
  readonly router: TurnModelRouter
  readonly text: string
}

/**
 * Naming a model or a reasoning opts a turn out of routing: it runs that model, or the default, as
 * chosen. A continuation has no text to judge, and keeps the cut-short turn's model.
 */
function routedTurn(
  router: TurnModelRouter | undefined,
  selection: Pick<RequestAgentRunInput, "model" | "reasoning">,
  text: string | undefined
): RoutedTurn | undefined {
  if (!router || text === undefined) return undefined
  if (selection.model !== undefined || selection.reasoning !== undefined) return undefined

  return { router, text }
}

/** The spec of a turn Sixb picks the model for, compared to the thread's previous turn. */
async function routedConversationRunSpec(
  agents: AgentStorage,
  input: RoutedTurn & {
    readonly projectId: string
    readonly threadId: string | undefined
    readonly settings: RequesterSettings
    readonly language: LanguageModelCatalog | undefined
  }
): Promise<ConversationAgentRunSpec> {
  const previous = input.threadId
    ? await latestConversationRun(agents, input.projectId, input.threadId)
    : undefined
  const choice = await input.router.choose(input.text, previous)

  return resolveConversationRunSpec({
    models: input.language,
    selection: { model: choice.model },
    settings: input.settings,
    tierProbabilities: choice.tierProbabilities,
  })
}

async function latestConversationRun(
  agents: AgentStorage,
  projectId: string,
  threadId: string
): Promise<ConversationAgentRunRecord | undefined> {
  const { runs } = await agents.runs.list({
    projectId,
    threadId,
    kinds: ["conversation"],
    order: "desc",
    limit: 1,
  })
  return runs[0]?.kind === "conversation" ? runs[0] : undefined
}

/** The words of the user, or the continuation Sixb words for them. */
function triggerParts(input: RequestAgentRunInput): readonly AgentMessagePart[] {
  if (input.continue === true) {
    if (input.text !== undefined || input.attachments?.length || input.context?.length) {
      throw new AgentRequestError(
        "invalid_message",
        "[Sixb] An Agent continuation carries no text, attachments, or context."
      )
    }
    return [{ type: "continuation" }]
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new AgentRequestError(
      "invalid_message",
      "[Sixb] An Agent message needs text, or `continue: true` to continue the previous answer."
    )
  }
  return [{ type: "text", text: input.text }]
}

function assertAttachments(attachments: readonly FileRef[] | undefined): void {
  for (const [index, attachment] of (attachments ?? []).entries()) {
    if (!isValidFileRef(attachment)) {
      throw new AgentRequestError(
        "invalid_attachment",
        `[Sixb] Attachment ${index} is not a valid file reference.`
      )
    }
  }
}

function assertThreadAcceptsRun(thread: AgentThreadRecord): void {
  assertSandboxExecutionAvailable(thread)
  // Fast single-flight check for a clear error. `runs.create` is the atomic authority.
  if (thread.activeRunId !== null) {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }
}

function assertSandboxExecutionAvailable(thread: AgentThreadRecord): void {
  if (thread.sandboxState && !["new", "ready"].includes(thread.sandboxState.status)) {
    throw new AgentRequestError(
      "sandbox_execution_unavailable",
      "[Sixb] Sandbox recovery is required before another run. Reload the thread and explicitly recreate it to start fresh."
    )
  }
}

async function assertAiLimitPreflight(
  runtime: SixbRuntimeContext,
  execution: Pick<ExecutionRecord, "requestedBy" | "requesterGroupIds">
): Promise<void> {
  const limits = runtime.storage.aiLimits
  if (!limits) throw aiUsageLimitUnavailableError(["limitStorageUnavailable"])

  const subjects = aiLimitSubjectsFromAttribution(
    execution.requestedBy,
    execution.requesterGroupIds
  )
  let applicable: readonly AiLimitPolicyStatus[]
  try {
    applicable = applicableAiLimitPolicyStatuses(
      await limits.listPolicyStatuses({ projectId: runtime.projectId }),
      subjects
    )
  } catch {
    throw aiUsageLimitUnavailableError(["limitStorageUnavailable"])
  }

  const unavailable = applicable.filter((status) => status.accountingStatus === "unavailable")
  if (unavailable.length > 0) {
    throw aiUsageLimitUnavailableError(["incompleteAccounting"])
  }
  const exhausted = applicable.filter((status) => status.exhausted)
  if (exhausted.length > 0) {
    const resetAt = new Date(
      Math.min(...exhausted.map((status) => status.period.resetAt.getTime()))
    )
    throw aiUsageLimitExceededError(resetAt)
  }
}

/**
 * Freeze the model selection of a turn. The model's default reasoning is resolved here, not by the
 * worker, so a retry runs with the reasoning the turn was admitted with.
 */
async function resolveConversationRunSpec(input: {
  readonly models?: LanguageModelCatalog
  readonly selection: Pick<RequestAgentRunInput, "model" | "reasoning">
  readonly settings: RequesterSettings
  /** The decision model's answer, when Sixb picked the model. */
  readonly tierProbabilities?: LanguageModelTierProbabilities
}): Promise<ConversationAgentRunSpec> {
  if (!input.models) {
    throw new AgentRequestError(
      "model_not_found",
      "[Sixb] Configure models.language before starting the Agent."
    )
  }
  const selected = input.selection.model ?? input.models.default
  const model = input.models.getByRef(selected)
  if (model === null) {
    throw new AgentRequestError(
      "model_not_found",
      `[Sixb] Language model '${selected.provider}/${selected.modelId}' is not in the project model catalog.`
    )
  }

  const explicitReasoning = input.selection.reasoning
  if (explicitReasoning !== undefined) {
    await assertModelSupportsReasoning(model, explicitReasoning)
  }
  const reasoning = explicitReasoning ?? model.model.defaultReasoning
  const { timeZone, locale } = input.settings

  return Object.freeze({
    model: Object.freeze({ provider: selected.provider, modelId: selected.modelId }),
    ...(model.tier === undefined ? {} : { tier: model.tier }),
    ...(input.tierProbabilities === undefined
      ? {}
      : { tierProbabilities: Object.freeze({ ...input.tierProbabilities }) }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  })
}

/** Canonical settings of the person asking, as the run spec stores them. */
type RequesterSettings = Pick<ConversationAgentRunSpec, "timeZone" | "locale">

function requesterSettings(
  input: Pick<RequestAgentRunInput, "timeZone" | "locale">
): RequesterSettings {
  const timeZone = requestedSetting(
    "timeZone",
    input.timeZone,
    canonicalTimeZone,
    "an IANA time zone"
  )
  const locale = requestedSetting("locale", input.locale, canonicalLocale, "a BCP 47 language tag")

  return {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  }
}

function requestedSetting(
  field: "timeZone" | "locale",
  value: string | undefined,
  canonical: (value: unknown) => string | undefined,
  expected: string
): string | undefined {
  if (value === undefined) return undefined
  const resolved = canonical(value)
  if (resolved === undefined) {
    throw new AgentRequestError(
      "invalid_locale",
      `[Sixb] Agent request '${field}' must be ${expected}; received ${JSON.stringify(value)}.`
    )
  }
  return resolved
}

// Checked against the model's resolved capabilities, as `GET /api/models` reports them (its
// configured ones when the provider catalog is unavailable). Undeclared capabilities accept any
// level; the provider then falls back to its own default.
async function assertModelSupportsReasoning(
  entry: LanguageModelEntry,
  reasoning: unknown
): Promise<void> {
  if (!isModelReasoning(reasoning)) {
    throw new AgentRequestError(
      "invalid_model_selection",
      `[Sixb] Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }
  if (reasoning === "provider-default") return
  const model = await resolveLanguageModel(entry.model)
  const issue = modelReasoningSupportIssue(model.definition.capabilities.reasoning, reasoning)
  if (issue !== undefined) {
    throw new AgentRequestError(
      "invalid_model_selection",
      `[Sixb] Language model '${entry.provider}/${entry.modelId}' cannot use this reasoning: ${issue}.`
    )
  }
}

async function prepareDurableAgentExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  runId: string
): Promise<Omit<ExecutionRecord, "createdAt">> {
  const parent = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )
  return createInheritedAgentExecutionRecord({
    id: `exec_${randomUUID()}`,
    parent,
    runId,
  })
}

function assertRequestAuthorityCanRunAgent(runtime: SixbRuntimeContext): void {
  if (!canInheritAgentRequestAuthorization(runtime.runtimeAuthorization)) {
    throw new AgentRequestError(
      "authority_not_inheritable",
      "[Sixb] The Agent requires an authenticated user request or disabled authorization."
    )
  }
}

async function dispatchAgentRun(
  runtime: SixbRuntimeContext,
  agents: AgentStorage,
  runId: string
): Promise<string | undefined> {
  // The queued run is the durable dispatch intent. Publication is best-effort; workers reconcile
  // it with the same deterministic queue job id if the queue is temporarily unavailable.
  try {
    const dispatch = await dispatchQueuedAgentRuns({
      projectId: runtime.projectId,
      storage: agents,
      queue: runtime.queues.agents,
      runIds: [runId],
    })
    const failure = dispatch.failures[0]
    if (failure) {
      console.error(
        `[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`,
        failure.error
      )
    }
    return dispatch.dispatched[0]?.jobId
  } catch (error) {
    console.error(`[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`, error)
    return undefined
  }
}

/** Activity delivery is observational: durable run admission remains successful if the feed is down. */
async function publishRunActivity(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunActivity(runtime.broker, run)
  } catch (error) {
    console.error(`[Sixb] Agent run '${run.id}' activity stream publish failed:`, error)
  }
}

function createThread(
  agents: AgentStorage,
  params: {
    readonly projectId: string
    readonly threadId?: string
    readonly title?: string
    readonly principal: Principal
  }
): Promise<AgentThreadRecord> {
  return agents.threads.create({
    id: params.threadId ?? createAgentThreadId(),
    projectId: params.projectId,
    ownerPrincipal: params.principal,
    ...(params.title === undefined ? {} : { title: params.title }),
  })
}

function requireAgentStorage(runtime: SixbRuntimeContext): AgentStorage {
  const agents = runtime.storage.agents
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return agents
}
