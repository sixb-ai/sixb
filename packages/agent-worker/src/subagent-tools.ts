import { isDeepStrictEqual } from "node:util"
import {
  AGENT_REASONING_LEVELS,
  type AgentReasoning,
  AgentToolPublicError,
  type AgentToolResult,
  type LanguageModelCatalog,
  type LanguageModelRef,
  type LanguageModelTier,
} from "@sixb/core"
import {
  createInheritedAgentExecutionRecord,
  ensureExecutionRecord,
} from "@sixb/core/internal/agent-execution"
import {
  type AgentChildApprovalAwaiting,
  createAgentMessageId,
  createSubagentExecutionId,
  createSubagentRunId,
  createSubagentThreadId,
  dispatchQueuedSubagentRuns,
  isAgentToolResult,
  listChildApprovalsAwaiting,
} from "@sixb/core/internal/agents"
import { formatLanguageModelTiers, isLanguageModelTier } from "@sixb/core/internal/model-execution"
import {
  assertJsonValue,
  defineLanguageModel,
  isJsonObject,
  isModelReasoning,
  type JsonObject,
  type ModelTool,
} from "@sixb/core/models"
import type {
  ConversationAgentRunRecord,
  ExecutionRecord,
  SubagentRunFile,
  SubagentRunRecord,
  SubagentRunSpec,
} from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { renderHandedFiles } from "./agent-prompt"
import { formatBytes, SANDBOX_ATTACHMENT_LIMITS } from "./attachments"
import {
  CHILD_FILES_DIRECTORY,
  handedFileRefs,
  type InstalledChildFile,
  installChildOutputs,
  listHandedSources,
  storeHandedFiles,
} from "./child-files"
import { agentToolErrorText } from "./model-adapters"
import { renderModelLine } from "./model-lines"
import type { AgentRunFiles, AgentWorkerContext, AgentWorkerHost } from "./types"

const WAIT_POLL_MS = 250
/**
 * How long before its turn's deadline `wait_agent` stops waiting, so the Agent still answers with
 * what its children found. A last step without tools takes seconds on a light model and up to about
 * a minute on a heavy one with high reasoning; a turn has ten minutes by default.
 */
export const WAIT_ANSWER_MARGIN_MS = 60_000

const OMIT_MODEL = "Omit model to use the project default."

/** With tiers, the model guide says how to choose, so only a list adds advice. */
const TIERED_MODEL_CHOICE = {
  advice: [],
  field: "A tier, or one exact model reference from the models you can delegate to.",
}

const LISTED_MODEL_CHOICE = {
  advice: [
    "Prefer the default model unless another configured model is clearly better suited to the task. Price and runtime speed are not known, so do not infer them from model names.",
  ],
  field: "Copy one exact model reference from the available models.",
}

export interface SpawnSubagentInput {
  readonly key: string
  readonly task: string
  readonly model?: LanguageModelRef | LanguageModelTier
  readonly reasoning?: AgentReasoning
  /** Files and directories in the parent's sandbox, copied into the child's at the same paths. */
  readonly files?: readonly string[]
}

export interface SpawnSubagentOutput {
  readonly runId: string
  readonly status: SubagentRunRecord["status"]
  readonly model: LanguageModelRef
}

export interface WaitForSubagentsInput {
  readonly runIds: readonly string[]
}

export interface WaitedSubagentResult {
  readonly runId: string
  /** `queued` or `running`: the turn is about to end, so the Agent answers without it. */
  readonly status: SubagentRunRecord["status"]
  readonly text?: string
  readonly error?: { readonly code: string; readonly message: string }
  /** Calls it made that wait for the user's approval. */
  readonly awaitingApproval?: readonly AgentChildApprovalAwaiting[]
  /**
   * What it wrote under `out/`, by path there, and where each is in the parent's sandbox this
   * turn. The first result that lists them holds them as files, which later turns find in
   * `$SIXB_ATTACHMENTS` by their `logicalPath`, `<key>/<path>`.
   */
  readonly files?: readonly {
    readonly path: string
    readonly sandboxPath: string
    readonly sizeBytes: number
    readonly mediaType?: string
  }[]
  /** Why its files are not listed: they did not come back, could not be copied, or wait. */
  readonly filesNote?: string
}

