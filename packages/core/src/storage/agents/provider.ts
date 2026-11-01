import { isDeepStrictEqual } from "node:util"
import { createAgentMessageId, createCopiedAgentContextCheckpointId } from "../../agents/ids"
import { AGENT_REASONING_LEVELS } from "../../agents/types"
import type { Principal, UserPrincipal } from "../../auth"
import { isFileRef } from "../../blob-storage/validation"
import { isJsonObject, isPlainRecord } from "../../json"
import { isLanguageModelTier, LANGUAGE_MODEL_TIERS } from "../../models/catalog"
import { isModelReasoning } from "../../models/language-model"
import type { ExecutionRecord, ExecutionStorage } from "../executions"
import { findAgentRunExecution } from "../executions/run-link"
import { AgentStorageError } from "./errors"
import type {
  AddAgentThreadParticipantsInput,
  AgentApprovalCall,
  AgentApprovalMode,
  AgentApprovalRecord,
  AgentApprovalStatus,
  AgentContextCheckpointRecord,
  AgentMemoryChange,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  AgentThreadSandboxParams,
  AgentThreadSandboxState,
  AgentTokenRateRecord,
  ConversationAgentRunSpec,
  CreateAgentContextCheckpointInput,
  CreateSubagentRunInput,
  FinishAgentRunInput,
  ForkAgentThreadInput,
  ListAgentApprovalsInput,
  RequestAgentApprovalInput,
  SaveAgentMemoryInput,
  StopAgentApprovalsInput,
  SubagentRunFile,
  SubagentRunRecord,
  SubagentRunResult,
  TransitionAgentThreadSandboxInput,
} from "./types"
import {
  AGENT_APPROVAL_MODES,
  AGENT_HOLDING_APPROVAL_MODES,
  AGENT_MEMORY_HISTORY_DAYS,
  AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN,
  AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN,
} from "./types"

const SANDBOX_NAME_PATTERN = /^[a-zA-Z0-9-]{1,80}$/

/**
 * Shared state machine. Providers must lock the run, then thread, around this decision/write.
 *
 * A conversation has a workspace once its sandbox is configured. A sub-agent's thread may keep a
 * blank one while the sub-agent pauses, fenced by the thread's active run as a turn's is. Its
 * next run starts a fresh one where a conversation's would need an explicit recreation.
 */
export function transitionAgentThreadSandbox(
  thread: AgentThreadRecord | null,
  run: AgentRunRecord | null,
  input: TransitionAgentThreadSandboxInput
): AgentThreadSandboxState {
  const fail = (message: string): never => {
    throw new AgentStorageError("invalid_state", `[Sixb] Sandbox ${message}`)
  }
  if (!thread || (!thread.sandboxParams && thread.kind !== "subagent")) {
    return fail("is not configured on this thread.")
  }
  if (!SANDBOX_NAME_PATTERN.test(input.name)) return fail("name is invalid.")
  const state = thread.sandboxState
  if (input.action === "recreate") {
    if (thread.activeRunId !== null) return fail("cannot be recreated during an active run.")
    if (!state || state.name !== input.expectedSandboxName || input.name === state.name)
      return fail("changed; reload before recreating.")
    if (!["busy", "blocked", "unavailable"].includes(state.status)) {
      return fail("does not require recovery.")
    }
    return {
      name: input.name,
      status: "new",
      initialized: false,
      resetAt: new Date().toISOString(),
    }
  }
  if (
    !run ||
    run.threadId !== thread.id ||
    run.status !== "running" ||
    thread.activeRunId !== run.id ||
    run.id !== input.runId ||
    run.execution?.token !== input.executionToken ||
    run.execution.queueLeaseExpiresAt.getTime() <= Date.now()
  ) {
    throw new AgentStorageError("execution_lost", "[Sixb] Sandbox execution ownership was lost.")
  }
  if (input.action === "acquire") {
    if (state && state.status !== "new" && state.status !== "ready") {
      if (thread.kind === "subagent" && state.name !== input.name) {
        return startSubagentWorkspaceAgain(input)
      }
      return fail("requires recovery; previous operations may still be in flight.")
    }
    if (state && state.name !== input.name) return fail("name changed.")
    if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint))
      return fail("source fingerprint is invalid.")
    if (state?.sourceFingerprint && state.sourceFingerprint !== input.sourceFingerprint) {
      return fail("source identity changed; the existing checkout was not opened.")
    }
    return {
      name: input.name,
      status: "busy",
      initialized: state?.initialized ?? false,
      ...(state?.resetAt ? { resetAt: state.resetAt } : {}),
      sourceFingerprint: input.sourceFingerprint,
      owner: { runId: input.runId, executionToken: input.executionToken },
    }
  }
  if (
    state?.status !== "busy" ||
    state.name !== input.name ||
    state.owner?.runId !== input.runId ||
    state.owner.executionToken !== input.executionToken
  ) {
    return fail("is not owned by this execution.")
  }
  if (input.action === "replace") {
    if (
      !state.initialized ||
      input.nextName === state.name ||
      !SANDBOX_NAME_PATTERN.test(input.nextName)
    ) {
      return fail("replacement requires initialized state and a fresh valid name.")
    }
    // Only the owning worker may report confirmed loss; retain its fence across replacement.
    return {
      ...state,
      name: input.nextName,
      initialized: false,
      resetAt: new Date().toISOString(),
    }
  }
  if (input.status === "ready" && !input.initialized) return fail("initialization is incomplete.")
  return {
    name: state.name,
    status: input.status,
    initialized: input.initialized,
    sourceFingerprint: state.sourceFingerprint,
    ...(state.resetAt ? { resetAt: state.resetAt } : {}),
  }
}

