import type { InferSchemaOrRef, SchemaOrRef } from "../ontology"
import type { AudioModelsRuntime } from "./audio/types"
import type { ModelCallsRuntime } from "./calls"
import type { LanguageModelTier } from "./catalog"
import type { DecisionModelsRuntime } from "./decision/types"
import type { ModelFinishReason, ModelUsage } from "./events"
import type { ImageModelsRuntime } from "./image/types"
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
  /** A model runs as given; a tier runs that tier's model from `models.language`. */
  readonly model?: LanguageModel | LanguageModelTier
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
  /**
   * Whether this execution may call the models: always for project code and the Agent, and for a
   * user or service account granted `can.run(project.models)`.
   */
  canRun(): boolean
  readonly audio: AudioModelsRuntime
  readonly language: LanguageModelsRuntime
  readonly decision: DecisionModelsRuntime
  readonly image: ImageModelsRuntime
  /** What past calls produced, as visible as the runs that made them. */
  readonly calls: ModelCallsRuntime
}
