import { createDefinitionCatalog, type DefinitionCatalog } from "../runtime/definitions"
import { RuntimeError } from "../runtime/errors"
import type { LanguageModelDefinition, ModelDefinition } from "./definitions"
import type { LanguageModel } from "./language-model"

/** Provider-owned metadata lookup for models available through that provider. */
export interface ModelDefinitionCatalog<TDefinition extends ModelDefinition = ModelDefinition> {
  get(modelId: string): Promise<TDefinition | undefined>
  list(): Promise<readonly TDefinition[]>
}

export type LanguageModelDefinitionCatalog = ModelDefinitionCatalog<LanguageModelDefinition>

/** One language-model binding configured by the project. */
export interface LanguageModelEntry {
  readonly ref: string
  readonly provider: string
  readonly modelId: string
  readonly model: LanguageModel
}

/** The project's configured language models, with the first entry as the default. */
export interface LanguageModelCatalog extends DefinitionCatalog<LanguageModelEntry> {
  readonly default: LanguageModelEntry
}

/** Models a project allows Sixb to use, organized by model kind. */
export interface ModelCatalog {
  readonly language: LanguageModelCatalog
}

export interface ModelCatalogInput {
  /** Ordered; the first entry is the project default. */
  readonly language: readonly LanguageModel[]
}

/** Identify one provider binding and model selection. */
export function modelRef(model: LanguageModel): string {
  return `${model.providerId}/${model.modelId}`
}

/** Build the immutable project model catalog. Rejects duplicates and an empty catalog. */
export function createModelCatalog(input: ModelCatalogInput): ModelCatalog {
  const byRef = new Map<string, LanguageModelEntry>()

  for (const model of input.language) {
    const ref = modelRef(model)
    if (byRef.has(ref)) {
      throw new RuntimeError(
        `[Sixb] Duplicate language model '${ref}' in 'models'. Each provider and model id pair may be configured once.`
      )
    }
    byRef.set(
      ref,
      Object.freeze({ ref, provider: model.providerId, modelId: model.modelId, model })
    )
  }

  const [defaultEntry] = byRef.values()
  if (defaultEntry === undefined) {
    throw new RuntimeError(
      "[Sixb] 'models.language' needs at least one model. Configure one or omit 'models' from createSixb()."
    )
  }

  return Object.freeze({
    language: Object.freeze({ ...createDefinitionCatalog(byRef), default: defaultEntry }),
  })
}
