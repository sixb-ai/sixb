import type { ReadonlyJsonArray, ReadonlyJsonObject } from "../../json"
import type { ModelDefinition } from "../definitions"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "../events"
import type { ModelCallCost, ModelCostEstimator, ModelReportedCost } from "../pricing"

/** Text or structured text. Non-text media must be prepared explicitly by the application. */
export type DecisionContent = string | ReadonlyJsonObject | ReadonlyJsonArray

export interface ChoiceQuestion<
  TOptions extends Readonly<Record<string, DecisionContent | null>> = Readonly<
    Record<string, DecisionContent | null>
  >,
> {
  readonly type: "choice"
  readonly instructions: DecisionContent
  readonly options: TOptions
}

export interface ScoreQuestion<
  TLevels extends readonly DecisionContent[] = readonly DecisionContent[],
> {
  readonly type: "score"
  readonly instructions: DecisionContent
  readonly levels: TLevels
}

export interface ProbabilityQuestion {
  readonly type: "probability"
  readonly instructions: DecisionContent
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | ProbabilityQuestion
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>
export type DecisionAnswer<TQuestion extends DecisionQuestion> =
  TQuestion extends ChoiceQuestion<infer TOptions>
    ? {
        choice: `${Extract<keyof TOptions, string | number>}`
        probabilities: { -readonly [K in keyof TOptions]: number }
        confidence?: number
      }
    : TQuestion extends ScoreQuestion
      ? { score: number; probabilities: number[]; confidence?: number }
      : { probability: number }
export type DecisionAnswers<TQuestions extends DecisionQuestions> = {
  -readonly [K in keyof TQuestions]: DecisionAnswer<TQuestions[K]>
}

export interface DecisionModelDefinition extends ModelDefinition {
  readonly kind: "decision"
  readonly capabilities: {
    readonly questions: readonly DecisionQuestion["type"][]
    readonly maxChoices?: number
    readonly maxScoreLevels?: number
    /** Independent decimal rounding of returned scores/probabilities; omitted means strict validation. */
    readonly answerDecimalPlaces?: number
  }
}

export interface DecisionModelRequest {
  readonly input: DecisionContent
  readonly questions: DecisionQuestions
  /** Providers must pass cancellation through to their transport. */
  readonly signal?: AbortSignal
}

export interface DecisionModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface DecisionModelResult extends DecisionModelResponseMetadata {
  /** Decoded answers; Sixb still validates them against the original questions at runtime. */
  readonly output: DecisionAnswers<DecisionQuestions>
}

/** An explicit provider binding; declaring it never triggers inference. */
export interface DecisionModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: DecisionModelDefinition
  readonly costEstimator?: ModelCostEstimator
  /** Resolve and pin optional metadata/pricing before admission, without inference. */
  resolve?(): Promise<DecisionModel>
  evaluate(request: DecisionModelRequest): Promise<DecisionModelResult>
}

export interface DecisionEvaluateInput<TQuestions extends DecisionQuestions> {
  readonly input: DecisionContent
  readonly questions: TQuestions
  readonly model?: DecisionModel
  readonly signal?: AbortSignal
}

export interface DecisionEvaluateResult<TQuestions extends DecisionQuestions> {
  readonly output: DecisionAnswers<TQuestions>
  readonly callId: string
  readonly responseModelId?: string
  readonly usage: ModelUsage
  readonly cost: ModelCallCost
}

export interface DecisionModelsRuntime {
  evaluate<const TQuestions extends DecisionQuestions>(
    input: DecisionEvaluateInput<TQuestions>
  ): Promise<DecisionEvaluateResult<TQuestions>>
}
