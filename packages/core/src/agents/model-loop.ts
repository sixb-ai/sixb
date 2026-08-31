import { randomUUID } from "node:crypto"
import { assertJsonObject, assertJsonValue, isJsonValue, type JsonValue } from "../json"
import { ModelProviderError, ModelStreamError, StructuredOutputError } from "../models/errors"
import type {
  LanguageModelStreamEvent,
  ModelCallEndEvent,
  ModelFinishReason,
  ModelStep,
  ModelUiChunk,
  ModelUsage,
} from "../models/events"
import type {
  LanguageModel,
  ModelReasoningLevel,
  ModelToolSpecification,
} from "../models/language-model"
import { resolveLanguageModelDefinition } from "../models/language-model"
import type {
  ModelAssistantPart,
  ModelMessage,
  ModelProviderStatePart,
  ModelTextPart,
  ModelToolCallPart,
  ModelToolOutput,
  ModelToolResultPart,
  ProviderData,
} from "../models/messages"
import { type ModelReportedCost, priceModelCall } from "../models/pricing"
import type { ModelOutput, ModelTool } from "../models/tools"

const OUTPUT_TOOL_NAME = "__sixb_submit_output"
const MAX_PROVIDER_DATA_BYTES = 256 * 1024

export interface RunModelLoopInput<TOutput = string> {
  readonly model: LanguageModel
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ModelTool[]
  readonly output?: ModelOutput<TOutput>
  readonly reasoning?: ModelReasoningLevel
  readonly maxSteps: number
  readonly signal: AbortSignal
  /** Reserve the final provider call for a tool-free synthesis response. */
  readonly finalStepInstruction?: string
  readonly prepareStep?: (
    input: PrepareModelStepInput
  ) => PrepareModelStepResult | undefined | Promise<PrepareModelStepResult | undefined>
  readonly onEvent?: (event: ModelUiChunk) => void | Promise<void>
  readonly onModelCallEnd?: (event: ModelCallEndEvent) => void | Promise<void>
  readonly onStepEnd?: (step: ModelStep) => void | Promise<void>
  readonly generateCallId?: () => string
}

export interface PrepareModelStepInput {
  readonly stepIndex: number
  readonly messages: readonly ModelMessage[]
  readonly model: LanguageModel
  readonly signal: AbortSignal
}

export interface PrepareModelStepResult {
  readonly messages?: readonly ModelMessage[]
}

export type ModelLoopResult<TOutput = string> =
  | {
      readonly status: "completed"
      readonly output: TOutput
      readonly steps: readonly ModelStep[]
      readonly finishReason: ModelFinishReason
    }
  | {
      readonly status: "aborted"
      readonly steps: readonly ModelStep[]
      readonly partialContent: readonly ModelAssistantPart[]
    }

interface CompletedResponse {
  readonly content: readonly ModelAssistantPart[]
  readonly toolCalls: readonly ParsedToolCall[]
  readonly finishReason: ModelFinishReason
  readonly rawFinishReason?: string
  readonly usage: ModelUsage
  readonly responseId?: string
  readonly responseModelId?: string
  readonly projectionError?: Error
  readonly reportedCost?: ModelReportedCost
  readonly route?: import("../models/events").ModelRoute
}

interface ParsedToolCall {
  readonly part: ModelToolCallPart
  readonly inputError?: Error
}

interface ToolExecution {
  readonly result: ModelToolResultPart
}

/**
 * Run a provider-neutral, streaming model/tool loop.
 *
 * One step is exactly one provider call. Lifecycle and stream callbacks are awaited so the caller
 * controls backpressure and can fail closed before another billable call starts.
 */
