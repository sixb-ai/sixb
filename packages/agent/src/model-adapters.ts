import type { AgentMessagePart, JsonValue } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import {
  type AgentToolCall,
  type AgentToolCallFile,
  type AgentToolCallResult,
  AgentToolResultValidationError,
  type AgentToolSpec,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import type {
  ModelAssistantPart,
  ModelStep,
  ModelTool,
  ModelToolResultPart,
} from "@sixb/core/models"
import { AgentToolExecutionError, AgentToolOutputError } from "./errors"
import type { AgentToolModelOutput } from "./tools/result-output"

export type AgentErrorDetails =
  | { readonly threadId: string; readonly runId: string }
  | { readonly parentRunId: string; readonly runId: string }
  | { readonly workflowId: string; readonly agentStepId: string; readonly runId: string }
  | {
      readonly agentStepId: string
      readonly workflowId: string
      readonly workflowRunId: string
      readonly nodeRunId: string
    }

/** How a run calls a project tool: through its session, or for a workflow step in the worker. */
export type AgentToolCaller = (
  call: AgentToolCall,
  options: { readonly signal: AbortSignal }
) => Promise<AgentToolCallResult>

interface ProjectModelToolsInput {
  readonly specs: readonly AgentToolSpec[]
  readonly runId: string
  readonly callTool: AgentToolCaller
  /** Copy the files a call stored into the sandbox, before the model reads its output. */
  readonly installFiles: (input: {
    readonly toolName: string
    readonly files: readonly AgentToolCallFile[]
    readonly signal: AbortSignal
  }) => Promise<void>
  readonly toolResultToModelOutput: (input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) => AgentToolModelOutput | Promise<AgentToolModelOutput>
  readonly errorDetails?: AgentErrorDetails
}

/**
 * The project's tools as the model is offered them. A call runs where the project is, through
 * `callTool`, which checks its input against the tool's schema; the files it stored are copied into
 * the sandbox before the model reads its output.
 */
export function projectModelTools(input: ProjectModelToolsInput): readonly ModelTool[] {
  const names = new Set<string>()
  return input.specs.map((spec) => {
    if (names.has(spec.name)) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgent] Agent run '${input.runId}' has duplicate selected tool name '${spec.name}'.`,
        input.errorDetails === undefined ? undefined : { details: input.errorDetails }
      )
    }
    names.add(spec.name)
    return projectModelTool(spec, input)
  })
}

function projectModelTool(
  spec: AgentToolSpec,
  context: Omit<ProjectModelToolsInput, "specs">
): ModelTool<Readonly<Record<string, unknown>>> {
  return {
    ...spec,
    parseInput(value) {
      // The tool's schema is checked where it runs; the loop hands over a JSON object.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`[SixbAgent] Agent tool '${spec.name}' input must be a JSON object.`)
      }
      return value as Readonly<Record<string, unknown>>
    },
    async execute(toolInput, { signal, toolCallId }) {
      let result: AgentToolCallResult
      try {
        result = await context.callTool(
          { toolName: spec.name, toolCallId, input: toolInput },
          { signal }
        )
      } catch (error) {
        if (error instanceof AgentToolResultValidationError) {
          throw new AgentToolOutputError(spec.name, error.reason, { cause: error })
        }
        if (error instanceof AgentToolPublicError) throw error
        throw new AgentToolExecutionError(spec.name, { cause: error })
      }
      await context.installFiles({ toolName: spec.name, files: result.files, signal })
      return result.output
    },
    toModelOutput(output, { signal, toolCallId }) {
      return context.toolResultToModelOutput({ output, signal, toolCallId })
    },
    errorText: agentToolErrorText,
  }
}

type ToolOutcome =
  | { readonly state: "output-available"; readonly output: JsonValue }
  | { readonly state: "output-error"; readonly errorText: string }

/** Project validated model-loop steps into Sixb's durable trace contract. */
export function agentTraceFromModelSteps(
  steps: readonly ModelStep[],
  errorDetails?: AgentErrorDetails
): readonly AgentMessagePart[] {
  return steps.flatMap((step) => tracePartsFromModelContent(step.content, errorDetails))
}

/** Convert an aborted model loop, retaining only coherent content from its in-flight step. */
export function agentTraceFromPartialModelLoop(
  steps: readonly ModelStep[],
  partialContent: readonly ModelAssistantPart[],
  errorDetails?: AgentErrorDetails
): readonly AgentMessagePart[] {
  return [
    ...agentTraceFromModelSteps(steps, errorDetails),
    ...(partialContent.length === 0
      ? []
      : tracePartsFromModelContent(partialContent, errorDetails, "Tool execution was cancelled.")),
  ]
}

function tracePartsFromModelContent(
  content: readonly ModelAssistantPart[],
  errorDetails?: AgentErrorDetails,
  missingToolResultText = "Tool call did not produce a result."
): AgentMessagePart[] {
  const results = new Map(
    content.filter((part) => part.type === "tool-result").map((part) => [part.toolCallId, part])
  )
  return [
    { type: "step-start" },
    ...content.flatMap((part): AgentMessagePart[] => {
      switch (part.type) {
        case "text":
        case "reasoning": {
          return [
            {
              type: part.type,
              text: part.text,
              ...(part.providerData === undefined ? {} : { providerMetadata: part.providerData }),
            },
          ]
        }
        case "provider-state":
          return [
            {
              type: "provider-state",
              providerId: part.providerId,
              data: part.data,
            },
          ]
        case "tool-call": {
          return [
            {
              type: "tool-call",
              ...(part.dynamic === true ? { dynamic: true } : {}),
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              ...(part.providerExecuted === undefined
                ? {}
                : { providerExecuted: part.providerExecuted }),
              ...(part.providerData === undefined ? {} : { providerMetadata: part.providerData }),
              ...toolOutcome(results.get(part.toolCallId), missingToolResultText),
            },
          ]
        }
        case "tool-result":
          return []
        default:
          return assertUnreachableModelPart(part, errorDetails)
      }
    }),
  ]
}

function toolOutcome(
  result: ModelToolResultPart | undefined,
  missingResultText: string
): ToolOutcome {
  if (!result) return { state: "output-error", errorText: missingResultText }
  if (result.originalOutput !== undefined) {
    return { state: "output-available", output: result.originalOutput }
  }
  const { output } = result
  switch (output.type) {
    case "text":
    case "json":
      return { state: "output-available", output: output.value }
    case "error-text":
      return { state: "output-error", errorText: output.value }
    case "error-json":
      return { state: "output-error", errorText: JSON.stringify(output.value) }
  }
}

function assertUnreachableModelPart(part: never, errorDetails?: AgentErrorDetails): never {
  throw createSixbError(
    "internal.unexpected",
    `[SixbAgent] Model trace content '${(part as { type?: unknown }).type}' is not supported.`,
    errorDetails === undefined ? undefined : { details: errorDetails }
  )
}

/** Expose only failures that the tool author explicitly marked as safe for the model and storage. */
export function agentToolErrorText(error: unknown): string {
  return error instanceof AgentToolPublicError ? error.message : "An error occurred."
}
