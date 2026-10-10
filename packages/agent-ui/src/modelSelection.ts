import type { ModelReasoningLevel } from "@sixb/core/models"
import type { LanguageModel } from "./types"

/**
 * The explicit choice remembered in the browser, and what a message asks the server for. Without
 * `model`, the reasoning applies to the project's default model.
 */
export interface ModelPreference {
  readonly model?: Pick<LanguageModel, "provider" | "modelId">
  readonly reasoning?: ModelReasoningLevel
}

/** What the composer shows and what the next message asks the server for. */
export interface ResolvedModelSelection {
  readonly model?: LanguageModel
  readonly reasoning?: ModelReasoningLevel
  /** `undefined` while the user follows the project defaults: the server resolves them. */
  readonly request?: ModelPreference
}

export function defaultLanguageModel(models: readonly LanguageModel[]): LanguageModel | undefined {
  return models.find((model) => model.isDefault) ?? models[0]
}

/** The level the server applies when a message selects this model without a reasoning. */
export function defaultReasoningLevel(model: LanguageModel): ModelReasoningLevel | undefined {
  if (model.defaultReasoning && model.reasoningLevels.includes(model.defaultReasoning)) {
    return model.defaultReasoning
  }
  return model.reasoningLevels[0]
}

/**
 * Apply a stored preference to the current catalog. A preference only records explicit choices:
 * without one the request stays empty, and a reasoning the user never chose is left to the server
 * so project default changes still reach them. A reasoning chosen without a model stays with
 * whichever model is the project default. A preference the catalog no longer supports falls back
 * the same way.
 */
export function resolveModelSelection(
  models: readonly LanguageModel[],
  preference: ModelPreference | null
): ResolvedModelSelection {
  const chosen = preference?.model
  const preferred = chosen
    ? models.find((model) => model.provider === chosen.provider && model.modelId === chosen.modelId)
    : undefined
  const model = preferred ?? defaultLanguageModel(models)
  if (!model) return {}

  const reasoningModel = chosen ? preferred : model
  const reasoning =
    reasoningModel &&
    preference?.reasoning &&
    reasoningModel.reasoningLevels.includes(preference.reasoning)
      ? preference.reasoning
      : undefined
  const request: ModelPreference | undefined = preferred
    ? {
        model: { provider: preferred.provider, modelId: preferred.modelId },
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    : reasoning === undefined
      ? undefined
      : { reasoning }
  return {
    model,
    reasoning: reasoning ?? defaultReasoningLevel(model),
    ...(request === undefined ? {} : { request }),
  }
}

/** Choosing an effort keeps the chosen model, if any: it never pins today's default model. */
export function preferenceWithReasoning(
  selection: ResolvedModelSelection,
  reasoning: ModelReasoningLevel
): ModelPreference {
  const model = selection.request?.model
  return { ...(model ? { model } : {}), reasoning }
}

/** Back to the model's default effort; with no chosen model, back to no preference at all. */
export function preferenceWithoutReasoning(
  selection: ResolvedModelSelection
): ModelPreference | null {
  const model = selection.request?.model
  return model ? { model } : null
}