/**
 * A sub-agent's thread whose workspace an ended run left destroyed, unsaved or in doubt: the run
 * that continues it starts from a fresh one, under a new name, and is told its files were reset.
 * Nobody can recreate a sub-agent's workspace, and the thread's single active run is this one, so
 * whatever the old name still holds is never opened again.
 */
function startSubagentWorkspaceAgain(
  input: Extract<TransitionAgentThreadSandboxInput, { readonly action: "acquire" }>
): AgentThreadSandboxState {
  if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) {
    throw new AgentStorageError("invalid_state", "[Sixb] Sandbox source fingerprint is invalid.")
  }
  return {
    name: input.name,
    status: "busy",
    initialized: false,
    resetAt: new Date().toISOString(),
    sourceFingerprint: input.sourceFingerprint,
    owner: { runId: input.runId, executionToken: input.executionToken },
  }
}

/** Snapshot application parameters independently of worker-owned sandbox state. */
export function snapshotAgentThreadSandboxParams(value: unknown): AgentThreadSandboxParams {
  if (!isPlainRecord(value) || !isJsonObject(value)) {
    throw new AgentStorageError(
      "invalid_input",
      "[Sixb] Thread sandbox must contain only JSON params."
    )
  }
  return structuredClone(value)
}

/**
 * The users an add actually adds: those not already taking part. Providers call it under the
 * thread's lock with the participants they read there, so the cap holds across concurrent adds.
 * Who may be added is the caller's decision; this enforces only the cap.
 */
export function participantsToAdd(
  input: AddAgentThreadParticipantsInput,
  existing: readonly AgentThreadParticipantRecord[],
  prefix = "Sixb"
): readonly UserPrincipal[] {
  const taken = new Set(existing.map((participant) => participant.principal.id))
  const added = input.principals.filter((principal) => !taken.has(principal.id))

  if (existing.length + added.length > input.maxParticipants) {
    throw new AgentStorageError(
      "participant_limit",
      `[${prefix}] Agent thread '${input.threadId}' can have at most ${input.maxParticipants} participants.`
    )
  }

  return added
}

/**
 * Participants oldest first, then by user id and thread id compared as UTF-8 bytes: the order
 * PostgreSQL's "C" collation and SQLite's binary one give, so every provider lists them alike.
 */
export function compareAgentThreadParticipants(
  left: AgentThreadParticipantRecord,
  right: AgentThreadParticipantRecord
): number {
  return (
    left.addedAt.getTime() - right.addedAt.getTime() ||
    Buffer.compare(Buffer.from(left.principal.id), Buffer.from(right.principal.id)) ||
    Buffer.compare(Buffer.from(left.threadId), Buffer.from(right.threadId))
  )
}

const ARTIFACT_ID_TOKEN = /art_[0-9a-z]{10}/g

/**
 * Text with each artifact id the copies map replaced by its copy's: a copied message's parts, as
 * JSON, or a summary. Ids are fixed-length tokens, so one never matches inside another.
 */
export function remapArtifactIds(
  text: string,
  copies: Readonly<Record<string, string>> | undefined
): string {
  if (!copies || Object.keys(copies).length === 0) return text
  return text.replace(ARTIFACT_ID_TOKEN, (id) => copies[id] ?? id)
}

/** What a fork reads from its source thread, inside the provider's transaction. */
export interface AgentThreadForkSource {
  /** The active run's trigger message, when a turn is running. */
  readonly triggerMessageId?: string
  /**
   * Every message of the source, ordered by ascending `seq`. `counted: false` marks one the thread
   * does not count ({@link countsAsThreadMessage}); a provider reads it from the parts it copies.
   */
  readonly messages: readonly (Pick<AgentMessageRecord, "id" | "seq"> & {
    readonly counted?: boolean
  })[]
  /** Every checkpoint of the source, latest first, in `getLatest` order. */
  readonly checkpoints: readonly AgentContextCheckpointRecord[]
}

/** The rows a provider writes for a fork. */
export interface AgentThreadForkPlan {
  readonly thread: AgentThreadRecord
  /** The source messages to copy, in `seq` order, with the id of each copy. */
  readonly messages: readonly { readonly sourceId: string; readonly id: string }[]
  readonly checkpoint?: AgentContextCheckpointRecord
}

/**
 * Decide what a fork copies. While a turn is running, the fork copies what came before its trigger
 * message, so the copy never has a gap; otherwise it copies everything. Copies keep their `seq`,
 * so the latest checkpoint whose observed head was copied projects unchanged.
 *
 * The plan mints the ids of the copies: which messages are copied is only known here, under the
 * provider's lock, so the caller cannot supply them.
 */
