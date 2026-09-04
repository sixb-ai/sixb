import {
  type ModelMessage,
  type Output,
  type PrepareStepFunction,
  type StreamTextOnErrorCallback,
  type StreamTextResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai"
import type { AiSdkTraceStep } from "./ai-sdk-adapters"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import type { AiModelCallRecorder } from "./model-call-recorder"

export const FINAL_AGENT_LOOP_STEP_INSTRUCTION = [
  "Provide the best possible final answer from the context available.",
  "This is the final step, so do not call tools or defer the answer.",
  "If the task cannot be completed from the available context, state the limitation clearly instead of inventing information.",
].join(" ")

export interface RunAgentLoopInput {
  readonly plan: ResolvedAgentExecutionPlan
  readonly system: string
  readonly messages: ModelMessage[]
  readonly tools: ToolSet
  readonly usageRecorder: AiModelCallRecorder
  readonly prepareStep?: PrepareStepFunction<ToolSet>
  readonly abortSignal: AbortSignal
  readonly onError?: StreamTextOnErrorCallback
  readonly onStepEnd?: (step: AiSdkTraceStep) => void | Promise<void>
}

/**
 * Run the shared tool-capable Sixb agent loop.
 *
 * The final allowed model step is always reserved for synthesis. Earlier steps may use tools, but
 * the last step receives the complete accumulated context with tools disabled so a bounded run has
 * one chance to return a useful answer instead of ending on a tool call.
 */
export function runAgentLoop(
  input: RunAgentLoopInput
): StreamTextResult<ToolSet, Record<string, unknown>, ReturnType<typeof Output.text>> {
  return streamText({
    model: input.usageRecorder.wrapModel(input.plan.model),
    ...(input.plan.reasoning === undefined ? {} : { reasoning: input.plan.reasoning }),
    ...(input.plan.providerOptions === undefined
      ? {}
      : { providerOptions: input.plan.providerOptions }),
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: stepCountIs(input.plan.maxSteps),
    prepareStep: async (options) => {
      input.usageRecorder.prepareStep()
      const prepared = await input.prepareStep?.(options)

      // If the step is not the last one, allow tools to be used.
      if (options.stepNumber !== input.plan.maxSteps - 1) return prepared

      // If the step is the last one, disable tools.
      return {
        ...prepared,
        activeTools: [],
        messages: [
          ...(prepared?.messages ?? options.messages),
          { role: "user" as const, content: FINAL_AGENT_LOOP_STEP_INSTRUCTION },
        ],
      }
    },
    onLanguageModelCallStart: input.usageRecorder.onLanguageModelCallStart,
    onLanguageModelCallEnd: input.usageRecorder.onLanguageModelCallEnd,
    ...(input.onError === undefined ? {} : { onError: input.onError }),
    ...(input.onStepEnd === undefined ? {} : { onStepEnd: input.onStepEnd }),
    abortSignal: input.abortSignal,
  })
}
