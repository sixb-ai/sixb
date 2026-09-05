import type { JsonObject, JsonValue } from "../json"
import type { ModelReasoning } from "./language-model"
import type {
  ModelAssistantPart,
  ModelToolCallPart,
  ModelToolResultPart,
  ProviderData,
} from "./messages"
import type { ModelCallCost, ModelReportedCost } from "./pricing"

export interface ModelRoute {
  /** Provider selected by a routing gateway, when it differs from the provider being called. */
  readonly providerId?: string
  readonly modelId?: string
}

export type ModelFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "pause"
  | "error"
  | "other"
  | "unknown"

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly uncachedInputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly cacheWrite5mInputTokens?: number
  readonly cacheWrite1hInputTokens?: number
  readonly textOutputTokens?: number
  readonly reasoningOutputTokens?: number
  readonly raw?: JsonObject
}

export type LanguageModelStreamEvent =
  | { readonly type: "stream-start" }
  | {
      readonly type: "response-metadata"
      readonly id?: string
      readonly modelId?: string
    }
  | { readonly type: "text-start"; readonly id: string; readonly providerData?: ProviderData }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string; readonly providerData?: ProviderData }
  | {
      readonly type: "reasoning-start"
      readonly id: string
      readonly providerData?: ProviderData
    }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string; readonly providerData?: ProviderData }
  | {
      readonly type: "tool-input-start"
      readonly id: string
      readonly toolName: string
      readonly providerData?: ProviderData
      readonly providerExecuted?: boolean
      readonly dynamic?: boolean
    }
  | { readonly type: "tool-input-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "tool-input-end"; readonly id: string; readonly providerData?: ProviderData }
  | {
      readonly type: "tool-call"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: string
      readonly providerData?: ProviderData
      readonly providerExecuted?: boolean
      readonly dynamic?: boolean
    }
  | {
      readonly type: "tool-result"
      readonly toolCallId: string
      readonly toolName: string
      readonly output: JsonValue
      readonly isError?: boolean
      readonly providerData?: ProviderData
      readonly providerExecuted?: boolean
      readonly dynamic?: boolean
    }
  | {
      readonly type: "provider-state"
      readonly providerId: string
      readonly data: JsonValue
    }
  | {
      readonly type: "finish"
      readonly finishReason: ModelFinishReason
      readonly rawFinishReason?: string
      readonly usage: ModelUsage
      readonly providerData?: ProviderData
      readonly reportedCost?: ModelReportedCost
      readonly route?: ModelRoute
    }
  | { readonly type: "error"; readonly error: unknown }

export type ModelUiChunk =
  | { readonly type: "start-step" }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string }
  | {
      readonly type: "tool-input-start"
      readonly toolCallId: string
      readonly toolName: string
    }
  | {
      readonly type: "tool-input-delta"
      readonly toolCallId: string
      readonly toolName: string
      readonly inputTextDelta: string
    }
  | {
      readonly type: "tool-input-available"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: JsonValue
    }
  | {
      readonly type: "tool-input-error"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: JsonValue
      readonly errorText: string
    }
  | {
      readonly type: "tool-output-available"
      readonly toolCallId: string
      readonly toolName: string
      readonly output: JsonValue
    }
  | {
      readonly type: "tool-output-error"
      readonly toolCallId: string
      readonly toolName: string
      readonly errorText: string
    }
  | { readonly type: "error"; readonly errorText: string }

export interface ModelCallEndEvent {
  readonly callId: string
  readonly providerId: string
  readonly modelId: string
  readonly responseId: string
  readonly responseModelId?: string
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly requestedReasoning?: ModelReasoning
  readonly route?: ModelRoute
}

export interface ModelStep {
  readonly content: readonly (ModelAssistantPart | ModelToolResultPart)[]
  readonly finishReason: ModelFinishReason
  readonly rawFinishReason?: string
  readonly usage: ModelUsage
  readonly responseId: string
  readonly responseModelId?: string
  readonly cost: ModelCallCost
  readonly route?: ModelRoute
}

export interface ModelLoopPartial {
  readonly content: readonly (ModelAssistantPart | ModelToolCallPart | ModelToolResultPart)[]
}