/**
 * Whether a message counts in its thread's `messageCount`, which reads as what the conversation
 * shows. The message Sixb writes to resume a paused turn carries only how its calls ended, which the
 * chat shows on their cards: it is not counted.
 */
export function countsAsThreadMessage(message: Pick<AgentMessageRecord, "parts">): boolean {
  return !(
    message.parts.length > 0 && message.parts.every((part) => part.type === "approval-outcome")
  )
}

export function planAgentThreadFork(
  input: ForkAgentThreadInput,
  source: AgentThreadForkSource,
  prefix = "Sixb"
): AgentThreadForkPlan {
  const createdAt = new Date(input.createdAt ?? new Date())
  const sandboxState = forkedSandboxState(input, createdAt, prefix)

  const trigger = source.messages.find((message) => message.id === source.triggerMessageId)
  const copied =
    trigger === undefined
      ? source.messages
      : source.messages.filter((message) => message.seq < trigger.seq)
  const lastCopiedSeq = copied.at(-1)?.seq ?? 0

  const checkpoint = source.checkpoints.find(
    (candidate) => candidate.observedHeadSeq <= lastCopiedSeq
  )

  const thread: AgentThreadRecord = {
    id: input.id,
    projectId: input.projectId,
    kind: "conversation",
    ownerPrincipal: structuredClone(input.ownerPrincipal),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.sandboxParams === undefined
      ? {}
      : { sandboxParams: snapshotAgentThreadSandboxParams(input.sandboxParams) }),
    ...(sandboxState === undefined ? {} : { sandboxState }),
    status: "active",
    activeRunId: null,
    // No `lastMessageAt` until the fork's first new message: threads sort by it, else by their
    // creation, so a fork of an old conversation sorts with what its owner just did.
    messageCount: copied.filter((message) => message.counted !== false).length,
    createdAt,
    updatedAt: createdAt,
  }

  return {
    thread,
    messages: copied.map((message) => ({ sourceId: message.id, id: createAgentMessageId() })),
    ...(checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            ...copyCheckpoint(checkpoint, input.id),
            summary: remapArtifactIds(checkpoint.summary, input.artifactCopies),
          },
        }),
  }
}

/**
 * The copy starts the fork's chain: its predecessors stay in the source. Its `createdByRunId`
 * still names the source run, under a foreign key that restricts deletion: deleting runs or
 * threads later must account for the forks that copied their checkpoints.
 */
function copyCheckpoint(
  checkpoint: AgentContextCheckpointRecord,
  threadId: string
): AgentContextCheckpointRecord {
  const { previousCheckpointId: _previous, ...copied } = structuredClone(checkpoint)
  return { ...copied, id: createCopiedAgentContextCheckpointId(), threadId }
}

/** A fresh sandbox, reset at the fork, so the Agent knows earlier local files are not there. */
function forkedSandboxState(
  input: ForkAgentThreadInput,
  createdAt: Date,
  prefix: string
): AgentThreadSandboxState | undefined {
  if ((input.sandboxParams === undefined) !== (input.sandboxName === undefined)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] A forked thread needs a sandbox name exactly when it has sandbox params.`
    )
  }

  if (input.sandboxName === undefined) return undefined

  if (!SANDBOX_NAME_PATTERN.test(input.sandboxName)) {
    throw new AgentStorageError("invalid_input", `[${prefix}] Sandbox name is invalid.`)
  }

  return {
    name: input.sandboxName,
    status: "new",
    initialized: false,
    resetAt: createdAt.toISOString(),
  }
}

/** Validate the provider-neutral model selection captured for a conversational turn. */
export function assertConversationAgentRunSpec(
  spec: ConversationAgentRunSpec,
  prefix = "Sixb"
): void {
  if (!isRecord(spec) || !isRecord(spec.model)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent run spec must contain a model reference.`
    )
  }
  for (const [name, value] of [
    ["model.provider", spec.model.provider],
    ["model.modelId", spec.model.modelId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Conversational Agent run '${name}' must not be empty.`
      )
    }
  }
  if (spec.reasoning !== undefined && !isModelReasoning(spec.reasoning)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }

  if (spec.tier !== undefined && !isLanguageModelTier(spec.tier)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent run 'tier' must be one of: ${LANGUAGE_MODEL_TIERS.join(", ")}.`
    )
  }
  if (spec.tierProbabilities !== undefined && !isTierProbabilities(spec.tierProbabilities)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Conversational Agent run 'tierProbabilities' must give each tier a probability.`
    )
  }

  for (const [name, value] of [
    ["timeZone", spec.timeZone],
    ["locale", spec.locale],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Conversational Agent run '${name}' must be a non-empty string.`
      )
    }
  }
  assertApprovalModeField(spec.approvalMode, "Conversational Agent run", prefix)
  assertRunsOn(spec.runsOn, "Conversational Agent run", prefix)
}

/** Validate where a thread or turn runs: `computer`, or absent for the cloud. */
export function assertRunsOn(value: unknown, subject: string, prefix = "Sixb"): void {
  if (value !== undefined && value !== "computer") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] ${subject} 'runsOn' must be "computer", or absent for the cloud.`
    )
  }
}

/** Validate the id of the computer a thread runs on: the CLI's own, a short non-blank string. */
export function assertComputerId(value: unknown, prefix = "Sixb"): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] An Agent thread's 'computerId' must be a non-blank string of at most 200 characters.`
    )
  }
}

