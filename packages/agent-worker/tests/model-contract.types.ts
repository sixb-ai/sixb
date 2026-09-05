import type { AgentDefinition, AgentMessage } from "@sixb/core"
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
  maxSteps: agent.loop?.stopWhen?.maxSteps ?? 25,
  signal,
})

void _modelLoop
