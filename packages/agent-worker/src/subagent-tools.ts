import {
  AGENT_REASONING_LEVELS,
  type AgentReasoningLevel,
  AgentToolPublicError,
  type FileRef,
  type LanguageModelCatalog,
  type LanguageModelRef,
} from "@sixb/core"
import {
  createInheritedAgentExecutionRecord,
  ensureExecutionRecord,
} from "@sixb/core/internal/agent-execution"
import {
  createSubagentExecutionId,
  createSubagentRunId,
  dispatchQueuedSubagentRuns,
} from "@sixb/core/internal/agents"
import type {
  ConversationAgentRunRecord,
  ExecutionRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { type JSONSchema7, jsonSchema, type ToolSet, tool } from "ai"
import { NEVER_ABORTED_SIGNAL } from "./abort"
import type { AgentWorkerContext, AgentWorkerHost } from "./types"

const MAX_ACTIVE_SUBAGENTS = 4
const MAX_WAITED_SUBAGENTS = 4
const WAIT_POLL_MS = 250

type ModelsDevCatalog = Pick<
  typeof import("./models-dev/catalog"),
  "getModelsDevCatalogModel" | "resolveModelsDevProviderId"
>

export interface SpawnSubagentInput {
  readonly key: string
  readonly task: string
  readonly model?: LanguageModelRef
  readonly reasoning?: AgentReasoningLevel
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
  readonly status: "succeeded" | "failed" | "cancelled"
  readonly text?: string
  readonly files?: readonly FileRef[]
  readonly error?: { readonly code: string; readonly message: string }
}

/** Run-scoped boundary used by the main Agent's framework-owned delegation tools. */
export class SubagentCoordinator {
  private readonly models: LanguageModelCatalog

  constructor(
    private readonly host: AgentWorkerHost,
    private readonly context: AgentWorkerContext,
    private readonly parentRun: ConversationAgentRunRecord,
    private readonly parentExecution: ExecutionRecord,
    private readonly modelsDev: ModelsDevCatalog
  ) {
    const models = host.definitions.models?.language
    if (!models) {
      throw new Error("[SixbAgentWorker] Subagent delegation requires a language model catalog.")
    }
    this.models = models
  }

  createTools(): ToolSet {
    return {
      spawn_agent: tool({
        description: [
          "Start an isolated child agent and return immediately.",
          "Use a short, stable key for the same logical delegation so retries cannot duplicate work.",
          renderSubagentModelGuide(this.models, this.modelsDev),
          "Prefer the default model unless another configured model is clearly better suited. For simple or parallel tasks, prefer a lower-cost model; reserve higher-cost models for work whose complexity justifies them. Runtime speed is not known, so do not infer it from model names.",
          "Omit model to use the project default.",
          `At most ${MAX_ACTIVE_SUBAGENTS} child agents may be active for this run.`,
        ].join("\n"),
        inputSchema: jsonSchema<SpawnSubagentInput>(spawnInputSchema(this.models)),
        execute: (input, options) => this.spawn(input, options.abortSignal ?? NEVER_ABORTED_SIGNAL),
      }),
      wait_agent: tool({
        description:
          "Wait for previously spawned child agents and return their final text, files, or failure. Pass every run id whose result is needed.",
        inputSchema: jsonSchema<WaitForSubagentsInput>(WAIT_INPUT_SCHEMA),
        execute: (input, options) => this.wait(input, options.abortSignal ?? NEVER_ABORTED_SIGNAL),
      }),
    }
  }

  async spawn(input: SpawnSubagentInput, signal: AbortSignal): Promise<SpawnSubagentOutput> {
    signal.throwIfAborted()
    const key = requireNonEmpty("spawn_agent", input.key, "key", 128)
    const task = requireNonEmpty("spawn_agent", input.task, "task")
    const model = this.resolveModel(input.model)
    const runId = createSubagentRunId(this.parentRun.id, key)
    const executionId = createSubagentExecutionId(runId)
    const execution = createInheritedAgentExecutionRecord({
      id: executionId,
      parent: this.parentExecution,
      runId,
    })
    const spec = {
      model: { provider: model.provider, modelId: model.modelId },
      task,
      toolNames: this.host.definitions.tools.list().map((definition) => definition.name),
      maxSteps: this.context.defaultMaxSteps,
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    }

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
          maxActiveChildren: MAX_ACTIVE_SUBAGENTS,
        })
      })
    } catch (error) {
      throw publicSpawnError(error, key)
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

  async wait(
    input: WaitForSubagentsInput,
    signal: AbortSignal
  ): Promise<{ readonly results: readonly WaitedSubagentResult[] }> {
    const runIds = normalizeRunIds(input.runIds)
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
      if (children.every(isTerminalSubagent)) {
        return { results: children.map(waitedResult) }
      }
      await waitDelay(WAIT_POLL_MS, signal)
    }
  }

  private resolveModel(ref: LanguageModelRef | undefined) {
    if (ref === undefined) return this.models.default
    const model = this.models.getByRef(ref)
    if (model) return model
    const available = this.models.list().map(formatModelRef).join(", ")
    throw new AgentToolPublicError(
      `[SixbAgentWorker] Language model ${formatModelRef(ref)} is not configured for this project. ` +
        `Use one of: ${available}. Omit model to use the project default.`
    )
  }
}

