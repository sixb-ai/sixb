import type { AgentDefinition, AgentMessagePart, SchemaOrRef, ValueType } from "@sixb/core"
import { buildAgentSystemPrompt } from "@sixb/core/internal/agents"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import {
  type AgentStepDefinition,
  snapshotWorkflowAgentStepOutput,
  validateWorkflowAgentStepOutput,
  type WorkflowIOSnapshot,
} from "@sixb/core/internal/workflows"
import type { AgentRunUsage } from "@sixb/core/storage"
import { coerceAgentRunFinishReason } from "@sixb/core/storage"
import { generateText, jsonSchema, Output, stepCountIs } from "ai"
import { agentRunUsageFromAiSdk, agentTraceFromAiSdkSteps } from "./ai-sdk-adapters"
import type { AgentTurnContext } from "./types"

export interface RunWorkflowAgentNodeInput {
  readonly context: AgentTurnContext
  readonly agent: AgentDefinition
  readonly agentStep: AgentStepDefinition
  readonly workflowId: string
  readonly prompt: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly signal: AbortSignal
}

export interface WorkflowAgentNodeResult {
  readonly output: WorkflowIOSnapshot
  readonly modelId: string
  readonly finishReason: NonNullable<ReturnType<typeof coerceAgentRunFinishReason>>
  readonly usage?: AgentRunUsage
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
      abortSignal: AbortSignal.any([input.signal, timeout.signal]),
    })

    const output = snapshotWorkflowAgentStepOutput({
      workflowId: input.workflowId,
      agentStep: input.agentStep,
      value: result.output,
      valueTypesById: input.valueTypesById,
    })
    const usage = agentRunUsageFromAiSdk(result.usage)
    return {
      output,
      modelId: input.agent.model.modelId,
      finishReason: coerceAgentRunFinishReason(result.finishReason) ?? "unknown",
      ...(usage ? { usage } : {}),
      trace: agentTraceFromAiSdkSteps(result.steps),
    }
  } finally {
    clearTimeout(timer)
  }
}