export async function runModelLoop<TOutput = string>(
  input: RunModelLoopInput<TOutput>
): Promise<ModelLoopResult<TOutput>> {
  assertLoopInput(input)
  const tools = indexTools(input.tools ?? [])
  const toolSpecifications = [...tools.values()].map<ModelToolSpecification>((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
  const messages: ModelMessage[] = [...input.messages]
  const steps: ModelStep[] = []
  const modelDefinition = await resolveLanguageModelDefinition(input.model)
  const nativeStructuredOutput =
    input.output !== undefined && modelDefinition.capabilities.nativeStructuredOutput === true
  const outputToolSpecification: ModelToolSpecification | undefined =
    input.output === undefined || nativeStructuredOutput
      ? undefined
      : {
          name: OUTPUT_TOOL_NAME,
          description:
            input.output.description ??
            "Submit the final structured result after all required investigation is complete.",
          inputSchema: input.output.schema,
        }
  if (outputToolSpecification) toolSpecifications.push(outputToolSpecification)
  const generateCallId = input.generateCallId ?? (() => `model_call_${randomUUID()}`)
  const callIds = new Set<string>()

  for (let stepIndex = 0; stepIndex < input.maxSteps; stepIndex += 1) {
    if (input.signal.aborted) {
      return { status: "aborted", steps, partialContent: [] }
    }
    await input.onEvent?.({ type: "start-step" })

    const prepared = await input.prepareStep?.({
      stepIndex,
      messages,
      model: input.model,
      signal: input.signal,
    })
    let requestMessages = prepared?.messages ?? messages
    let requestTools: readonly ModelToolSpecification[] = toolSpecifications
    if (input.finalStepInstruction !== undefined && stepIndex === input.maxSteps - 1) {
      requestMessages = [
        ...requestMessages,
        { role: "user", content: [{ type: "text", text: input.finalStepInstruction }] },
      ]
      requestTools = outputToolSpecification ? [outputToolSpecification] : []
    }

    const callId = generateCallId()
    if (!callId || callIds.has(callId)) {
      throw new ModelStreamError(`[SixbModels] Model call IDs must be nonempty and unique.`)
    }
    callIds.add(callId)
    const accumulator = new StreamAccumulator(input.onEvent)
    let terminalStreamError: { readonly error: unknown } | undefined
    try {
      const stream = await input.model.stream({
        callId,
        messages: requestMessages,
        tools: requestTools,
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        ...(!nativeStructuredOutput
          ? {}
          : {
              responseFormat: {
                type: "json" as const,
                name: input.output.name,
                ...(input.output.description === undefined
                  ? {}
                  : { description: input.output.description }),
                schema: input.output.schema,
              },
            }),
        signal: input.signal,
      })
      for await (const event of stream.events) {
        await accumulator.accept(event)
      }
    } catch (error) {
      const aborted = input.signal.aborted || isAbortError(error)
      if (accumulator.isFinished()) {
        if (!aborted) terminalStreamError = { error }
      } else if (!aborted) {
        throw error
      } else {
        return {
          status: "aborted",
          steps,
          partialContent: accumulator.partialContent(),
        }
      }
    }

    if (input.signal.aborted && !accumulator.isFinished()) {
      return { status: "aborted", steps, partialContent: accumulator.partialContent() }
    }
    const response = accumulator.complete()
    const responseId = response.responseId ?? `${callId}:response`
    const cost = priceModelCall({
      usage: response.usage,
      ...(modelDefinition.pricing === undefined ? {} : { pricing: modelDefinition.pricing }),
      reported: response.reportedCost,
    })
    await input.onModelCallEnd?.({
      callId,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      responseId,
      ...(response.responseModelId === undefined
        ? {}
        : { responseModelId: response.responseModelId }),
      usage: response.usage,
      definition: modelDefinition,
      cost,
      ...(response.route === undefined ? {} : { route: response.route }),
    })
    if (terminalStreamError) throw terminalStreamError.error
    if (response.projectionError) throw response.projectionError
    if (input.signal.aborted) {
      return { status: "aborted", steps, partialContent: response.content }
    }

    const submissions = response.toolCalls.filter((call) => call.part.toolName === OUTPUT_TOOL_NAME)
    const submitted = submissions[0]
    if (submitted) {
      if (!input.output) {
        throw new ModelStreamError(
          `[SixbModels] Model called reserved tool '${OUTPUT_TOOL_NAME}' without an output schema.`
        )
      }
      if (submitted.inputError) {
        throw new StructuredOutputError(
          `[SixbModels] Structured output was not valid JSON: ${submitted.inputError.message}`,
          { cause: submitted.inputError }
        )
      }
      if (submissions.length !== 1) {
        throw new StructuredOutputError(
          `[SixbModels] Model submitted structured output ${submissions.length} times.`
        )
      }
      if (
        response.toolCalls.some(
          (call) => call.part.toolName !== OUTPUT_TOOL_NAME && call.part.providerExecuted !== true
        )
      ) {
        throw new StructuredOutputError(
          "[SixbModels] Model mixed structured output with local tool calls in one response."
        )
      }
      let output: TOutput
      try {
        output = input.output.validate(submitted.part.input)
      } catch (error) {
        throw new StructuredOutputError("[SixbModels] Structured output validation failed.", {
          cause: error,
        })
      }
      const content = response.content.filter(
        (part) => part.type !== "tool-call" || part.toolName !== OUTPUT_TOOL_NAME
      )
      const step = modelStep(response, responseId, content, cost)
      steps.push(step)
      await input.onStepEnd?.(step)
      return { status: "completed", output, steps, finishReason: response.finishReason }
    }

    const localCalls = response.toolCalls.filter((call) => call.part.providerExecuted !== true)
    if (response.finishReason === "pause" && localCalls.length === 0) {
      const step = modelStep(response, responseId, response.content, cost)
      steps.push(step)
      await input.onStepEnd?.(step)
      messages.push({ role: "assistant", content: response.content })
      if (stepIndex + 1 === input.maxSteps) {
        throw new ModelStreamError(
          "[SixbModels] Model reached the step limit while a provider continuation was pending."
        )
      }
      continue
    }
    if (localCalls.length === 0) {
      const step = modelStep(response, responseId, response.content, cost)
      steps.push(step)
      await input.onStepEnd?.(step)
      if (input.output) {
        const text = response.content
          .filter((part): part is ModelTextPart => part.type === "text")
          .map((part) => part.text)
          .join("")
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch (error) {
          throw new StructuredOutputError("[SixbModels] Model did not produce valid JSON output.", {
            cause: error,
          })
        }
        try {
          return {
            status: "completed",
            output: input.output.validate(raw),
            steps,
            finishReason: response.finishReason,
          }
        } catch (error) {
          throw new StructuredOutputError("[SixbModels] Structured output validation failed.", {
            cause: error,
          })
        }
      }
      const output = response.content
        .filter((part): part is ModelTextPart => part.type === "text")
        .map((part) => part.text)
        .join("") as TOutput
      return { status: "completed", output, steps, finishReason: response.finishReason }
    }

    const executions = await Promise.all(
      localCalls.map((call) => executeToolCall(call, tools, callId, input.signal, input.onEvent))
    )
    const toolResults = executions.map((execution) => execution.result)
    const step = modelStep(response, responseId, [...response.content, ...toolResults], cost)
    steps.push(step)
    await input.onStepEnd?.(step)

    if (input.signal.aborted) {
      return {
        status: "aborted",
        steps,
        partialContent: response.content,
      }
    }

    const assistantContent = response.content.filter(
      (part) => part.type !== "tool-result" || part.providerExecuted === true
    )
    messages.push({ role: "assistant", content: assistantContent })
    messages.push({ role: "tool", content: toolResults })

    if (stepIndex + 1 === input.maxSteps) {
      if (input.output) {
        throw new StructuredOutputError(
          "[SixbModels] Model reached the step limit without structured output."
        )
      }
      const output = response.content
        .filter((part): part is ModelTextPart => part.type === "text")
        .map((part) => part.text)
        .join("") as TOutput
      return { status: "completed", output, steps, finishReason: response.finishReason }
    }
  }

  throw new ModelStreamError("[SixbModels] Model loop exited without a terminal result.")
}

function assertLoopInput(input: RunModelLoopInput<unknown>): void {
  if (!Number.isInteger(input.maxSteps) || input.maxSteps <= 0) {
    throw new TypeError("[SixbModels] maxSteps must be a positive integer.")
  }
  if (!input.model.providerId.trim() || !input.model.modelId.trim()) {
    throw new TypeError("[SixbModels] Model providerId and modelId must not be empty.")
  }
  if (input.output) {
    if (!input.output.name.trim()) {
      throw new TypeError("[SixbModels] Structured output names must not be empty.")
    }
    assertJsonObject(input.output.schema, "structured output schema")
  }
}

function indexTools(tools: readonly ModelTool[]): ReadonlyMap<string, ModelTool> {
  const result = new Map<string, ModelTool>()
  for (const tool of tools) {
    if (!tool.name.trim()) throw new TypeError("[SixbModels] Tool names must not be empty.")
    if (tool.name === OUTPUT_TOOL_NAME) {
      throw new TypeError(`[SixbModels] Tool name '${OUTPUT_TOOL_NAME}' is reserved.`)
    }
    if (result.has(tool.name)) {
      throw new TypeError(`[SixbModels] Duplicate tool name '${tool.name}'.`)
    }
    assertJsonObject(tool.inputSchema, `tool '${tool.name}' input schema`)
    result.set(tool.name, tool)
  }
  return result
}

function modelStep(
  response: CompletedResponse,
  responseId: string,
  content: readonly ModelAssistantPart[],
  cost: import("../models/pricing").ModelCallCost
): ModelStep {
  return {
    content,
    finishReason: response.finishReason,
    ...(response.rawFinishReason === undefined
      ? {}
      : { rawFinishReason: response.rawFinishReason }),
    usage: response.usage,
    responseId,
    ...(response.responseModelId === undefined
      ? {}
      : { responseModelId: response.responseModelId }),
    cost,
    ...(response.route === undefined ? {} : { route: response.route }),
  }
}

async function executeToolCall(
  call: ParsedToolCall,
  tools: ReadonlyMap<string, ModelTool>,
  callId: string,
  signal: AbortSignal,
  onEvent: RunModelLoopInput["onEvent"]
): Promise<ToolExecution> {
  const { part } = call
  if (call.inputError) {
    const errorText = `Tool input is not valid JSON: ${call.inputError.message}`
    await onEvent?.({
      type: "tool-input-error",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      errorText,
    })
    return { result: toolErrorResult(part, errorText) }
  }

  const tool = tools.get(part.toolName)
  if (!tool) {
    const errorText = `Tool '${part.toolName}' is not available.`
    await onEvent?.({
      type: "tool-output-error",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      errorText,
    })
    return { result: toolErrorResult(part, errorText) }
  }

  let parsed: unknown
  try {
    parsed = tool.parseInput(part.input)
  } catch (error) {
    const errorText = error instanceof Error ? error.message : "Tool input validation failed."
    await onEvent?.({
      type: "tool-input-error",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      errorText,
    })
    return { result: toolErrorResult(part, errorText) }
  }

  await onEvent?.({
    type: "tool-input-available",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  })
  try {
    const context = { signal, callId, toolCallId: part.toolCallId }
    const output = await tool.execute(parsed, context)
    assertJsonValue(output, `tool '${part.toolName}' output`)
    await onEvent?.({
      type: "tool-output-available",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output,
    })
    const modelOutput = tool.toModelOutput
      ? await tool.toModelOutput(output, context)
      : modelToolOutput(output)
    validateModelToolOutput(modelOutput, part.toolName)
    return {
      result: {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: modelOutput,
        ...(modelOutputMatchesOriginal(modelOutput, output) ? {} : { originalOutput: output }),
      },
    }
  } catch (error) {
    const errorText = tool.errorText(error)
    await onEvent?.({
      type: "tool-output-error",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      errorText,
    })
    return { result: toolErrorResult(part, errorText) }
  }
}

function validateModelToolOutput(output: ModelToolOutput, toolName: string): void {
  if (output.type === "text" || output.type === "error-text") {
    if (typeof output.value !== "string") {
      throw new TypeError(`[SixbModels] Tool '${toolName}' model output must contain text.`)
    }
    return
  }
  assertJsonValue(output.value, `tool '${toolName}' model output`)
}

function modelOutputMatchesOriginal(output: ModelToolOutput, original: JsonValue): boolean {
  if (output.type === "text") return typeof original === "string" && output.value === original
  if (output.type === "json") return output.value === original
  return false
}

function modelToolOutput(value: JsonValue): ModelToolOutput {
  return typeof value === "string" ? { type: "text", value } : { type: "json", value }
}

function toolErrorResult(part: ModelToolCallPart, errorText: string): ModelToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: { type: "error-text", value: errorText },
  }
}