/** Refuse to assign a computer to a thread that runs in the cloud, or does not exist. */
export function assertAssignableComputer(
  thread: AgentThreadRecord | null,
  id: string,
  prefix = "Sixb"
): asserts thread is AgentThreadRecord {
  if (!thread) {
    throw new AgentStorageError("thread_not_found", `[${prefix}] Agent thread '${id}' not found.`)
  }
  if (thread.runsOn !== "computer") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent thread '${id}' runs in the cloud: no computer runs its turns.`
    )
  }
}

export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return (AGENT_APPROVAL_MODES as readonly unknown[]).includes(value)
}

/** Validate a mode a store is asked to keep, before it writes anything. */
export function assertAgentApprovalModeInput(
  mode: unknown,
  prefix = "Sixb"
): asserts mode is AgentApprovalMode {
  if (!isAgentApprovalMode(mode)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent approval mode must be one of: ${AGENT_APPROVAL_MODES.join(", ")}.`
    )
  }
}

function assertApprovalModeField(value: unknown, owner: string, prefix: string): void {
  if (value !== undefined && !isAgentApprovalMode(value)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] ${owner} 'approvalMode' must be one of: ${AGENT_APPROVAL_MODES.join(", ")}.`
    )
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTierProbabilities(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== LANGUAGE_MODEL_TIERS.length) return false

  return LANGUAGE_MODEL_TIERS.every((tier) => {
    const probability = value[tier]
    return typeof probability === "number" && probability >= 0 && probability <= 1
  })
}

/** Validate the semantic link between a conversational Agent run and its immutable execution. */
export async function assertAgentRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
}): Promise<ExecutionRecord> {
  const execution = await findAgentRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    runId: input.runId,
    authority: { type: "inherited" },
  })
  if (!execution) {
    throw new AgentStorageError(
      "invalid_input",
      `[Sixb] Execution '${input.executionId}' does not authorize Agent run '${input.runId}'.`
    )
  }
  return execution
}

/** Validate the provider-neutral payload of an idempotent child admission. */
export function assertCreateSubagentRunInput(input: CreateSubagentRunInput, prefix = "Sixb"): void {
  for (const [name, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["executionId", input.executionId],
    ["parentRunId", input.parentRunId],
    ["parentExecutionToken", input.parentExecutionToken],
    ["spawnKey", input.spawnKey],
    ["model.provider", input.spec.model.provider],
    ["model.modelId", input.spec.model.modelId],
    ["task", input.spec.task],
    ["thread.id", input.thread.id],
    ["trigger.id", input.trigger.id],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Subagent run '${name}' must not be empty.`
      )
    }
  }
  if (input.spawnKey.length > 128) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent spawn key must not exceed 128 characters.`
    )
  }
  if (!Number.isSafeInteger(input.maxActiveChildren) || input.maxActiveChildren < 1) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run 'maxActiveChildren' must be a positive safe integer.`
    )
  }
  if (new Set(input.spec.toolNames).size !== input.spec.toolNames.length) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run tool names must be unique.`
    )
  }
  if (input.spec.reasoning !== undefined && !isModelReasoning(input.spec.reasoning)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }
  assertApprovalModeField(input.spec.approvalMode, "Subagent run", prefix)

  assertSubagentRunFiles(input.spec.files, "spec.files", prefix)

  if (input.spec.toolNames.some((name) => !name.trim())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run tool names must not be empty.`
    )
  }
  if (!Array.isArray(input.trigger.parts) || input.trigger.parts.length === 0) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run trigger must have at least one part.`
    )
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run createdAt must be a valid date.`
    )
  }
}

/** Exact semantic match required when a durable spawn key is replayed. */
export function subagentRunMatchesCreateInput(
  run: AgentRunRecord,
  input: CreateSubagentRunInput
): run is SubagentRunRecord {
  return (
    run.kind === "subagent" &&
    run.id === input.id &&
    run.projectId === input.projectId &&
    run.executionId === input.executionId &&
    run.parentRunId === input.parentRunId &&
    run.spawnKey === input.spawnKey &&
    run.threadId === input.thread.id &&
    isDeepStrictEqual(run.spec, input.spec)
  )
}

/** Refuse what only a conversation does on a sub-agent's thread. */
export function assertConversationThreadRow(
  thread: Pick<AgentThreadRecord, "id" | "kind">,
  /** What is refused, completing "only a conversation …". */
  operation: string,
  prefix = "Sixb"
): void {
  if (thread.kind === "conversation") return
  throw new AgentStorageError(
    "thread_not_conversation",
    `[${prefix}] Agent thread '${thread.id}' is a sub-agent's: only a conversation ${operation}.`
  )
}

/**
 * The thread a child's first run creates. Its conversation's owner owns it, and its run is active
 * in it from the start: the trigger is its first and only message.
 */
