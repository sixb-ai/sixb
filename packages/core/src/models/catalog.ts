import {
  defineLanguageModel,
  type LanguageModelDefinition,
  type ModelDefinition,
} from "./definitions"

export interface ModelCatalog<TDefinition extends ModelDefinition = ModelDefinition> {
  get(modelId: string): Promise<TDefinition | undefined>
  list(): Promise<readonly TDefinition[]>
}

export type LanguageModelCatalog = ModelCatalog<LanguageModelDefinition>

/** Build an immutable catalog without requiring generated registry code or runtime JSON files. */
export function createLanguageModelCatalog(
  definitions: readonly LanguageModelDefinition[]
): LanguageModelCatalog {
  const byId = new Map<string, LanguageModelDefinition>()
  for (const input of definitions) {
    const definition = defineLanguageModel(input)
    if (byId.has(definition.modelId)) {
      throw new TypeError(
        `[Sixb] Duplicate model '${definition.modelId}' in provider '${definition.providerId}'.`
      )
    }
    byId.set(definition.modelId, definition)
  }
  const values = Object.freeze([...byId.values()])
  return Object.freeze({
    async get(modelId: string) {
      return byId.get(modelId)
    },
    async list() {
      return values
    },
  })
}