type MutableTextPart = {
  type: "text"
  text: string
  providerData?: ProviderData
  complete: boolean
}
type MutableReasoningPart = {
  type: "reasoning"
  text: string
  providerData?: ProviderData
  complete: boolean
}
type MutableToolCall = {
  type: "tool-call"
  toolCallId: string
  toolName: string
  inputText: string
  providerData?: ProviderData
  providerExecuted?: boolean
  dynamic?: boolean
  complete: boolean
}
type MutablePart =
  | MutableTextPart
  | MutableReasoningPart
  | MutableToolCall
  | ModelToolResultPart
  | ModelProviderStatePart

class StreamAccumulator {
  private readonly parts: MutablePart[] = []
  private readonly spans = new Map<string, MutableTextPart | MutableReasoningPart>()
  private readonly toolCalls = new Map<string, MutableToolCall>()
  private started = false
  private finished = false
  private finishReason: ModelFinishReason | undefined
  private rawFinishReason: string | undefined
  private usage: ModelUsage = {}
  private responseId: string | undefined
  private responseModelId: string | undefined
  private projectionError: Error | undefined
  private reportedCost: ModelReportedCost | undefined
  private route: import("../models/events").ModelRoute | undefined

  constructor(private readonly onEvent: RunModelLoopInput["onEvent"]) {}