export function newSubagentThreadRecord(
  input: CreateSubagentRunInput,
  conversation: { readonly id: string; readonly ownerPrincipal: Principal },
  createdAt: Date
): AgentThreadRecord {
  return {
    id: input.thread.id,
    projectId: input.projectId,
    kind: "subagent",
    parent: { threadId: conversation.id, spawnedBy: input.parentRunId, key: input.spawnKey },
    ownerPrincipal: structuredClone(conversation.ownerPrincipal),
    status: "active",
    activeRunId: input.id,
    lastMessageAt: createdAt,
    messageCount: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * A later run of a child goes into its thread: the same child of the same conversation, and only
 * once the thread's previous run has ended, as in a conversation.
 */
export function assertSubagentThreadTakesRun(
  thread: AgentThreadRecord | null,
  input: CreateSubagentRunInput,
  conversationId: string,
  prefix = "Sixb"
): asserts thread is AgentThreadRecord {
  if (!thread) {
    throw new AgentStorageError(
      "thread_not_found",
      `[${prefix}] Agent thread '${input.thread.id}' not found for project '${input.projectId}'.`
    )
  }
  if (
    thread.kind !== "subagent" ||
    thread.parent?.threadId !== conversationId ||
    thread.parent.key !== input.spawnKey
  ) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent thread '${thread.id}' is not the thread of child '${input.spawnKey}' of this conversation.`
    )
  }
  if (thread.activeRunId !== null) {
    throw new AgentStorageError(
      "active_run_exists",
      `[${prefix}] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }
}

/**
 * Validate what a finish keeps: a child's result once it succeeded. A child that paused, on its
 * held calls or on a question, may not have answered yet, so its text may be empty. A conversation
 * turn keeps none, and has no parent to wait for.
 */
export function assertAgentRunFinishPayload(
  kind: AgentRunRecord["kind"],
  input: FinishAgentRunInput,
  runId: string,
  prefix = "Sixb"
): void {
  if (kind === "conversation") {
    if (input.status === "succeeded" && input.result !== undefined) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Conversational Agent run '${runId}' cannot persist a subagent result.`
      )
    }
    if (input.finishReason === "awaiting_answer") {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Conversational Agent run '${runId}' has no parent to wait for: only a subagent finishes awaiting_answer.`
      )
    }
    return
  }

  if (input.status === "succeeded") {
    const paused =
      input.finishReason === "awaiting_approval" || input.finishReason === "awaiting_answer"
    assertSubagentRunResult(input.result, runId, prefix, paused)
  }
}

/**
 * Validate the small durable result returned by a successful child. A child that paused on its held
 * calls may not have answered yet, so its text may be empty.
 */
