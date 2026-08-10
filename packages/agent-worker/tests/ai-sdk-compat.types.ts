/**
 * Type-only contract between Sixb's `ai`-free message types and the AI SDK shapes the worker
 * actually feeds. This file is never executed; it fails the build if the contract drifts.
 */

import type { LanguageModelV4 } from "@ai-sdk/provider"
import type { AgentInboundUiMessage, AgentMessage } from "@sixb/core"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { AgentRunUsage, AiModelCallUsageInput } from "@sixb/core/storage"
import type {
  generateText,
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  streamText,
  UIMessage,
} from "ai"
import {
  agentRunUsageFromAiSdk,
  agentTraceFromAiSdkSteps,
  aiModelCallUsageFromAiSdk,
} from "../src/ai-sdk-adapters"

// A real `UIMessage` must assign to `fromAiSdk`'s inbound shape *without a cast* — this is the
// safety net at the SDK boundary and the reason the worker can pass `responseMessage` straight in.
declare const sdkMessage: UIMessage
const _inbound: AgentInboundUiMessage = sdkMessage

// `toModelMessages` is core's mirror of `convertToModelMessages`. Its output is fed to
// `streamText({ messages })` via a single boundary cast in `run-agent-turn.ts`; the only gap is
// `providerOptions`, typed wider as `JsonValue` in core (it cannot depend on `ai`). This locks the
// cast as a width-only relaxation, not a structural lie.
declare const history: readonly AgentMessage[]
const _model: ModelMessage[] = toModelMessages(history) as ModelMessage[]

// Agent-level reasoning is a first-class AI SDK streamText setting, not provider-specific metadata.
declare const sdkModel: LanguageModelV4
const _streamTextOptions: Parameters<typeof streamText>[0] = {
  model: sdkModel,
  prompt: "hello",
  reasoning: "medium",
  providerOptions: { openai: { reasoningSummary: "detailed" } },
  prepareStep: () => undefined,
  onLanguageModelCallEnd(event) {
    const callId: string = event.callId
    const providerId: string = event.provider
    const requestedModelId: string = event.modelId
    const responseId: string = event.responseId
    const usage: AiModelCallUsageInput = aiModelCallUsageFromAiSdk(event.usage)
    const rawUsage = event.usage.raw
    void callId
    void providerId
    void requestedModelId
    void responseId
    void usage
    void rawUsage
  },
}

// Workflow generateText calls use the same lifecycle contract as conversation streams.
const _generateTextOptions: Parameters<typeof generateText>[0] = {
  model: sdkModel,
  prompt: "hello",
  prepareStep: () => undefined,
  onLanguageModelCallEnd(event) {
    const callId: string = event.callId
    const providerId: string = event.provider
    const requestedModelId: string = event.modelId
    const responseId: string = event.responseId
    const usage: AiModelCallUsageInput = aiModelCallUsageFromAiSdk(event.usage)
    const rawUsage = event.usage.raw
    void callId
    void providerId
    void requestedModelId
    void responseId
    void usage
    void rawUsage
  },
}

// A real final StepResult and LanguageModelUsage must cross the worker adapter without a cast.
declare const sdkSteps: readonly StepResult<Record<string, never>>[]
declare const sdkUsage: LanguageModelUsage
const _trace = agentTraceFromAiSdkSteps(sdkSteps)
const _usage: AgentRunUsage | undefined = agentRunUsageFromAiSdk(sdkUsage)

void _inbound
void _model
void _streamTextOptions
void _generateTextOptions
void _trace
void _usage