  isFinished(): boolean {
    return this.finished
  }

  async accept(event: LanguageModelStreamEvent): Promise<void> {
    if (this.finished) {
      throw new ModelStreamError(`[SixbModels] Received '${event.type}' after stream finish.`)
    }
    switch (event.type) {
      case "stream-start":
        if (this.started) throw new ModelStreamError("[SixbModels] Duplicate stream-start event.")
        this.started = true
        return
      case "response-metadata":
        this.requireStarted(event.type)
        this.responseId = event.id ?? this.responseId
        this.responseModelId = event.modelId ?? this.responseModelId
        return
      case "text-start":
        await this.startText(event)
        return
      case "text-delta":
        await this.appendText(event, "text")
        return
      case "text-end":
        await this.endText(event, "text")
        return
      case "reasoning-start":
        await this.startReasoning(event)
        return
      case "reasoning-delta":
        await this.appendText(event, "reasoning")
        return
      case "reasoning-end":
        await this.endText(event, "reasoning")
        return
      case "tool-input-start":
        await this.startTool(event)
        return
      case "tool-input-delta":
        await this.appendTool(event)
        return
      case "tool-input-end":
        this.endTool(event)
        return
      case "tool-call":
        await this.completeTool(event)
        return
      case "tool-result":
        this.addProviderToolResult(event)
        return
      case "provider-state":
        if (this.captureProviderState(event.data)) {
          this.parts.push({
            type: "provider-state",
            providerId: event.providerId,
            data: event.data,
          })
        }
        return
      case "finish":
        this.requireStarted(event.type)
        validateUsage(event.usage)
        this.captureProviderData(event.providerData)
        this.finished = true
        this.finishReason = event.finishReason
        this.rawFinishReason = event.rawFinishReason
        this.usage = event.usage
        this.reportedCost = event.reportedCost
        this.route = event.route
        return
      case "error":
        throw event.error instanceof Error
          ? event.error
          : new ModelProviderError("[SixbModels] Provider stream failed.", "unknown", "unknown", {
              cause: event.error,
            })
    }
  }