export interface WaitForSubagentsOutput {
  readonly results: readonly WaitedSubagentResult[]
  /** The files no earlier result held, in the order of `results`. */
  readonly files: readonly InstalledChildFile[]
  /** Why what the children published is not all in `$SIXB_ARTIFACTS`. */
  readonly artifactsError?: string
}

/** Run-scoped boundary used by the parent Agent's framework-owned delegation tools. */
export class SubagentCoordinator {
  private readonly models: LanguageModelCatalog
  #runFiles: AgentRunFiles | undefined
  /** Children whose files are in the parent's sandbox, and in the result that first listed them. */
  readonly #installed = new Map<string, readonly InstalledChildFile[]>()
  /** The spawn being admitted: only this turn adds children to it. */
  #admissions: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly host: AgentWorkerHost,
    private readonly context: AgentWorkerContext,
    private readonly parentRun: ConversationAgentRunRecord,
    private readonly parentExecution: ExecutionRecord,
    /** When the parent turn times out: no child outlives it. */
    private readonly parentDeadline: Date
  ) {
    const models = host.definitions.models?.language
    if (!models) {
      throw new Error("[SixbAgentWorker] Subagent delegation requires a language model catalog.")
    }
    this.models = models
  }

  /** The parent's environment, started after its tools are defined and before any of them runs. */
  attach(runFiles: AgentRunFiles): void {
    this.#runFiles = runFiles
  }

  async createTools(): Promise<readonly ModelTool[]> {
    const spawn: ModelTool<SpawnSubagentInput> = {
      name: "spawn_agent",
      description: [
        "Start an isolated child agent and return immediately.",
        "Use a short, stable key for the same logical delegation so retries cannot duplicate work.",
        renderSubagentModelGuide(this.models),
        ...modelChoice(this.models).advice,
        OMIT_MODEL,
        `Pass files to copy files or directories of your sandbox into the child's, at the same paths, before it starts. What the child writes to out/ comes back with wait_agent's result when it finishes, under ${CHILD_FILES_DIRECTORY}/<key>/ this turn.`,
        `At most ${this.context.subagentConcurrencyPerRun} child agents may be active for this run.`,
      ].join("\n"),
      inputSchema: spawnInputSchema(this.models),
      parseInput: parseSpawnInput,
      execute: async (value, { signal }) => {
        const output = await this.spawn(value, signal)
        assertJsonValue(output)
        return output
      },
      errorText: agentToolErrorText,
    }
    const wait: ModelTool<WaitForSubagentsInput> = {
      name: "wait_agent",
      description: [
        "Wait for previously spawned child agents and return their final text or failure, and the files each wrote to out/, each with its path in your sandbox. Pass every run id whose result is needed.",
        "Shortly before this run must end, it returns children still at work as queued or running, so you can answer with what the others found.",
      ].join("\n"),
      inputSchema: waitInputSchema(this.context.subagentConcurrencyPerRun),
      parseInput: (value) => parseWaitInput(value, this.context.subagentConcurrencyPerRun),
      // A rich result, so its files reach later turns through $SIXB_ATTACHMENTS and the work trace.
      execute: async (value, { signal }) => {
        const { files, ...answer } = await this.wait(value, signal)
        const output: AgentToolResult = {
          kind: "agentToolResult",
          content: [
            { type: "text", text: JSON.stringify(answer) },
            ...files.map(({ fileRef }) => ({ type: "file" as const, fileRef })),
          ],
        }
        assertJsonValue(output)
        return output
      },
      // The answer lists each file's path this turn; the Agent reads the ones it needs.
      toModelOutput: (output) => ({
        type: "text",
        value: isAgentToolResult(output)
          ? output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          : JSON.stringify(output),
      }),
      errorText: agentToolErrorText,
    }
    return [spawn, wait]
  }

  async spawn(input: SpawnSubagentInput, signal: AbortSignal): Promise<SpawnSubagentOutput> {
    signal.throwIfAborted()
    const key = requireNonEmpty("spawn_agent", input.key, "key", 128)
    const task = requireNonEmpty("spawn_agent", input.task, "task")
    const model = this.resolveModel(input.model)
    const reasoning = input.reasoning ?? model.model.defaultReasoning
    const sources = input.files?.length
      ? await listHandedSources({ files: this.runFiles(), paths: input.files, signal })
      : undefined
    const runId = createSubagentRunId(this.parentRun.id, key)
    const specWith = (files: readonly SubagentRunFile[] | undefined) =>
      this.childSpec({ task, model, reasoning, files })

    // One admission at a time: only this turn adds children to it, so admission's answer is known
    // before any file is read, and a refused spawn reads and stores none.
    return this.admitInTurn(async () => {
      const existing = await this.admissionOf(runId, key)
      if (existing) {
        // The same child only if everything is the same, the files' bytes too.
        const files =
          sources && sameSpecBesidesFiles(existing.spec, specWith(undefined), sources)
            ? await handedFileRefs({ files: this.runFiles(), sources, signal })
            : undefined
        const spec = specWith(files)
        if (!isDeepStrictEqual(existing.spec, spec)) throw duplicateKey(key)
        return this.admit(runId, key, spec, signal)
      }

      const stored = sources
        ? await storeHandedFiles({ files: this.runFiles(), sources, signal })
        : undefined
      try {
        return await this.admit(runId, key, specWith(stored?.files), signal)
      } catch (error) {
        // Nothing was admitted, so the files do not count against the run.
        stored?.release()
        throw error
      }
    })
  }

  private admitInTurn<T>(admission: () => Promise<T>): Promise<T> {
    const admitted = this.#admissions.then(admission)
    this.#admissions = admitted.catch(() => {})
    return admitted
  }

  /**
   * What admission will answer, read before the files the child is handed: the child already
   * spawned with this key, else nothing once checked that the turn may spawn another.
   */
  private async admissionOf(runId: string, key: string): Promise<SubagentRunRecord | null> {
    const { runs } = this.context.storage.agents
    const maxActive = this.context.subagentConcurrencyPerRun
    const [existing, parent] = await Promise.all([
      runs.getById({ projectId: this.context.id, id: runId }),
      runs.getById({ projectId: this.context.id, id: this.parentRun.id }),
    ])
    if (existing) {
      if (existing.kind === "subagent" && existing.parentRunId === this.parentRun.id) {
        return existing
      }
      throw duplicateKey(key)
    }

    if (parent?.status !== "running") {
      throw publicSpawnError(
        new AgentStorageError("invalid_state", "Parent ended."),
        key,
        maxActive
      )
    }
    if (parent.execution?.token !== requiredExecutionToken(this.parentRun)) {
      throw new AgentStorageError(
        "execution_lost",
        `[SixbAgentWorker] Parent Agent run '${parent.id}' is no longer owned by this execution.`
      )
    }
    const active = await runs.list({
      projectId: this.context.id,
      kinds: ["subagent"],
      parentRunId: this.parentRun.id,
      statuses: ["queued", "running"],
      limit: 1,
    })
    if (active.total >= maxActive) {
      throw publicSpawnError(
        new AgentStorageError("active_child_limit", "Active child limit."),
        key,
        maxActive
      )
    }
    return null
  }

  /** A child asks no less than its turn, dates as its requester does, and ends with the turn. */
  private childSpec(input: {
    readonly task: string
    readonly model: ReturnType<SubagentCoordinator["resolveModel"]>
    readonly reasoning: AgentReasoning | undefined
    readonly files: readonly SubagentRunFile[] | undefined
  }): SubagentRunSpec {
    const { task, model, reasoning, files } = input
    const { approvalMode, timeZone, locale } = this.parentRun.spec ?? {}
    return {
      model: { provider: model.provider, modelId: model.modelId },
      task,
      toolNames: this.host.definitions.tools.list().map((definition) => definition.name),
      maxSteps: this.context.defaultMaxSteps,
      deadline: this.parentDeadline.toISOString(),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(locale === undefined ? {} : { locale }),
      ...(files === undefined ? {} : { files }),
    }
  }

  private async admit(
    runId: string,
    key: string,
    spec: SubagentRunSpec,
    signal: AbortSignal
  ): Promise<SpawnSubagentOutput> {
    const executionId = createSubagentExecutionId(runId)
    const execution = createInheritedAgentExecutionRecord({
      id: executionId,
      parent: this.parentExecution,
      runId,
    })

    let run: SubagentRunRecord
    try {
      run = await this.context.storage.transaction(async (storage) => {
        const agents = storage.agents
        if (!agents) {
          throw new Error("[SixbAgentWorker] Agent storage disappeared during child admission.")
        }
        await ensureExecutionRecord(storage.executions, execution)
        return agents.runs.createSubagent({
          id: runId,
          projectId: this.context.id,
          executionId,
          parentRunId: this.parentRun.id,
          parentExecutionToken: requiredExecutionToken(this.parentRun),
          spawnKey: key,
          spec,
          // The child works in a thread of its own, which starts with its task and its files.
          thread: { id: createSubagentThreadId(this.parentRun.id, key), create: true },
          trigger: {
            id: createAgentMessageId(),
            parts: [
              { type: "text", text: spec.task },
              ...(spec.files === undefined
                ? []
                : [{ type: "text" as const, text: renderHandedFiles(spec.files) }]),
            ],
          },
          maxActiveChildren: this.context.subagentConcurrencyPerRun,
        })
      })
    } catch (error) {
      throw publicSpawnError(error, key, this.context.subagentConcurrencyPerRun)
    }

    signal.throwIfAborted()
    if (run.status === "queued") {
      const dispatched = await dispatchQueuedSubagentRuns({
        projectId: this.context.id,
        storage: this.context.storage.agents,
        queue: this.host.queues.agentChildren,
        runIds: [run.id],
      })
      if (dispatched.failures.length > 0) {
        console.error(
          `[SixbAgentWorker] Could not dispatch subagent run '${run.id}'; reconciliation will retry.`,
          dispatched.failures[0]?.error
        )
      }
    }

    return {
      runId: run.id,
      status: run.status,
      model: { provider: run.spec.model.provider, modelId: run.spec.model.modelId },
    }
  }

  async wait(input: WaitForSubagentsInput, signal: AbortSignal): Promise<WaitForSubagentsOutput> {
    const runIds = normalizeRunIds(input.runIds, this.context.subagentConcurrencyPerRun)
    // The Agent answers before its turn times out, with or without the children still at work.
    const stopAt = this.parentDeadline.getTime() - WAIT_ANSWER_MARGIN_MS
    for (;;) {
      signal.throwIfAborted()
      const runs = await this.context.storage.agents.runs.getByIds({
        projectId: this.context.id,
        ids: runIds,
      })
      const byId = new Map(runs.map((run) => [run.id, run]))
      const children = runIds.map((runId) => {
        const run = byId.get(runId)
        if (!run || run.kind !== "subagent" || run.parentRunId !== this.parentRun.id) {
          throw new AgentToolPublicError(
            `[SixbAgentWorker] '${runId}' is not a child of the current Agent run.`
          )
        }
        return run
      })
      const remainingMs = stopAt - Date.now()
      if (children.every(isTerminalSubagent) || remainingMs <= 0) {
        const awaiting = await listChildApprovalsAwaiting(this.context.storage.agents, {
          projectId: this.context.id,
          parentRunId: this.parentRun.id,
          childRunIds: runIds,
        })
        const delivered = await this.deliverFiles(children, signal)
        return {
          results: children.map((run) =>
            waitedResult(run, awaiting.get(run.id), delivered.byChild.get(run.id))
          ),
          files: delivered.attached,
          ...(delivered.artifactsError === undefined
            ? {}
            : { artifactsError: delivered.artifactsError }),
        }
      }
      await waitDelay(Math.min(WAIT_POLL_MS, remainingMs), signal)
    }
  }

  /**
   * Copy what each finished child wrote under `out/` into the parent's sandbox, once, and install
   * what the children published in its `$SIXB_ARTIFACTS`, as the parent's own. A result holds at
   * most the attachment limits of new files, a child's whole or not at all; a child that does not
   * fit, or whose files cannot be copied, says so, and its files come with a later wait.
   */
  private async deliverFiles(
    children: readonly SubagentRunRecord[],
    signal: AbortSignal
  ): Promise<{
    readonly byChild: ReadonlyMap<string, ChildFiles>
    readonly attached: readonly InstalledChildFile[]
    readonly artifactsError?: string
  }> {
    const byChild = new Map<string, ChildFiles>()
    const attached: InstalledChildFile[] = []
    let attachedBytes = 0

    for (const child of children) {
      if (child.status !== "succeeded") continue
      const { files: outputs = [], filesError } = child.result ?? {}
      if (filesError) byChild.set(child.id, { note: filesError })

      const installed = this.#installed.get(child.id)
      if (installed) {
        byChild.set(child.id, { files: installed })
        continue
      }
      if (outputs.length === 0) continue

      const bytes = outputs.reduce((sum, file) => sum + file.fileRef.sizeBytes, 0)
      const { maxFiles, totalMaxBytes } = SANDBOX_ATTACHMENT_LIMITS
      const fits =
        attached.length + outputs.length <= maxFiles && attachedBytes + bytes <= totalMaxBytes
      if (!fits && attached.length > 0) {
        byChild.set(child.id, {
          note: `Its ${outputs.length} files did not fit in this result, which holds at most ${maxFiles} files, ${formatBytes(totalMaxBytes)} in all. Wait for this child again to get them.`,
        })
        continue
      }

      try {
        const copied = await installChildOutputs({
          files: this.runFiles(),
          key: child.spawnKey,
          outputs,
          signal,
        })
        this.#installed.set(child.id, copied)
        attached.push(...copied)
        attachedBytes += bytes
        byChild.set(child.id, { files: copied })
      } catch (error) {
        if (signal.aborted) throw error
        byChild.set(child.id, {
          note: `Its files could not be copied into your sandbox (${errorMessage(error)}). Wait for this child again to retry.`,
        })
      }
    }

    let artifactsError: string | undefined
    try {
      await this.#runFiles?.installArtifactsFrom(
        children.map((child) => child.id),
        signal
      )
    } catch (error) {
      if (signal.aborted) throw error
      artifactsError = `What these children published could not all be installed in $SIXB_ARTIFACTS (${errorMessage(error)}). The addresses in their answers still work.`
    }
    return { byChild, attached, ...(artifactsError === undefined ? {} : { artifactsError }) }
  }

  private runFiles(): AgentRunFiles {
    if (!this.#runFiles) {
      throw new Error("[SixbAgentWorker] Delegation tools ran before their run's environment.")
    }
    return this.#runFiles
  }

  private resolveModel(ref: LanguageModelRef | LanguageModelTier | undefined) {
    if (ref === undefined) return this.models.default
    if (typeof ref === "string") return this.models.getByTier(ref)
    const model = this.models.getByRef(ref)
    if (model) return model
    const available = this.models.list().map(formatModelRef).join(", ")
    throw new AgentToolPublicError(
      `[SixbAgentWorker] Language model ${formatModelRef(ref)} is not configured for this project. ` +
        `Use one of: ${available}. Omit model to use the project default.`
    )
  }
}

