import type { AgentMessagePart, SchemaOrRef, ValueType } from "@sixb/core"
import { runModelLoop } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import type { AiModelCallRecorder } from "@sixb/core/internal/model-execution"
import { schemaRecordToJsonSchema } from "@sixb/core/internal/ontology"
import {
  type AgentStepDefinition,
  snapshotWorkflowAgentStepOutput,
  validateWorkflowAgentStepOutput,
  type WorkflowIOSnapshot,
} from "@sixb/core/internal/workflows"
import type { JsonObject, ModelMessage, ModelStep } from "@sixb/core/models"
import { StructuredOutputError } from "@sixb/core/models"
import { type AgentRunFinishReason, coerceAgentRunFinishReason } from "@sixb/core/storage"
import {
  DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
  renderWorkflowOutputFinalizerPrompt,
} from "./agent-prompt"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { agentTraceFromModelSteps } from "./model-adapters"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { AgentTurnContext } from "./types"

const WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS = 2

export interface RunWorkflowAgentNodeInput {
  readonly context: AgentTurnContext
  readonly agentStepId: string
  readonly plan: ResolvedAgentExecutionPlan
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
  const maxSteps = input.plan.maxSteps
  const outputSchema = schemaRecordToJsonSchema({
    shape: input.agentStep.output as Readonly<Record<string, SchemaOrRef>>,
    valueTypesById: input.valueTypesById,
  }) as JsonObject
  const validateOutput = (value: unknown): Record<string, unknown> => ({
    ...validateWorkflowAgentStepOutput({
      workflowId: input.workflowId,
      agentStep: input.agentStep,
      value,
      valueTypesById: input.valueTypesById,
    }),
  })

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), input.context.turnTimeoutMs)
  const sandboxReadiness = monitorSandboxReadiness(input.context.sandboxReady)
  const abortSignal = AbortSignal.any([input.signal, timeout.signal, sandboxReadiness.signal])
  const completedSteps: ModelStep[] = []
  const traceDetails = {
    agentStepId: input.agentStepId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeRunId: input.nodeRunId,
  }
  let phase: WorkflowAgentFailurePhase = "agent-loop"
  let finishReason: AgentRunFinishReason | undefined
  try {
    const research = await runModelLoop({
      model: input.usageRecorder.wrapModel(input.plan.model),
      messages: [
        {
          role: "system",
          content: input.context.systemPrompt,
        },
        { role: "user", content: [{ type: "text", text: input.prompt }] },
      ],
      tools: input.context.tools,
      ...(input.plan.reasoning === undefined ? {} : { reasoning: input.plan.reasoning }),
      maxSteps,
      finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
      ...(input.context.prepareStep === undefined
        ? {}
        : { prepareStep: input.context.prepareStep }),
      signal: abortSignal,
      onModelCallEnd: input.usageRecorder.onModelCallEnd,
      onStepEnd: (step) => {
        completedSteps.push(step)
      },
    })
    input.usageRecorder.assertHealthy()
    sandboxReadiness.throwIfFailed()
    if (research.status === "aborted") {
      throw abortSignal.reason ?? new DOMException("The workflow agent was aborted.", "AbortError")
    }

    const researchText = research.output
    finishReason = coerceAgentRunFinishReason(research.finishReason) ?? "unknown"
    if (researchText.trim().length === 0) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Workflow agent step '${input.agentStepId}' produced no final answer to structure.`,
        { details: traceDetails }
      )
    }

    phase = "structured-finalizer"
    let finalizerMessages: ModelMessage[] = [
      {
        role: "system",
        content: renderWorkflowOutputFinalizerPrompt({ instructions: input.plan.instructions }),
      },
      {
        role: "user",
        content: [{ type: "text", text: `Original workflow request:\n${input.prompt}` }],
      },
      { role: "assistant", content: [{ type: "text", text: researchText }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Convert the final agent answer into the required workflow output.",
          },
        ],
      },
    ]
    let structuredValue: Record<string, unknown> | undefined
    for (let attempt = 1; attempt <= WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS; attempt += 1) {
      try {
        const finalization = await runModelLoop({
          model: input.usageRecorder.wrapModel(input.plan.model),
          messages: finalizerMessages,
          output: {
            name: input.agentStep.id,
            schema: outputSchema,
            validate: validateOutput,
          },
          maxSteps: 1,
          signal: abortSignal,
          onModelCallEnd: input.usageRecorder.onModelCallEnd,
        })
        input.usageRecorder.assertHealthy()
        if (finalization.status === "aborted") {
          throw (
            abortSignal.reason ?? new DOMException("The workflow agent was aborted.", "AbortError")
          )
        }
        structuredValue = finalization.output
        break
      } catch (error) {
        input.usageRecorder.assertHealthy()
        sandboxReadiness.throwIfFailed()
        if (
          attempt >= WORKFLOW_OUTPUT_FINALIZATION_ATTEMPTS ||
          !(error instanceof StructuredOutputError)
        ) {
          throw error
        }
        finalizerMessages = [
          ...finalizerMessages,
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "The previous response did not satisfy the workflow output schema.",
                  "Correct the structure and types using only the same request and final agent answer.",
                ].join(" "),
              },
            ],
          },
        ]
      }
    }

    if (structuredValue === undefined) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow output finalization for agent step '${input.agentStepId}' ended without a value.`,
        { details: traceDetails }
      )
    }

    sandboxReadiness.throwIfFailed()
    return {
      output: snapshotWorkflowAgentStepOutput({
        workflowId: input.workflowId,
        agentStep: input.agentStep,
        value: structuredValue,
        valueTypesById: input.valueTypesById,
      }),
      modelId: input.plan.model.modelId,
      finishReason,
      trace: agentTraceFromModelSteps(completedSteps, traceDetails),
    }
  } catch (cause) {
    // Prefer the concrete provisioning failure over the abort it causes in either model phase.
    sandboxReadiness.throwIfFailed()
    throw new WorkflowAgentNodeExecutionError({
      phase,
      finishReason,
      trace: agentTraceFromModelSteps(completedSteps, traceDetails),
      cause,
    })
  } finally {
    clearTimeout(timer)
  }
}
