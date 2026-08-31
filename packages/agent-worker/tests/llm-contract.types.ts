import type { AgentDefinition, AgentMessage } from "@sixb/core"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { LanguageModel, ModelMessage, ModelTool } from "@sixb/llm"
import { runModelLoop } from "@sixb/llm"

declare const model: LanguageModel
declare const agent: AgentDefinition
declare const messages: readonly AgentMessage[]
declare const tools: readonly ModelTool[]
declare const signal: AbortSignal

const modelMessages: readonly ModelMessage[] = toModelMessages(messages)
const _loop = runModelLoop({
  model,
  messages: [{ role: "system", content: agent.instructions }, ...modelMessages],
  tools,
  reasoning: agent.reasoning,
  maxSteps: agent.loop?.stopWhen?.maxSteps ?? 25,
  signal,
})

void _loop