/**
 * Built from each model's configured definition, never from its provider catalog: the guide is in
 * every turn's tools, so it stays the same for the process and catalog I/O cannot fail a turn.
 */
export function renderSubagentModelGuide(models: LanguageModelCatalog): string {
  const entries = models.list().map((entry) => {
    const metadata = defineLanguageModel(entry.model.definition)
    if (metadata.providerId !== entry.provider || metadata.modelId !== entry.modelId) {
      throw new Error(
        "[SixbAgentWorker] Delegation model definition identity does not match its catalog entry."
      )
    }
    const details: string[] = []
    if (sameModel(entry, models.default)) details.push("default")
    if (metadata.contextWindow !== undefined)
      details.push(`context ${formatTokenCount(metadata.contextWindow)} tokens`)
    if (metadata.maxInputTokens !== undefined)
      details.push(`max input ${formatTokenCount(metadata.maxInputTokens)} tokens`)
    if (metadata.capabilities.reasoning) details.push("reasoning")
    if (metadata.capabilities.localTools) details.push("tools")
    const media = metadata.capabilities.inputMediaTypes
    if (media === "any") details.push("multimodal input")
    else if (media?.length) details.push(`input: ${media.join(", ")}`)
    if (details.length === 0 || (details.length === 1 && details[0] === "default"))
      details.push("metadata unavailable")

    return renderModelLine({
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
      reference: formatModelRef(entry),
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      details: `(${details.join("; ")})`,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
    })
  })

  const { tiers } = models
  if (tiers.length === 0) {
    return ["Available models (provider-declared metadata when available):", ...entries].join("\n")
  }

  return [
    "Models you can delegate to:",
    ...entries,
    "Tiers rank cost and strength: light is the cheapest and fastest, heavy the strongest.",
    `Use a tier by default (model: ${tiers.map((tier) => `"${tier}"`).join(" | ")}). Use a specific model when its description fits the task.`,
  ].join("\n")
}

