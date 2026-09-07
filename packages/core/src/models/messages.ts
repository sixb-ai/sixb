import type { JsonValue } from "../json"

/** Opaque, JSON-safe provider state. Each provider reads only its own key. */
export type ProviderData = Readonly<Record<string, JsonValue>>

interface ModelPartBase {
  readonly providerData?: ProviderData
}

export interface ModelTextPart extends ModelPartBase {
  readonly type: "text"
  readonly text: string
}

export interface ModelReasoningPart extends ModelPartBase {
  readonly type: "reasoning"
  readonly text: string
}

export interface ModelFilePart extends ModelPartBase {
  readonly type: "file"
  readonly data: URL
  readonly filename?: string
  readonly mediaType: string
}

export interface ModelToolCallPart extends ModelPartBase {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: JsonValue
  readonly providerExecuted?: boolean
  readonly dynamic?: boolean
}

export type ModelToolOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: JsonValue }
  | { readonly type: "error-text"; readonly value: string }
  | { readonly type: "error-json"; readonly value: JsonValue }

export interface ModelToolResultPart extends ModelPartBase {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly toolName: string
  readonly output: ModelToolOutput
  /** Original durable tool output when the model-facing output is a projection. */
  readonly originalOutput?: JsonValue
  readonly providerExecuted?: boolean
  readonly dynamic?: boolean
}

/** Ordered replay state with no honest portable content representation. */
export interface ModelProviderStatePart {
  readonly type: "provider-state"
  readonly providerId: string
  readonly data: JsonValue
}

export type ModelAssistantPart =
  | ModelTextPart
  | ModelReasoningPart
  | ModelToolCallPart
  | ModelToolResultPart
  | ModelProviderStatePart

export type ModelMessage =
  | {
      readonly role: "system"
      readonly content: string
      readonly providerData?: ProviderData
    }
  | {
      readonly role: "user"
      readonly content: readonly (ModelTextPart | ModelFilePart)[]
    }
  | { readonly role: "assistant"; readonly content: readonly ModelAssistantPart[] }
  | { readonly role: "tool"; readonly content: readonly ModelToolResultPart[] }
