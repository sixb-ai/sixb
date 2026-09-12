import { runModelLoop } from "../agents/model-loop"
import { assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ModelCatalog } from "./catalog"
import { ModelProviderError, ModelStreamError, UnsupportedModelFeatureError } from "./errors"
import type { ModelCallEndEvent } from "./events"
import { type ModelExecutionAttempt, registerModelExecutionBinding } from "./execution/binding"
import { requireAccountingCapabilities } from "./execution/model-call-accounting"
import { aiModelCallOutputTokenAllowance } from "./execution/model-call-admission"
import { createAiModelCallLimitController } from "./execution/model-call-limits"
import { AiModelCallRecorder } from "./execution/model-call-recorder"
import { enqueueAiModelCallRecovery } from "./execution/recovery-queue"
import type {
  InferLanguageModelOutput,
  LanguageModelGenerateInput,
  LanguageModelGenerateResult,
  LanguageModelOutputShape,
  ModelsRuntime,
} from "./generation-types"
import { modelReasoningSupportIssue } from "./language-model"
import type { ModelMessage } from "./messages"
import { languageModelOutput } from "./output"
import { resolveLanguageModel } from "./resolve"

export function createModelsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined
): ModelsRuntime {
  let binding: ModelExecutionAttempt | undefined
  let recorder: Promise<AiModelCallRecorder> | undefined

  async function createRecorder(): Promise<AiModelCallRecorder> {
    const storage = {
      ...requireAccountingCapabilities(runtime.storage),
      transaction: runtime.storage.transaction.bind(runtime.storage),
    }
    if (!binding) {
      throw new Error(
        "[SixbModels] Generation requires a bound request or worker execution attempt."
      )
    }
    const { requesterGroupIds } = await ensureExecutionRecord(
      runtime.storage.executions,
      executionRecordInputFromRuntime({
        execution,
        runtimeAuthorization: runtime.runtimeAuthorization,
      })
    )
    return new AiModelCallRecorder({
      storage,
      projectId: runtime.projectId,
      executionId: execution.id,
      attempt: binding.attempt,
      requesterGroupIds,
      limits: createAiModelCallLimitController({
        storage,
        projectId: runtime.projectId,
        requestedBy: execution.requestedBy,
        requesterGroupIds,
      }),
      recoverAiModelCall: (input) => enqueueAiModelCallRecovery(runtime.queues.agents, input),
    })
  }

  function generate<const TShape extends LanguageModelOutputShape | undefined = undefined>(
    input: LanguageModelGenerateInput<TShape>
  ): Promise<
    LanguageModelGenerateResult<
      TShape extends LanguageModelOutputShape ? InferLanguageModelOutput<TShape> : string
    >
  >
  async function generate(
    input: LanguageModelGenerateInput<LanguageModelOutputShape | undefined>
  ): Promise<LanguageModelGenerateResult<unknown>> {
    assertProviderAccess(runtime, execution, "models.language.generate")
    const messages = generationMessages(input)
    if (!binding) {
      throw new Error(
        "[SixbModels] Generation requires a bound request or worker execution attempt."
      )
    }
    const signal = input.signal ? AbortSignal.any([binding.signal, input.signal]) : binding.signal
    signal.throwIfAborted()
    const selected = input.model
      ? catalog
        ? catalog.language.getByRef({
            provider: input.model.providerId,
            modelId: input.model.modelId,
          })?.model
        : input.model
      : catalog?.language.default.model
    if (!selected) {
      throw new Error(
        input.model
          ? `[SixbModels] Model '${input.model.providerId}/${input.model.modelId}' is not configured in models.language.`
          : "[SixbModels] Configure models.language in createSixb() or supply a model to generate()."
      )
    }
    const output =
      input.output === undefined
        ? undefined
        : languageModelOutput(input.output, runtime.ontology.getValueTypesById())
    const model = await resolveLanguageModel(selected)
    const reasoningIssue = modelReasoningSupportIssue(
      model.definition.capabilities.reasoning,
      input.reasoning
    )
    if (reasoningIssue) throw new UnsupportedModelFeatureError(`[SixbModels] ${reasoningIssue}.`)
    if (output && model.definition.capabilities.nativeStructuredOutput === false) {
      throw new UnsupportedModelFeatureError(
        "[SixbModels] Model does not support native structured output."
      )
    }
    const maxOutputTokens = Math.min(
      aiModelCallOutputTokenAllowance(input.maxOutputTokens ?? model.definition.maxOutputTokens),
      model.definition.maxOutputTokens ?? Infinity
    )
    if (typeof input.reasoning === "object" && input.reasoning.budgetTokens >= maxOutputTokens) {
      throw new TypeError("[SixbModels] Output allowance must exceed the reasoning token budget.")
    }
    recorder ??= createRecorder()
    const accounting = await recorder
    accounting.assertHealthy()
    signal.throwIfAborted()
    let event: ModelCallEndEvent | undefined
    const options = {
      model: accounting.wrapModel(model),
      messages,
      maxSteps: 1,
      rejectLocalToolCalls: true,
      maxOutputTokens,
      reasoning: input.reasoning,
      caching: input.caching,
      signal,
      onModelCallEnd: async (completed: ModelCallEndEvent) => {
        await accounting.onModelCallEnd(completed)
        event = completed
      },
    }
    const result = output ? await runModelLoop({ ...options, output }) : await runModelLoop(options)
    if (result.status === "aborted") {
      signal.throwIfAborted()
      throw new DOMException("Model generation aborted", "AbortError")
    }
    if (result.finishReason === "error" || result.finishReason === "content-filter") {
      throw new ModelProviderError(
        `[SixbModels] Generation ended with '${result.finishReason}'.`,
        model.providerId,
        model.modelId
      )
    }
    if (!event)
      throw new ModelStreamError("[SixbModels] Generation completed without accounting metadata.")
    return {
      output: result.output,
      usage: event.usage,
      cost: event.cost,
      callId: event.callId,
      finishReason: result.finishReason,
    }
  }

  const models: ModelsRuntime = {
    language: { generate },
  }
  registerModelExecutionBinding(models, (input) => {
    binding = { attempt: input.attempt, signal: input.signal }
  })
  return models
}

function generationMessages(
  input: LanguageModelGenerateInput<LanguageModelOutputShape | undefined>
): readonly ModelMessage[] {
  if ((input.prompt === undefined) === (input.messages === undefined)) {
    throw new TypeError("[SixbModels] Supply exactly one of prompt or messages.")
  }
  if (input.prompt !== undefined && typeof input.prompt !== "string") {
    throw new TypeError("[SixbModels] prompt must be a string.")
  }
  if (input.messages !== undefined && !Array.isArray(input.messages)) {
    throw new TypeError("[SixbModels] messages must be an array.")
  }
  if (input.instructions !== undefined && typeof input.instructions !== "string") {
    throw new TypeError("[SixbModels] instructions must be a string.")
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)
  ) {
    throw new TypeError("[SixbModels] maxOutputTokens must be a positive safe integer.")
  }
  if (input.caching !== undefined && input.caching !== "auto" && input.caching !== "off") {
    throw new TypeError("[SixbModels] caching must be 'auto' or 'off'.")
  }
  return [
    ...(input.instructions === undefined
      ? []
      : [{ role: "system" as const, content: input.instructions }]),
    ...(input.prompt !== undefined
      ? [{ role: "user" as const, content: [{ type: "text" as const, text: input.prompt }] }]
      : (input.messages ?? [])),
  ]
}