export function assertSubagentRunResult(
  result: SubagentRunResult | undefined,
  runId: string,
  prefix = "Sixb",
  paused = false
): asserts result is SubagentRunResult {
  if (typeof result?.text !== "string" || (!paused && result.text.trim().length === 0)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Succeeded subagent run '${runId}' requires text.`
    )
  }
  assertSubagentRunFiles(result.files, "result.files", prefix)
  if (
    result.filesError !== undefined &&
    (typeof result.filesError !== "string" || !result.filesError.trim() || result.files?.length)
  ) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run '${runId}' result.filesError must say why it returned no files.`
    )
  }
  if (
    result.unread !== undefined &&
    (!paused ||
      !Array.isArray(result.unread) ||
      !result.unread.every((mail) => typeof mail?.id === "string" && typeof mail.text === "string"))
  ) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Only a paused subagent run keeps unread mail, each with its id and text: '${runId}'.`
    )
  }
}

/** Each file a parent and its child exchange: a safe relative path, once, and a valid FileRef. */
function assertSubagentRunFiles(
  files: readonly SubagentRunFile[] | undefined,
  field: string,
  prefix: string
): void {
  if (files === undefined) return

  if (!Array.isArray(files)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run ${field} must be a list.`
    )
  }

  const paths = new Set<string>()
  for (const file of files) {
    const segments: readonly string[] = typeof file?.path === "string" ? file.path.split("/") : []
    const safe =
      segments.length > 0 &&
      !file.path.includes("\0") &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    if (!safe || paths.has(file.path) || !isFileRef(file.fileRef)) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Subagent run ${field} must hold unique relative paths, each with a valid FileRef.`
      )
    }
    paths.add(file.path)
  }
}

/** Validate provider-independent checkpoint fields before entering a storage critical section. */
export function assertCreateAgentContextCheckpointInput(
  input: CreateAgentContextCheckpointInput,
  prefix = "Sixb"
): void {
  for (const [name, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["threadId", input.threadId],
    ["createdByRunId", input.createdByRunId],
    ["executionToken", input.executionToken],
    ["summary", input.summary],
    ["summaryModelId", input.summaryModelId],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Agent context checkpoint '${name}' must not be empty.`
      )
    }
  }

  if (input.summaryFormatVersion !== 1) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint summary format version must be 1.`
    )
  }
  if (input.reason !== "threshold" && input.reason !== "overflow") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint reason must be 'threshold' or 'overflow'.`
    )
  }
  if (
    input.expectedPreviousCheckpointId !== null &&
    input.expectedPreviousCheckpointId.trim().length === 0
  ) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint expected previous id must not be empty.`
    )
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint createdAt must be a valid date.`
    )
  }

  for (const [name, value, minimum] of [
    ["expectedHeadSeq", input.expectedHeadSeq, 1],
    ["summarizedThroughSeq", input.summarizedThroughSeq, 1],
    ["observedHeadSeq", input.observedHeadSeq, 1],
    ["estimatedInputTokensBefore", input.estimatedInputTokensBefore, 0],
    ["estimatedInputTokensAfter", input.estimatedInputTokensAfter, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Agent context checkpoint '${name}' must be a safe integer greater than or equal to ${minimum}.`
      )
    }
  }

  if (input.observedHeadSeq !== input.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint observed head must equal its expected message head.`
    )
  }
  if (input.summarizedThroughSeq >= input.observedHeadSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint must retain the triggering head message.`
    )
  }
}

/** Assert that the current delivery still owns the active conversational run. */
export function assertAgentContextCheckpointAuthority(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly run: AgentRunRecord | null
  readonly thread: AgentThreadRecord | null
  readonly prefix?: string
}): asserts input is typeof input & {
  readonly run: AgentRunRecord
  readonly thread: AgentThreadRecord
} {
  const { create, run, thread } = input
  const prefix = input.prefix ?? "Sixb"
  if (!run) {
    throw new AgentStorageError(
      "run_not_found",
      `[${prefix}] Agent run '${create.createdByRunId}' not found for project '${create.projectId}'.`
    )
  }
  if (!thread) {
    throw new AgentStorageError(
      "thread_not_found",
      `[${prefix}] Agent thread '${create.threadId}' not found for project '${create.projectId}'.`
    )
  }
  if (run.kind !== "conversation" || run.threadId !== create.threadId) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent run '${run.id}' does not belong to thread '${create.threadId}'.`
    )
  }
  // A run that ended no longer holds its execution, as a reclaimed one does not.
  if (run.status !== "running") {
    throw new AgentStorageError(
      "execution_lost",
      `[${prefix}] Agent run '${run.id}' is not running (status '${run.status}').`
    )
  }
  if (!run.execution || run.execution.token !== create.executionToken) {
    throw new AgentStorageError(
      "execution_lost",
      `[${prefix}] Execution token is no longer current on agent run '${run.id}'.`
    )
  }
  if (thread.activeRunId !== run.id) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent run '${run.id}' no longer owns thread '${thread.id}'.`
    )
  }
}

/** Assert both compare-and-swap anchors and the retained-turn boundary. */
export function assertAgentContextCheckpointAnchors(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly latest: AgentContextCheckpointRecord | null
  readonly headSeq: number
  readonly firstRetained: AgentMessageRecord | null
  readonly prefix?: string
}): void {
  const { create, latest, headSeq, firstRetained } = input
  const prefix = input.prefix ?? "Sixb"
  if (headSeq !== create.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${create.threadId}' message head changed from ${create.expectedHeadSeq} to ${headSeq}.`
    )
  }

  const latestId = latest?.id ?? null
  if (latestId !== create.expectedPreviousCheckpointId) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${create.threadId}' checkpoint head changed.`
    )
  }
  if (latest && create.summarizedThroughSeq <= latest.summarizedThroughSeq) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint boundary must advance beyond sequence ${latest.summarizedThroughSeq}.`
    )
  }
  if (!firstRetained || firstRetained.seq !== create.summarizedThroughSeq + 1) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent context checkpoint boundary does not align with stored thread messages.`
    )
  }
  if (firstRetained.role !== "user") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent context checkpoint must retain a complete turn beginning with a user message.`
    )
  }
}

/** Validate the mutable anchors again before returning an idempotently created checkpoint. */
export function assertAgentContextCheckpointReplayState(input: {
  readonly create: CreateAgentContextCheckpointInput
  readonly existing: AgentContextCheckpointRecord
  readonly latest: AgentContextCheckpointRecord | null
  readonly headSeq: number
  readonly prefix?: string
}): void {
  const prefix = input.prefix ?? "Sixb"
  if (input.headSeq !== input.create.expectedHeadSeq) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${input.create.threadId}' message head changed from ${input.create.expectedHeadSeq} to ${input.headSeq}.`
    )
  }
  if (input.latest?.id !== input.existing.id) {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent thread '${input.create.threadId}' checkpoint head changed after '${input.existing.id}'.`
    )
  }
}

/** Compare the durable semantic payload; delivery token and generated timestamp are not content. */
export function agentContextCheckpointMatchesCreateInput(
  record: AgentContextCheckpointRecord,
  input: CreateAgentContextCheckpointInput
): boolean {
  return (
    record.id === input.id &&
    record.projectId === input.projectId &&
    record.threadId === input.threadId &&
    record.createdByRunId === input.createdByRunId &&
    (record.previousCheckpointId ?? null) === input.expectedPreviousCheckpointId &&
    record.reason === input.reason &&
    record.summary === input.summary &&
    record.summaryFormatVersion === input.summaryFormatVersion &&
    record.summarizedThroughSeq === input.summarizedThroughSeq &&
    record.observedHeadSeq === input.observedHeadSeq &&
    record.estimatedInputTokensBefore === input.estimatedInputTokensBefore &&
    record.estimatedInputTokensAfter === input.estimatedInputTokensAfter &&
    record.summaryModelId === input.summaryModelId
  )
}

/** Validate the fields of a save that storage relies on, before entering its transaction. */
export function assertSaveAgentMemoryInput(input: SaveAgentMemoryInput, prefix = "Sixb"): void {
  const fail = (message: string): never => {
    throw new AgentStorageError("invalid_input", `[${prefix}] Agent memory ${message}`)
  }
  if (input.projectId.trim().length === 0) fail("project id must not be empty.")
  if (input.repoId.trim().length === 0) fail("repo id must not be empty.")
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    fail("base revision must be a non-negative integer.")
  }
  if (input.message.trim().length === 0) fail("save message must not be empty.")
  if (input.changes.length === 0) fail("save must change at least one file.")
  const paths = new Set<string>()
  for (const change of input.changes) {
    if (change.path.length === 0) fail("paths must not be empty.")
    if (paths.has(change.path)) fail(`save changes '${change.path}' more than once.`)
    paths.add(change.path)
  }
  if (input.createdAt && !Number.isFinite(input.createdAt.getTime())) {
    fail("save time must be a valid date.")
  }
}

/** A path's highest-revision version; `contents: null` when that revision deleted it. */
export interface LatestAgentMemoryFile {
  readonly revision: number
  readonly contents: string | null
}

/**
 * The changes of a save that would overwrite another save's work, as their files are now: every
 * change when the repo is behind the base revision (it was deleted since), otherwise each change
 * whose path was written after the base revision. Ordered by path.
 */
export function agentMemoryConflicts(
  input: SaveAgentMemoryInput,
  head: number,
  latest: ReadonlyMap<string, LatestAgentMemoryFile>
): AgentMemoryChange[] {
  return input.changes
    .filter(
      (change) =>
        input.baseRevision > head || (latest.get(change.path)?.revision ?? 0) > input.baseRevision
    )
    .map((change) => ({ path: change.path, contents: latest.get(change.path)?.contents ?? null }))
    .sort((left, right) => compareAgentMemoryPaths(left.path, right.path))
}

/** Code-unit order, as SQLite and Postgres (with `COLLATE "C"`) compare paths. */
export function compareAgentMemoryPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** File versions written before this time leave the history once a newer version exists. */
export function agentMemoryHistoryCutoff(savedAt: Date): Date {
  return new Date(savedAt.getTime() - AGENT_MEMORY_HISTORY_DAYS * 24 * 60 * 60 * 1000)
}

// ── token rates ───────────────────────────────────────────────────────────────────────────────

export { AGENT_TOKEN_RATE_SAMPLES } from "./types"

/** Validate a measurement before a store keeps it: it comes from whichever runner ran the run. */
export function assertAgentTokenRateRecord(input: AgentTokenRateRecord, prefix = "Sixb"): void {
  const fail = (message: string): never => {
    throw new AgentStorageError("invalid_input", `[${prefix}] Agent token rate ${message}`)
  }

  for (const field of ["projectId", "providerId", "modelId", "runId"] as const) {
    const value: unknown = input[field]
    if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must not be empty.`)
  }
  for (const field of ["bytes", "tokens"] as const) {
    const value: unknown = input[field]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      fail(`${field} must be a positive integer.`)
    }
  }
  if (!(input.measuredAt instanceof Date) || !Number.isFinite(input.measuredAt.getTime())) {
    fail("measurement time must be a valid date.")
  }

  const rate = input.bytes / input.tokens
  if (rate < AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN || rate > AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN) {
    fail(
      `bytes per token must be between ${AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN} and ${AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN}.`
    )
  }
}

