import type { AgentDefinition, AgentMessage } from "@sixb/core"
import type { ModelLoopResult, RunModelLoopInput } from "@sixb/core/internal/agents"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type { LanguageModel, ModelMessage, ModelTool } from "@sixb/core/models"

declare const model: LanguageModel
declare const agent: AgentDefinition
declare const messages: readonly AgentMessage[]
declare const tools: readonly ModelTool[]
declare const signal: AbortSignal

const modelMessages: readonly ModelMessage[] = toModelMessages(messages)
const _modelLoop = runModelLoop({
  model,
  messages: [{ role: "system", content: agent.instructions }, ...modelMessages],
  tools,
  reasoning: agent.reasoning,
  maxSteps: agent.loop?.stopWhen?.maxSteps ?? 100,
  signal,
})

void _modelLoop

const input = { model, messages: modelMessages, tools, maxSteps: 1, signal }
const _text: Promise<ModelLoopResult<string>> = runModelLoop(input)
const _structured: Promise<ModelLoopResult<number>> = runModelLoop({
  ...input,
  output: { name: "count", schema: { type: "number" }, validate: () => 42 },
})
// Regression proof: restore optional output for all TOutput; these directives become unused.
// @ts-expect-error Non-text output requires a validator.
runModelLoop<number>(input)
// @ts-expect-error Even a string literal output must be established by a validator.
runModelLoop<"exact">(input)
// @ts-expect-error Input annotations must enforce the same contract as the function.
const _invalid: RunModelLoopInput<number> = input
void [_text, _structured, _invalid]
