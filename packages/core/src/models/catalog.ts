import type { LanguageModelDefinition, ModelDefinition } from "./definitions"

export interface ModelCatalog<TDefinition extends ModelDefinition = ModelDefinition> {
  get(modelId: string): Promise<TDefinition | undefined>
  list(): Promise<readonly TDefinition[]>
}

export type LanguageModelCatalog = ModelCatalog<LanguageModelDefinition>