// ── approvals ─────────────────────────────────────────────────────────────────────────────────

/** An approval that still answers for its call key: a settled one asks again. */
export const LIVE_AGENT_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
] as const satisfies readonly AgentApprovalStatus[]

/**
 * Whether an approval keeps its run paused: still waiting, or decided and not reported to the model
 * yet. A run finishes `awaiting_approval` only while it holds one.
 */
export function agentApprovalHoldsRun(approval: AgentApprovalRecord, runId: string): boolean {
  return (
    (approval.runId === runId || approval.callerRunId === runId) &&
    (LIVE_AGENT_APPROVAL_STATUSES as readonly string[]).includes(approval.status) &&
    approval.reportedInMessageId === undefined
  )
}

/** Refuse a paused finish that holds no call, or a paused finish that did not succeed. */
export function assertAwaitingApprovalFinish(input: {
  readonly runId: string
  readonly status: string
  readonly holdsApproval: boolean
  readonly prefix?: string
}): void {
  const prefix = input.prefix ?? "Sixb"
  if (input.status !== "succeeded") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent run '${input.runId}' can only pause for approval when it succeeds.`
    )
  }
  if (!input.holdsApproval) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent run '${input.runId}' holds no call waiting for approval, so it cannot finish awaiting one.`
    )
  }
}

/**
 * Whether a run can have approvals: its mode holds some calls. A turn from before approval modes,
 * or in `auto`, holds none, and neither do its children, which copy its mode.
 */
