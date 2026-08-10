import type { AgentDefinition, AgentMessagePart, SchemaOrRef, ValueType } from "@sixb/core"
import { buildAgentSystemPrompt } from "@sixb/core/internal/agents"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import {
  type AgentStepDefinition,
  snapshotWorkflowAgentStepOutput,
  validateWorkflowAgentStepOutput,
  type WorkflowIOSnapshot,
} from "@sixb/core/internal/workflows"
import { coerceAgentRunFinishReason } from "@sixb/core/storage"
import { generateText, jsonSchema, Output, stepCountIs } from "ai"
import { agentTraceFromAiSdkSteps } from "./ai-sdk-adapters"
import type { AiModelCallRecorder } from "./model-call-recorder"
import type { AgentTurnContext } from "./types"

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
  try {
    const result = await generateText({
      model: input.agent.model,
      ...(input.agent.reasoning === undefined ? {} : { reasoning: input.agent.reasoning }),
      ...(input.agent.providerOptions === undefined
        ? {}
        : { providerOptions: input.agent.providerOptions }),
      system: buildAgentSystemPrompt({
        instructions: input.agent.instructions,
        addendum: input.context.systemAddendum,
        mode: "task",
      }),
      prompt: input.prompt,
      tools: input.context.tools,
      stopWhen: stepCountIs(maxSteps),
      output: Output.object({ schema, name: input.agentStep.id }),
      prepareStep: input.usageRecorder.prepareStep,
      onLanguageModelCallEnd: input.usageRecorder.onLanguageModelCallEnd,
      abortSignal: AbortSignal.any([input.signal, timeout.signal]),
    })

    // A final-step callback failure has no later `prepareStep` invocation to surface it.
    input.usageRecorder.assertHealthy()
    const output = snapshotWorkflowAgentStepOutput({
      workflowId: input.workflowId,
      agentStep: input.agentStep,
      value: result.output,
      valueTypesById: input.valueTypesById,
    })
    return {
      output,
      modelId: input.agent.model.modelId,
      finishReason: coerceAgentRunFinishReason(result.finishReason) ?? "unknown",
      trace: agentTraceFromAiSdkSteps(result.steps, {
        agentId: input.agent.id,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeRunId: input.nodeRunId,
      }),
    }
  } finally {
    clearTimeout(timer)
  }
}