export function renderSubagentModelGuide(
  models: LanguageModelCatalog,
  modelsDev: ModelsDevCatalog
): string {
  const entries = models.list().map((model) => {
    const providerId = modelsDev.resolveModelsDevProviderId(model.provider)
    const metadata =
      providerId === undefined
        ? undefined
        : modelsDev.getModelsDevCatalogModel(providerId, model.modelId)
    const details: string[] = []
    if (sameModel(model, models.default)) details.push("default")
    if (metadata?.pricing) {
      details.push(
        `base input ${formatUsdNanos(metadata.pricing.input)} / output ${formatUsdNanos(metadata.pricing.output)} per 1M tokens`
      )
    }
    if (metadata?.limits) {
      details.push(`context ${formatTokenCount(metadata.limits.context)} tokens`)
    }
    if (!metadata?.pricing && !metadata?.limits) details.push("metadata unavailable")

    return `- ${formatModelRef(model)} (${details.join("; ")})`
  })

  return ["Available models (Models.dev base reference metadata when available):", ...entries].join(
    "\n"
  )
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

function formatUsdNanos(value: string): string {
  const nanos = BigInt(value)
  const whole = nanos / 1_000_000_000n
  const remainder = nanos % 1_000_000_000n
  if (remainder === 0n) return `$${whole}`

  const fraction = remainder.toString().padStart(9, "0").replace(/0+$/, "")
  return `$${whole}.${fraction}`
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${formatScaled(value, 1_000_000)}M`
  if (value >= 1_000) return `${formatScaled(value, 1_000)}k`
  return String(value)
}

function formatScaled(value: number, scale: number): string {
  return (Math.round((value / scale) * 100) / 100).toString()
}

function spawnInputSchema(models: LanguageModelCatalog): JSONSchema7 {
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
        description:
          "Copy one exact model reference from the available models. Keep provider and modelId unchanged, including any '/' inside modelId. Omit to use the project default.",
        // Keep each pair together: independent enums would also admit unconfigured bindings.
        anyOf: models.list().map(({ provider, modelId }) => ({
          type: "object",
          properties: {
            provider: { type: "string", enum: [provider] },
            modelId: { type: "string", enum: [modelId] },
          },
          required: ["provider", "modelId"],
          additionalProperties: false,
        })),
      },
      reasoning: { type: "string", enum: [...AGENT_REASONING_LEVELS] },
    },
    required: ["key", "task"],
    additionalProperties: false,
  }
}

const WAIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    runIds: {
      type: "array",
      minItems: 1,
      maxItems: MAX_WAITED_SUBAGENTS,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
  },
  required: ["runIds"],
  additionalProperties: false,
} as const satisfies JSONSchema7

function normalizeRunIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WAITED_SUBAGENTS) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] wait_agent requires between 1 and ${MAX_WAITED_SUBAGENTS} child run ids.`
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

function publicSpawnError(error: unknown, key: string): unknown {
  if (!(error instanceof AgentStorageError)) return error
  switch (error.code) {
    case "active_child_limit":
      return new AgentToolPublicError(
        `[SixbAgentWorker] The current Agent run already has ${MAX_ACTIVE_SUBAGENTS} active children. Wait for one before spawning another.`
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

function waitedResult(
  run: SubagentRunRecord & { readonly status: "succeeded" | "failed" | "cancelled" }
): WaitedSubagentResult {
  return {
    runId: run.id,
    status: run.status,
    ...(run.result?.text ? { text: run.result.text } : {}),
    ...(run.result?.files && run.result.files.length > 0 ? { files: run.result.files } : {}),
    ...(run.error === undefined
      ? {}
      : { error: { code: run.error.code, message: run.error.message } }),
  }
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