export function agentRunMayHoldCalls(run: AgentRunRecord): boolean {
  return (AGENT_HOLDING_APPROVAL_MODES as readonly unknown[]).includes(run.spec?.approvalMode)
}

/** Whether a stop request reaches this approval. */
export function agentApprovalStops(
  approval: AgentApprovalRecord,
  input: StopAgentApprovalsInput
): boolean {
  return (
    approval.projectId === input.projectId &&
    approval.threadId === input.threadId &&
    approval.reportedInMessageId === undefined &&
    (input.runId === undefined || approval.runId === input.runId) &&
    (input.requestedBy === undefined ||
      (approval.requestedBy.type === input.requestedBy.type &&
        approval.requestedBy.id === input.requestedBy.id))
  )
}

/** Whether a repair pass has work on this approval; providers run the same filter in SQL. */
export function agentApprovalRepairable(
  approval: AgentApprovalRecord,
  claimableBefore: Date
): boolean {
  const unfinished =
    approval.status === "approved" &&
    approval.outcome === undefined &&
    (approval.executionClaimedAt ?? approval.decidedAt ?? new Date(0)) <= claimableBefore
  const resumable =
    (approval.status === "approved" || approval.status === "denied") &&
    approval.reportedInMessageId === undefined &&
    approval.turnStoppedAt === undefined
  return unfinished || resumable
}

/** Whether an approved call without an outcome can be claimed now. */
export function agentApprovalClaimable(approval: AgentApprovalRecord, staleBefore: Date): boolean {
  return (
    approval.status === "approved" &&
    approval.outcome === undefined &&
    (approval.executionClaimedAt ?? approval.decidedAt ?? new Date(0)) <= staleBefore
  )
}

/** The run id the call names: unique among a thread's live approvals. */
export function agentApprovalCallKey(call: AgentApprovalCall): string {
  return call.kind === "action" ? call.actionRunId : call.workflowRunId
}

export function assertRequestAgentApprovalInput(
  input: RequestAgentApprovalInput,
  prefix = "Sixb"
): void {
  for (const [name, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["runId", input.runId],
    ["callerRunId", input.callerRunId],
    ["executionToken", input.executionToken],
    ["call key", agentApprovalCallKey(input.call)],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Agent approval '${name}' must not be empty.`
      )
    }
  }
  if (!(AGENT_HOLDING_APPROVAL_MODES as readonly unknown[]).includes(input.mode)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent approval mode must be one of: ${AGENT_HOLDING_APPROVAL_MODES.join(", ")}.`
    )
  }
}

/**
 * Fence a held call: the caller run is running with the request's token, and is the turn or one of
 * its children. Returns the turn's thread.
 */
export function assertAgentApprovalCaller(input: {
  readonly request: RequestAgentApprovalInput
  readonly turn: AgentRunRecord | null
  readonly caller: AgentRunRecord | null
  readonly prefix?: string
}): string {
  const { request, turn, caller } = input
  const prefix = input.prefix ?? "Sixb"
  if (!turn || !caller) {
    throw new AgentStorageError(
      "run_not_found",
      `[${prefix}] Agent run '${turn ? request.callerRunId : request.runId}' not found for project '${request.projectId}'.`
    )
  }
  if (turn.kind !== "conversation") {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent approval run '${turn.id}' must be a conversation turn.`
    )
  }
  if (caller.id !== turn.id && !(caller.kind === "subagent" && caller.parentRunId === turn.id)) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Agent run '${caller.id}' does not belong to turn '${turn.id}'.`
    )
  }
  if (caller.status !== "running") {
    throw new AgentStorageError(
      "invalid_state",
      `[${prefix}] Agent run '${caller.id}' is not running (status '${caller.status}').`
    )
  }
  if (!caller.execution || caller.execution.token !== request.executionToken) {
    throw new AgentStorageError(
      "execution_lost",
      `[${prefix}] Execution token is no longer current on agent run '${caller.id}'.`
    )
  }
  return turn.threadId
}

/** The approval a request creates, before any provider writes it. */
export function newAgentApprovalRecord(
  input: RequestAgentApprovalInput,
  threadId: string
): AgentApprovalRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    threadId,
    runId: input.runId,
    callerRunId: input.callerRunId,
    requestedBy: structuredClone(input.requestedBy),
    mode: input.mode,
    callKey: agentApprovalCallKey(input.call),
    call: structuredClone(input.call),
    status: "pending",
    createdAt: new Date(input.createdAt ?? new Date()),
    expiresAt: new Date(input.expiresAt),
  }
}

/** Whether an approval matches a list filter; providers run the same filter in SQL. */
export function agentApprovalMatches(
  approval: AgentApprovalRecord,
  input: ListAgentApprovalsInput
): boolean {
  return (
    approval.projectId === input.projectId &&
    (input.threadId === undefined || approval.threadId === input.threadId) &&
    (input.runId === undefined || approval.runId === input.runId) &&
    (input.requestedBy === undefined ||
      (approval.requestedBy.type === input.requestedBy.type &&
        approval.requestedBy.id === input.requestedBy.id)) &&
    (input.statuses === undefined || input.statuses.includes(approval.status)) &&
    (input.reported === undefined ||
      (approval.reportedInMessageId !== undefined) === input.reported)
  )
}
