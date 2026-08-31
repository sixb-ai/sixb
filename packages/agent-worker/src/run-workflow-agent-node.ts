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
import { type JsonObject, runModelLoop } from "@sixb/llm"
import { agentTraceFromModelSteps } from "./model-adapters"
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

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), input.context.turnTimeoutMs)
  try {
    const signal = AbortSignal.any([input.signal, timeout.signal])
    const result = await runModelLoop({
      model: input.agent.model,
      messages: [
        {
          role: "system",
          content: buildAgentSystemPrompt({
            instructions: input.agent.instructions,
            addendum: input.context.systemAddendum,
            mode: "task",
          }),
        },
        { role: "user", content: [{ type: "text", text: input.prompt }] },
      ],
      tools: input.context.tools,
      reasoning: input.agent.reasoning,
      maxSteps,
      output: {
        name: input.agentStep.id,
        schema: rawSchema as JsonObject,
        validate(value) {
          return validateWorkflowAgentStepOutput({
            workflowId: input.workflowId,
            agentStep: input.agentStep,
            value,
            valueTypesById: input.valueTypesById,
          })
        },
      },
      onModelCallEnd: input.usageRecorder.onModelCallEnd,
      signal,
    })

    input.usageRecorder.assertHealthy()
    if (result.status === "aborted") {
      if (signal.reason instanceof Error) throw signal.reason
      throw new DOMException("The model call was aborted.", "AbortError")
    }
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
      trace: agentTraceFromModelSteps(result.steps, {
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
