import { isJsonValue, isPlainRecord, type JsonObject, type JsonValue } from "../json"
import type { ModelReasoning } from "./language-model"
import type {
  ModelAssistantPart,
  ModelToolCallPart,
  ModelToolResultPart,
  ProviderData,
} from "./messages"
import type { ModelCallCost, ModelCostEstimate, ModelReportedCost } from "./pricing"

export interface ModelRoute {
  /** Provider selected by a routing gateway, when it differs from the provider being called. */
  readonly providerId?: string
  readonly modelId?: string
}

/** Only identifiers supplied by the provider. Internal call/response fallback IDs never belong here. */
export type ModelProviderIds = {
  readonly requestId?: string
  readonly responseId?: string
  readonly generationId?: string
}

export function normalizeModelProviderIds(value: unknown): ModelProviderIds {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("[Sixb] Provider identifiers must be an object.")
  const result: { requestId?: string; responseId?: string; generationId?: string } = {}
  for (const [key, id] of Object.entries(value)) {
    if (key !== "requestId" && key !== "responseId" && key !== "generationId") continue
    if (id === undefined) continue
    if (typeof id !== "string" || !id.trim())
      throw new TypeError(`[Sixb] Provider ${key} must be nonblank.`)
    result[key] = id
  }
  return Object.freeze(result)
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
  /** Audio content duration in milliseconds, rounded to the nearest millisecond. Not billed duration. */
  readonly audioDurationMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly uncachedInputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly cacheWrite5mInputTokens?: number
  readonly cacheWrite1hInputTokens?: number
  readonly textOutputTokens?: number
  readonly reasoningOutputTokens?: number
  /** Output tokens that encode generated images, within outputTokens. */
  readonly imageOutputTokens?: number
  /** Output tokens that encode generated audio, within outputTokens. */
  readonly audioOutputTokens?: number
  /** Images the call returned. */
  readonly outputImages?: number
  /** Input characters, counted by the provider's own billing rule. */
  readonly inputCharacters?: number
  readonly raw?: JsonObject
}

export type LanguageModelStreamEvent =
  | { readonly type: "stream-start" }
  | {
      readonly type: "response-metadata"
      readonly providerIds?: ModelProviderIds
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
      /**
       * The model's context window, not its output limit, stopped a `length` response: the
       * request left the answer less room than it asked for. A shorter request may answer.
       */
      readonly contextWindowExceeded?: boolean
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

export const MODEL_UI_CHUNK_TYPES = [
  "start-step",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-output-available",
  "tool-output-error",
  "error",
] as const satisfies readonly ModelUiChunk["type"][]

type ChunkFields = Readonly<Record<string, unknown>>

// Keyed by the union itself, so a chunk variant added without its check does not compile.
const MODEL_UI_CHUNK_FIELDS_ARE_VALID: {
  readonly [TType in ModelUiChunk["type"]]: (chunk: ChunkFields) => boolean
} = {
  "start-step": () => true,
  "text-start": hasSpanId,
  "text-delta": (chunk) => hasSpanId(chunk) && typeof chunk.delta === "string",
  "text-end": hasSpanId,
  "reasoning-start": hasSpanId,
  "reasoning-delta": (chunk) => hasSpanId(chunk) && typeof chunk.delta === "string",
  "reasoning-end": hasSpanId,
  "tool-input-start": hasToolCall,
  "tool-input-delta": (chunk) => hasToolCall(chunk) && typeof chunk.inputTextDelta === "string",
  "tool-input-available": (chunk) => hasToolCall(chunk) && hasJson(chunk, "input"),
  "tool-input-error": (chunk) =>
    hasToolCall(chunk) && hasJson(chunk, "input") && typeof chunk.errorText === "string",
  "tool-output-available": (chunk) => hasToolCall(chunk) && hasJson(chunk, "output"),
  "tool-output-error": (chunk) => hasToolCall(chunk) && typeof chunk.errorText === "string",
  error: (chunk) => typeof chunk.errorText === "string",
}

/** A known chunk type with every field it requires. Fields a newer producer adds are allowed. */
export function isModelUiChunk(value: unknown): value is ModelUiChunk {
  if (!isPlainRecord(value) || !isModelUiChunkType(value.type)) return false

  return MODEL_UI_CHUNK_FIELDS_ARE_VALID[value.type](value)
}

function isModelUiChunkType(value: unknown): value is ModelUiChunk["type"] {
  return typeof value === "string" && (MODEL_UI_CHUNK_TYPES as readonly string[]).includes(value)
}

function hasSpanId(chunk: ChunkFields): boolean {
  return typeof chunk.id === "string"
}

function hasToolCall(chunk: ChunkFields): boolean {
  return typeof chunk.toolCallId === "string" && typeof chunk.toolName === "string"
}

function hasJson(chunk: ChunkFields, field: string): boolean {
  return Object.hasOwn(chunk, field) && isJsonValue(chunk[field])
}

export interface ModelCallEndEvent {
  readonly modelKind?: import("./definitions").ModelKind
  readonly providerIds?: ModelProviderIds
  /** Retained independently when the selected display cost is provider-reported. */
  readonly estimate?: ModelCostEstimate
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