function modelChoice(models: LanguageModelCatalog): typeof LISTED_MODEL_CHOICE {
  return models.tiers.length > 0 ? TIERED_MODEL_CHOICE : LISTED_MODEL_CHOICE
}

function formatModelRef({ provider, modelId }: LanguageModelRef): string {
  return JSON.stringify({ provider, modelId })
}

function sameModel(
  left: { readonly provider: string; readonly modelId: string },
  right: { readonly provider: string; readonly modelId: string }
): boolean {
  return left.provider === right.provider && left.modelId === right.modelId
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${formatScaled(value, 1_000_000)}M`
  if (value >= 1_000) return `${formatScaled(value, 1_000)}k`
  return String(value)
}

function formatScaled(value: number, scale: number): string {
  return (Math.round((value / scale) * 100) / 100).toString()
}

function spawnInputSchema(models: LanguageModelCatalog): JsonObject {
  return {
    type: "object",
    properties: {
      key: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Stable key for this logical delegation, for example 'compare-suppliers'.",
      },
      task: { type: "string", minLength: 1, description: "Focused task for the child agent." },
      model: {
        description: `${modelChoice(models).field} Keep provider and modelId unchanged, including any '/' inside modelId. ${OMIT_MODEL}`,
        anyOf: [...tierChoice(models.tiers), ...modelRefChoices(models)],
      },
      reasoning: {
        anyOf: [
          { type: "string", enum: [...AGENT_REASONING_LEVELS] },
          {
            type: "object",
            properties: { budgetTokens: { type: "integer", minimum: 0 } },
            required: ["budgetTokens"],
            additionalProperties: false,
          },
        ],
      },
      files: {
        type: "array",
        minItems: 1,
        maxItems: SANDBOX_ATTACHMENT_LIMITS.maxFiles,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
        description:
          "Paths of files or directories in your sandbox, such as an attachment from $SIXB_ATTACHMENTS or out/chart.png.",
      },
    },
    required: ["key", "task"],
    additionalProperties: false,
  }
}

function tierChoice(tiers: readonly LanguageModelTier[]): readonly JsonObject[] {
  return tiers.length > 0 ? [{ type: "string", enum: [...tiers] }] : []
}

// Keep each pair together: independent enums would also admit unconfigured bindings.
function modelRefChoices(models: LanguageModelCatalog): readonly JsonObject[] {
  return models.list().map(({ provider, modelId }) => ({
    type: "object",
    properties: {
      provider: { type: "string", enum: [provider] },
      modelId: { type: "string", enum: [modelId] },
    },
    required: ["provider", "modelId"],
    additionalProperties: false,
  }))
}

function waitInputSchema(maxRunIds: number): JsonObject {
  return {
    type: "object",
    properties: {
      runIds: {
        type: "array",
        minItems: 1,
        maxItems: maxRunIds,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["runIds"],
    additionalProperties: false,
  }
}

function normalizeRunIds(value: readonly string[], maxRunIds: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxRunIds) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] wait_agent requires between 1 and ${maxRunIds} child run ids.`
    )
  }
  const runIds = value.map((runId) => requireNonEmpty("wait_agent", runId, "runId"))
  if (new Set(runIds).size !== runIds.length) {
    throw new AgentToolPublicError("[SixbAgentWorker] wait_agent run ids must be unique.")
  }
  return runIds
}

