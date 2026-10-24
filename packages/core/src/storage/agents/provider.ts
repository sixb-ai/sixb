import { isDeepStrictEqual } from "node:util"
import { createAgentMessageId, createCopiedAgentContextCheckpointId } from "../../agents/ids"
import { AGENT_REASONING_LEVELS } from "../../agents/types"
import type { UserPrincipal } from "../../auth"
import { isJsonObject, isPlainRecord } from "../../json"
import { isLanguageModelTier, LANGUAGE_MODEL_TIERS } from "../../models/catalog"
import { isModelReasoning } from "../../models/language-model"
import type { ExecutionRecord, ExecutionStorage } from "../executions"
import { findAgentRunExecution } from "../executions/run-link"
import { AgentStorageError } from "./errors"
import type {
  AddAgentThreadParticipantsInput,
  AgentContextCheckpointRecord,
  AgentMemoryChange,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  AgentThreadSandboxParams,
  AgentThreadSandboxState,
  ConversationAgentRunSpec,
  CreateAgentContextCheckpointInput,
  CreateSubagentRunInput,
  ForkAgentThreadInput,
  SaveAgentMemoryInput,
  SubagentRunRecord,
  SubagentRunResult,
  TransitionAgentThreadSandboxInput,
} from "./types"
import { AGENT_MEMORY_HISTORY_DAYS } from "./types"

const SANDBOX_NAME_PATTERN = /^[a-zA-Z0-9-]{1,80}$/

/** Shared state machine. Providers must lock the run, then thread, around this decision/write. */
export function transitionAgentThreadSandbox(
  thread: AgentThreadRecord | null,
  run: AgentRunRecord | null,
  input: TransitionAgentThreadSandboxInput
): AgentThreadSandboxState {
  const fail = (message: string): never => {
    throw new AgentStorageError("invalid_state", `[Sixb] Sandbox ${message}`)
  }
  if (!thread?.sandboxParams) return fail("is not configured on this thread.")
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
    run?.kind !== "conversation" ||
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
  /** Every message of the source, ordered by ascending `seq`. */
  readonly messages: readonly Pick<AgentMessageRecord, "id" | "seq">[]
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
    messageCount: copied.length,
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
  for (const [name, value] of [
    ["maxActiveChildren", input.maxActiveChildren],
    ["spec.maxSteps", input.spec.maxSteps],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AgentStorageError(
        "invalid_input",
        `[${prefix}] Subagent run '${name}' must be a positive safe integer.`
      )
    }
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
  if (input.spec.toolNames.some((name) => !name.trim())) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Subagent run tool names must not be empty.`
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
    isDeepStrictEqual(run.spec, input.spec)
  )
}

/** Validate the small durable result returned by a successful child. */
export function assertSubagentRunResult(
  result: SubagentRunResult | undefined,
  runId: string,
  prefix = "Sixb"
): asserts result is SubagentRunResult {
  if (typeof result?.text !== "string" || result.text.trim().length === 0) {
    throw new AgentStorageError(
      "invalid_input",
      `[${prefix}] Succeeded subagent run '${runId}' requires text.`
    )
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
  if (run.status !== "running") {
    throw new AgentStorageError(
      "invalid_state",
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
