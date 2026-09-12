import { defineLanguageModel } from "./definitions"
import { ModelCatalogUnavailableError } from "./errors"
import type { LanguageModel } from "./language-model"

/** Pin operational metadata once, falling back offline only when the catalog is unavailable. */
export async function resolveLanguageModel(binding: LanguageModel): Promise<LanguageModel> {
  const offline =
    binding.definition.contextWindow !== undefined ||
    binding.definition.maxInputTokens !== undefined
  let model: LanguageModel
  try {
    model = (await binding.resolve?.({ offline })) ?? binding
  } catch (cause) {
    if (offline || !(cause instanceof ModelCatalogUnavailableError)) throw cause
    model = (await binding.resolve?.({ offline: true })) ?? binding
  }
  const definition = defineLanguageModel(model.definition)
  if (
    definition.providerId !== binding.providerId ||
    definition.modelId !== binding.modelId ||
    model.providerId !== binding.providerId ||
    model.modelId !== binding.modelId
  ) {
    throw new TypeError("[SixbModels] Resolved model identity does not match the selected model.")
  }
  return model
}