function requireNonEmpty(
  toolName: "spawn_agent" | "wait_agent",
  value: unknown,
  field: string,
  maxLength?: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentToolPublicError(`[SixbAgentWorker] ${toolName} ${field} must not be empty.`)
  }
  const normalized = value.trim()
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] ${toolName} ${field} must not exceed ${maxLength} characters.`
    )
  }
  return normalized
}

function requiredExecutionToken(run: ConversationAgentRunRecord): string {
  if (!run.execution?.token) {
    throw new Error(`[SixbAgentWorker] Parent Agent run '${run.id}' has no execution token.`)
  }
  return run.execution.token
}

function publicSpawnError(error: unknown, key: string, maxActive: number): unknown {
  if (!(error instanceof AgentStorageError)) return error
  switch (error.code) {
    case "active_child_limit":
      return new AgentToolPublicError(
        `[SixbAgentWorker] The current Agent run already has ${maxActive} active children. Wait for one before spawning another.`
      )
    case "duplicate_id":
      return new AgentToolPublicError(
        `[SixbAgentWorker] spawn_agent key '${key}' was already used with different inputs.`
      )
    case "invalid_state":
      return new AgentToolPublicError("[SixbAgentWorker] The parent Agent run is no longer active.")
    default:
      return error
  }
}

function isTerminalSubagent(
  run: SubagentRunRecord
): run is SubagentRunRecord & { readonly status: "succeeded" | "failed" | "cancelled" } {
  return run.status !== "queued" && run.status !== "running"
}

interface ChildFiles {
  readonly files?: readonly InstalledChildFile[]
  readonly note?: string
}

function waitedResult(
  run: SubagentRunRecord,
  awaitingApproval: readonly AgentChildApprovalAwaiting[] | undefined,
  files: ChildFiles | undefined
): WaitedSubagentResult {
  return {
    runId: run.id,
    status: run.status,
    ...(run.result?.text ? { text: run.result.text } : {}),
    ...(run.error === undefined
      ? {}
      : { error: { code: run.error.code, message: run.error.message } }),
    ...(awaitingApproval?.length ? { awaitingApproval } : {}),
    ...(files?.files?.length
      ? {
          files: files.files.map(({ path, sandboxPath, fileRef }) => ({
            path,
            sandboxPath,
            sizeBytes: fileRef.sizeBytes,
            ...(fileRef.mediaType === undefined ? {} : { mediaType: fileRef.mediaType }),
          })),
        }
      : {}),
    ...(files?.note === undefined ? {} : { filesNote: files.note }),
  }
}

/** Whether a spawn under a key in use may be its replay, before reading its files' bytes. */
function sameSpecBesidesFiles(
  existing: SubagentRunSpec,
  spec: SubagentRunSpec,
  sources: readonly { readonly path: string; readonly sizeBytes?: number }[]
): boolean {
  const { files: existingFiles = [], ...existingRest } = existing
  const { files: _files, ...rest } = spec
  return (
    isDeepStrictEqual(existingRest, rest) &&
    existingFiles.length === sources.length &&
    existingFiles.every(
      (file, index) =>
        file.path === sources[index]?.path &&
        (sources[index]?.sizeBytes ?? file.fileRef.sizeBytes) === file.fileRef.sizeBytes
    )
  )
}

function duplicateKey(key: string): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgentWorker] spawn_agent key '${key}' was already used with different inputs.`
  )
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\[\w+\] /, "")
}

function waitDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function parseSpawnInput(value: unknown): SpawnSubagentInput {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !["key", "task", "model", "reasoning", "files"].includes(key))
  ) {
    throw new AgentToolPublicError(
      "[SixbAgentWorker] spawn_agent expects key, task, and optional model/reasoning/files."
    )
  }
  const key = requireNonEmpty("spawn_agent", value.key, "key", 128)
  const task = requireNonEmpty("spawn_agent", value.task, "task")
  let model: LanguageModelRef | LanguageModelTier | undefined
  if (typeof value.model === "string") {
    if (!isLanguageModelTier(value.model)) {
      throw new AgentToolPublicError(
        `[SixbAgentWorker] Unknown spawn_agent model tier '${value.model}'. Use ${formatLanguageModelTiers()}, or a model reference.`
      )
    }
    model = value.model
  } else if (value.model !== undefined) {
    if (
      !isJsonObject(value.model) ||
      Object.keys(value.model).some((key) => !["provider", "modelId"].includes(key))
    ) {
      throw new AgentToolPublicError(
        "[SixbAgentWorker] spawn_agent model requires provider and modelId."
      )
    }
    model = {
      provider: requireNonEmpty("spawn_agent", value.model.provider, "model.provider"),
      modelId: requireNonEmpty("spawn_agent", value.model.modelId, "model.modelId"),
    }
  }
  if (value.reasoning !== undefined && !isModelReasoning(value.reasoning)) {
    throw new AgentToolPublicError("[SixbAgentWorker] spawn_agent reasoning is invalid.")
  }
  const files = parseSpawnFiles(value.files)
  return {
    key,
    task,
    ...(model === undefined ? {} : { model }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(files === undefined ? {} : { files }),
  }
}

function parseSpawnFiles(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined

  const { maxFiles } = SANDBOX_ATTACHMENT_LIMITS
  if (!Array.isArray(value) || value.length > maxFiles) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] spawn_agent files must be a list of at most ${maxFiles} sandbox paths.`
    )
  }
  const files = value.map((path) => requireNonEmpty("spawn_agent", path, "files entry"))
  if (new Set(files).size !== files.length) {
    throw new AgentToolPublicError("[SixbAgentWorker] spawn_agent files must not repeat a path.")
  }
  return files.length > 0 ? files : undefined
}

function parseWaitInput(value: unknown, maxRunIds: number): WaitForSubagentsInput {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => key !== "runIds") ||
    !Array.isArray(value.runIds) ||
    !value.runIds.every((id) => typeof id === "string")
  ) {
    throw new AgentToolPublicError(
      "[SixbAgentWorker] wait_agent expects an array of child run ids."
    )
  }
  return { runIds: normalizeRunIds(value.runIds, maxRunIds) }
}