  complete(): CompletedResponse {
    if (!this.started) throw new ModelStreamError("[SixbModels] Stream did not start.")
    if (!this.finished || !this.finishReason) {
      throw new ModelStreamError("[SixbModels] Stream ended without a finish event.")
    }
    for (const part of this.parts) {
      if ("complete" in part && !part.complete) {
        throw new ModelStreamError(
          `[SixbModels] Stream finished with incomplete ${part.type} content.`
        )
      }
    }
    const parsed = this.parseParts(false)
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      finishReason: this.finishReason,
      ...(this.rawFinishReason === undefined ? {} : { rawFinishReason: this.rawFinishReason }),
      usage: this.usage,
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
      ...(this.responseModelId === undefined ? {} : { responseModelId: this.responseModelId }),
      ...(this.projectionError === undefined ? {} : { projectionError: this.projectionError }),
      ...(this.reportedCost === undefined ? {} : { reportedCost: this.reportedCost }),
      ...(this.route === undefined ? {} : { route: this.route }),
    }
  }

  partialContent(): readonly ModelAssistantPart[] {
    return this.parseParts(true).content
  }

  private parseParts(partial: boolean): {
    readonly content: ModelAssistantPart[]
    readonly toolCalls: ParsedToolCall[]
  } {
    const content: ModelAssistantPart[] = []
    const toolCalls: ParsedToolCall[] = []
    for (const part of this.parts) {
      if (part.type === "text") {
        if ((!partial || part.text.length > 0) && (part.complete || partial)) {
          content.push({
            type: "text",
            text: part.text,
            ...(part.providerData === undefined ? {} : { providerData: part.providerData }),
          })
        }
      } else if (part.type === "reasoning") {
        if (part.complete) {
          content.push({
            type: "reasoning",
            text: part.text,
            ...(part.providerData === undefined ? {} : { providerData: part.providerData }),
          })
        }
      } else if (part.type === "tool-call") {
        if (!part.complete) continue
        let value: JsonValue = null
        let inputError: Error | undefined
        try {
          const parsed: unknown = JSON.parse(part.inputText)
          if (!isJsonValue(parsed)) throw new TypeError("input is not a JSON value")
          value = parsed
        } catch (error) {
          inputError = error instanceof Error ? error : new Error(String(error))
        }
        const call: ModelToolCallPart = {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: value,
          ...(part.providerData === undefined ? {} : { providerData: part.providerData }),
          ...(part.providerExecuted === undefined
            ? {}
            : { providerExecuted: part.providerExecuted }),
          ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
        }
        content.push(call)
        toolCalls.push({ part: call, ...(inputError === undefined ? {} : { inputError }) })
      } else {
        content.push(part)
      }
    }
    return { content, toolCalls }
  }

  private async startText(
    event: Extract<LanguageModelStreamEvent, { type: "text-start" }>
  ): Promise<void> {
    this.requireStarted(event.type)
    this.assertNewSpan(event.id)
    const providerData = this.captureProviderData(event.providerData)
    const part: MutableTextPart = {
      type: "text",
      text: "",
      complete: false,
      ...(providerData === undefined ? {} : { providerData }),
    }
    this.spans.set(event.id, part)
    this.parts.push(part)
    await this.onEvent?.({ type: "text-start", id: event.id })
  }

  private async startReasoning(
    event: Extract<LanguageModelStreamEvent, { type: "reasoning-start" }>
  ): Promise<void> {
    this.requireStarted(event.type)
    this.assertNewSpan(event.id)
    const providerData = this.captureProviderData(event.providerData)
    const part: MutableReasoningPart = {
      type: "reasoning",
      text: "",
      complete: false,
      ...(providerData === undefined ? {} : { providerData }),
    }
    this.spans.set(event.id, part)
    this.parts.push(part)
    await this.onEvent?.({ type: "reasoning-start", id: event.id })
  }

  private async appendText(
    event: Extract<LanguageModelStreamEvent, { type: "text-delta" | "reasoning-delta" }>,
    expected: "text" | "reasoning"
  ): Promise<void> {
    const part = this.spans.get(event.id)
    if (!part || part.type !== expected || part.complete) {
      throw new ModelStreamError(
        `[SixbModels] ${event.type} references unopened ${expected} span '${event.id}'.`
      )
    }
    part.text += event.delta
    await this.onEvent?.({ type: event.type, id: event.id, delta: event.delta })
  }

  private async endText(
    event: Extract<LanguageModelStreamEvent, { type: "text-end" | "reasoning-end" }>,
    expected: "text" | "reasoning"
  ): Promise<void> {
    const part = this.spans.get(event.id)
    if (!part || part.type !== expected || part.complete) {
      throw new ModelStreamError(
        `[SixbModels] ${event.type} references unopened ${expected} span '${event.id}'.`
      )
    }
    part.providerData = mergeProviderData(
      part.providerData,
      this.captureProviderData(event.providerData)
    )
    part.complete = true
    this.spans.delete(event.id)
    await this.onEvent?.({ type: event.type, id: event.id })
  }

  private async startTool(
    event: Extract<LanguageModelStreamEvent, { type: "tool-input-start" }>
  ): Promise<void> {
    this.requireStarted(event.type)
    if (!event.id || !event.toolName) {
      throw new ModelStreamError("[SixbModels] Tool calls require nonempty IDs and names.")
    }
    if (this.toolCalls.has(event.id)) {
      throw new ModelStreamError(`[SixbModels] Duplicate tool call ID '${event.id}'.`)
    }
    const providerData = this.captureProviderData(event.providerData)
    const part: MutableToolCall = {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.toolName,
      inputText: "",
      complete: false,
      ...(providerData === undefined ? {} : { providerData }),
      ...(event.providerExecuted === undefined ? {} : { providerExecuted: event.providerExecuted }),
      ...(event.dynamic === undefined ? {} : { dynamic: event.dynamic }),
    }
    this.toolCalls.set(event.id, part)
    this.parts.push(part)
    await this.onEvent?.({
      type: "tool-input-start",
      toolCallId: event.id,
      toolName: event.toolName,
    })
  }

  private async appendTool(
    event: Extract<LanguageModelStreamEvent, { type: "tool-input-delta" }>
  ): Promise<void> {
    const part = this.toolCalls.get(event.id)
    if (!part || part.complete) {
      throw new ModelStreamError(
        `[SixbModels] tool-input-delta references unopened tool call '${event.id}'.`
      )
    }
    part.inputText += event.delta
    await this.onEvent?.({
      type: "tool-input-delta",
      toolCallId: event.id,
      toolName: part.toolName,
      inputTextDelta: event.delta,
    })
  }

  private endTool(event: Extract<LanguageModelStreamEvent, { type: "tool-input-end" }>): void {
    const part = this.toolCalls.get(event.id)
    if (!part || part.complete) {
      throw new ModelStreamError(
        `[SixbModels] tool-input-end references unopened tool call '${event.id}'.`
      )
    }
    part.providerData = mergeProviderData(
      part.providerData,
      this.captureProviderData(event.providerData)
    )
    part.complete = true
  }

  private async completeTool(
    event: Extract<LanguageModelStreamEvent, { type: "tool-call" }>
  ): Promise<void> {
    await this.startTool({
      type: "tool-input-start",
      id: event.toolCallId,
      toolName: event.toolName,
      ...(event.providerData === undefined ? {} : { providerData: event.providerData }),
      ...(event.providerExecuted === undefined ? {} : { providerExecuted: event.providerExecuted }),
      ...(event.dynamic === undefined ? {} : { dynamic: event.dynamic }),
    })
    const part = this.toolCalls.get(event.toolCallId)
    if (!part) throw new ModelStreamError("[SixbModels] Failed to index completed tool call.")
    part.inputText = event.input
    part.complete = true
  }

  private addProviderToolResult(
    event: Extract<LanguageModelStreamEvent, { type: "tool-result" }>
  ): void {
    if (!this.captureJsonValue(event.output, "provider tool result")) return
    const providerData = this.captureProviderData(event.providerData)
    this.parts.push({
      type: "tool-result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.isError
        ? { type: "error-json", value: event.output }
        : modelToolOutput(event.output),
      providerExecuted: event.providerExecuted ?? true,
      ...(event.dynamic === undefined ? {} : { dynamic: event.dynamic }),
      ...(providerData === undefined ? {} : { providerData }),
    })
  }

  private captureProviderData(data: ProviderData | undefined): ProviderData | undefined {
    if (data === undefined) return undefined
    try {
      validateProviderData(data)
      return data
    } catch (error) {
      this.captureProjectionError(error)
      return undefined
    }
  }

  private captureProviderState(value: unknown): value is JsonValue {
    if (!this.captureJsonValue(value, "provider state")) return false
    if (JSON.stringify(value).length > MAX_PROVIDER_DATA_BYTES) {
      this.captureProjectionError(
        new ModelStreamError(
          `[SixbModels] Provider state exceeds the ${MAX_PROVIDER_DATA_BYTES}-byte response limit.`
        )
      )
      return false
    }
    return true
  }

  private captureJsonValue(value: unknown, label: string): value is JsonValue {
    try {
      assertJsonValue(value, label)
      return true
    } catch (error) {
      this.captureProjectionError(error)
      return false
    }
  }

  private captureProjectionError(error: unknown): void {
    this.projectionError ??= error instanceof Error ? error : new Error(String(error))
  }

  private requireStarted(type: string): void {
    if (!this.started) {
      throw new ModelStreamError(`[SixbModels] Received '${type}' before stream-start.`)
    }
  }

  private assertNewSpan(id: string): void {
    if (!id) throw new ModelStreamError("[SixbModels] Content span IDs must not be empty.")
    if (this.spans.has(id)) {
      throw new ModelStreamError(`[SixbModels] Duplicate open content span '${id}'.`)
    }
  }
}

function validateUsage(usage: ModelUsage): void {
  for (const [key, value] of Object.entries(usage)) {
    if (key === "raw") {
      if (value !== undefined) assertJsonValue(value, "raw model usage")
      continue
    }
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ModelStreamError(`[SixbModels] Usage field '${key}' must be a nonnegative integer.`)
    }
  }
}

function validateProviderData(data: ProviderData | undefined): void {
  if (data === undefined) return
  assertJsonValue(data, "provider data")
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("[SixbModels] provider data must be a JSON object.")
  }
  if (JSON.stringify(data).length > MAX_PROVIDER_DATA_BYTES) {
    throw new ModelStreamError(
      `[SixbModels] Provider data exceeds the ${MAX_PROVIDER_DATA_BYTES}-byte response limit.`
    )
  }
}

function mergeProviderData(
  first: ProviderData | undefined,
  second: ProviderData | undefined
): ProviderData | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return { ...first, ...second }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}
