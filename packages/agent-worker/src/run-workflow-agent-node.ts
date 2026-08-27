import type { AgentDefinition, AgentMessagePart, SchemaOrRef, ValueType } from "@sixb/core"
import {
  buildAgentSystemPrompt,
  buildWorkflowOutputFinalizerPrompt,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import {
  type AgentStepDefinition,
  snapshotWorkflowAgentStepOutput,
  validateWorkflowAgentStepOutput,
  type WorkflowIOSnapshot,
} from "@sixb/core/internal/workflows"
import { type AgentRunFinishReason, coerceAgentRunFinishReason } from "@sixb/core/storage"
import { generateText, jsonSchema, type ModelMessage, NoObjectGeneratedError, Output } from "ai"
import { type AiSdkTraceStep, agentTraceFromAiSdkSteps } from "./ai-sdk-adapters"
import type { AiModelCallRecorder } from "./model-call-recorder"
import { runAgentLoop } from "./run-agent-loop"
import type { AgentTurnContext } from "./types"

const WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS = 2

export interface RunWorkflowAgentNodeInput {
  readonly context: AgentTurnContext
  readonly agent: AgentDefinition
  readonly agentStep: AgentStepDefinition
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeRunId: string
  readonly prompt: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly usageRecorder: AiModelCallRecorder
  readonly signal: AbortSignal
}

export interface WorkflowAgentNodeResult {
  readonly output: WorkflowIOSnapshot
  readonly modelId: string
  readonly finishReason: NonNullable<ReturnType<typeof coerceAgentRunFinishReason>>
  readonly trace: readonly AgentMessagePart[]
}

export type WorkflowAgentFailurePhase = "agent-loop" | "structured-finalizer"

/** Carries best-effort debug context across the workflow node's terminal error boundary. */
export class WorkflowAgentNodeExecutionError extends Error {
  readonly phase: WorkflowAgentFailurePhase
  readonly finishReason?: AgentRunFinishReason
  readonly trace: readonly AgentMessagePart[]

  constructor(input: {
    readonly phase: WorkflowAgentFailurePhase
    readonly finishReason?: AgentRunFinishReason
    readonly trace: readonly AgentMessagePart[]
    readonly cause: unknown
  }) {
    super("Workflow agent node execution failed.", { cause: input.cause })
    this.name = "WorkflowAgentNodeExecutionError"
    this.phase = input.phase
    this.finishReason = input.finishReason
    this.trace = input.trace
  }
}

export async function runWorkflowAgentNode(
  input: RunWorkflowAgentNodeInput
): Promise<WorkflowAgentNodeResult> {
  const maxSteps = input.agent.loop?.stopWhen?.maxSteps ?? input.context.defaultMaxSteps
  const rawSchema = schemaRecordToJsonSchema({
    shape: input.agentStep.output as Readonly<Record<string, SchemaOrRef>>,
    valueTypesById: input.valueTypesById,
  })
  const schema = jsonSchema<Record<string, unknown>>(
    rawSchema as Parameters<typeof jsonSchema>[0],
    {
      validate(value) {
        try {
          const validated = validateWorkflowAgentStepOutput({
            workflowId: input.workflowId,
            agentStep: input.agentStep,
            value,
            valueTypesById: input.valueTypesById,
          })
          return { success: true, value: { ...validated } }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }
        }
      },
    }
  )

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), input.context.turnTimeoutMs)
  const abortSignal = AbortSignal.any([input.signal, timeout.signal])
  const completedSteps: AiSdkTraceStep[] = []
  const traceDetails = {
    agentId: input.agent.id,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeRunId: input.nodeRunId,
  }
  let phase: WorkflowAgentFailurePhase = "agent-loop"
  let finishReason: AgentRunFinishReason | undefined
  try {
    let researchError: unknown
    const research = runAgentLoop({
      agent: input.agent,
      system: buildAgentSystemPrompt({
        instructions: input.agent.instructions,
        addendum: input.context.systemAddendum,
        mode: "workflow",
      }),
      messages: [{ role: "user", content: input.prompt }],
      tools: input.context.tools,
      maxSteps,
      usageRecorder: input.usageRecorder,
      abortSignal,
      onError: ({ error }) => {
        researchError ??= error
      },
      onStepEnd: (step) => {
        completedSteps.push(step)
      },
    })

    await research.consumeStream({
      onError(error) {
        researchError = error
      },
    })
    input.usageRecorder.assertHealthy()
    if (researchError !== undefined) throw researchError

    const researchText = await research.text
    finishReason = coerceAgentRunFinishReason(await research.finishReason) ?? "unknown"
    if (researchText.trim().length === 0) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Workflow agent '${input.agent.id}' produced no final answer to structure.`,
        { details: traceDetails }
      )
    }

    phase = "structured-finalizer"
    let finalizerMessages: ModelMessage[] = [
      {
        role: "user",
        content: `Original workflow request:\n${input.prompt}`,
      },
      { role: "assistant", content: researchText },
      {
        role: "user",
        content: "Convert the final agent answer into the required workflow output.",
      },
    ]
    let structuredValue: Record<string, unknown> | undefined
    for (let attempt = 1; attempt <= WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS; attempt += 1) {
      try {
        const finalization = await generateText({
          model: input.agent.model,
          ...(input.agent.providerOptions === undefined
            ? {}
            : { providerOptions: input.agent.providerOptions }),
          system: buildWorkflowOutputFinalizerPrompt({
            instructions: input.agent.instructions,
          }),
          messages: finalizerMessages,
          output: Output.object({ schema, name: input.agentStep.id }),
          prepareStep: input.usageRecorder.prepareStep,
          onLanguageModelCallEnd: input.usageRecorder.onLanguageModelCallEnd,
          abortSignal,
        })

        // A final-step callback failure has no later `prepareStep` invocation to surface it.
        input.usageRecorder.assertHealthy()
        structuredValue = finalization.output
        break
      } catch (error) {
        input.usageRecorder.assertHealthy()
        const canRetry =
          attempt < WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS &&
          NoObjectGeneratedError.isInstance(error)
        if (!canRetry) throw error

        finalizerMessages = [
          ...finalizerMessages,
          ...(error.text === undefined
            ? []
            : ([{ role: "assistant", content: error.text }] satisfies ModelMessage[])),
          {
            role: "user",
            content: [
              "The previous response did not satisfy the workflow output schema.",
              "Correct the structure and types using only the same request and final agent answer.",
            ].join(" "),
          },
        ]
      }
    }

    if (structuredValue === undefined) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow output finalization for agent '${input.agent.id}' ended without a value.`,
        { details: traceDetails }
      )
    }

    const output = snapshotWorkflowAgentStepOutput({
      workflowId: input.workflowId,
      agentStep: input.agentStep,
      value: structuredValue,
      valueTypesById: input.valueTypesById,
    })
    return {
      output,
      modelId: input.agent.model.modelId,
      finishReason,
      trace: agentTraceFromAiSdkSteps(completedSteps, traceDetails),
    }
  } catch (cause) {
    throw new WorkflowAgentNodeExecutionError({
      phase,
      finishReason,
      trace: agentTraceFromAiSdkSteps(completedSteps, traceDetails),
      cause,
    })
  } finally {
    clearTimeout(timer)
  }
}
