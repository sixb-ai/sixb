import type { AgentDefinition } from "@sixb/core"
import {
  type ModelMessage,
  type Output,
  type StreamTextOnErrorCallback,
  type StreamTextResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai"
import type { AiModelCallRecorder } from "./model-call-recorder"

export const FINAL_AGENT_LOOP_STEP_INSTRUCTION = [
  "Provide the best possible final answer from the context available.",
  "This is the final step, so do not call tools or defer the answer.",
  "If the task cannot be completed from the available context, state the limitation clearly instead of inventing information.",
].join(" ")

export interface RunAgentLoopInput {
  readonly agent: AgentDefinition
  readonly system: string
  readonly messages: ModelMessage[]
  readonly tools: ToolSet
  readonly maxSteps: number
  readonly usageRecorder: AiModelCallRecorder
  readonly abortSignal: AbortSignal
  readonly onError?: StreamTextOnErrorCallback
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
    model: input.agent.model,
    ...(input.agent.reasoning === undefined ? {} : { reasoning: input.agent.reasoning }),
    ...(input.agent.providerOptions === undefined
      ? {}
      : { providerOptions: input.agent.providerOptions }),
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps),
    prepareStep: (options) => {
      input.usageRecorder.prepareStep()

      // If the step is not the last one, allow tools to be used.
      if (options.stepNumber !== input.maxSteps - 1) return undefined

      // If the step is the last one, disable tools.
      return {
        activeTools: [],
        messages: [
          ...options.messages,
          { role: "user" as const, content: FINAL_AGENT_LOOP_STEP_INSTRUCTION },
        ],
      }
    },
    onLanguageModelCallEnd: input.usageRecorder.onLanguageModelCallEnd,
    ...(input.onError === undefined ? {} : { onError: input.onError }),
    abortSignal: input.abortSignal,
  })
}
