import type { InferSchemaOrRef, SchemaOrRef } from "../ontology"
import type { ModelFinishReason, ModelUsage } from "./events"
import type { LanguageModel, ModelReasoning } from "./language-model"
import type { ModelMessage } from "./messages"
import type { ModelCallCost } from "./pricing"

export type LanguageModelOutputShape = Readonly<Record<string, SchemaOrRef>>

export type InferLanguageModelOutput<TShape extends LanguageModelOutputShape> =
  string extends keyof TShape
    ? Record<string, unknown>
    : { -readonly [K in keyof TShape]: InferSchemaOrRef<TShape[K]> }

export type LanguageModelGenerateInput<
  TShape extends LanguageModelOutputShape | undefined = undefined,
> = {
  readonly instructions?: string
  readonly model?: LanguageModel
  readonly output?: TShape
  readonly maxOutputTokens?: number
  readonly reasoning?: ModelReasoning
  readonly caching?: "auto" | "off"
  readonly signal?: AbortSignal
} & (undefined extends TShape ? unknown : { readonly output: TShape }) &
  (
    | { readonly prompt: string; readonly messages?: never }
    | { readonly messages: readonly ModelMessage[]; readonly prompt?: never }
  )

export interface LanguageModelGenerateResult<TOutput = string> {
  readonly output: TOutput
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
  readonly finishReason: ModelFinishReason
  readonly callId: string
}

export interface LanguageModelsRuntime {
  generate<const TShape extends LanguageModelOutputShape | undefined = undefined>(
    input: LanguageModelGenerateInput<TShape>
  ): Promise<
    LanguageModelGenerateResult<
      TShape extends LanguageModelOutputShape ? InferLanguageModelOutput<TShape> : string
    >
  >
}

export interface ModelsRuntime {
  readonly language: LanguageModelsRuntime
}
