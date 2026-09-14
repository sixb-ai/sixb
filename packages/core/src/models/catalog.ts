import { RuntimeError } from "../runtime/errors"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  type ModelDefinition,
} from "./definitions"
import { assertEmbeddingModel, type EmbeddingModel } from "./embedding-model"
import type { LanguageModel } from "./language-model"

/** Stable identity of a configured provider binding. */
export interface ModelRef {
  readonly provider: string
  readonly modelId: string
}

export type LanguageModelRef = ModelRef

export interface EmbeddingModelEntry extends ModelRef {
  readonly model: EmbeddingModel
}

export interface EmbeddingModelCatalog {
  list(): readonly EmbeddingModelEntry[]
  getByRef(ref: ModelRef): EmbeddingModelEntry | null
}

/** The configured language models, with the project default. */
export interface LanguageModelCatalog {
  readonly default: LanguageModelEntry
  list(): readonly LanguageModelEntry[]
  getByRef(ref: LanguageModelRef): LanguageModelEntry | null
}

/**
 * One configured language model.
 *
 * The identity describes the configured binding, not only a vendor model. For example,
 * A gateway binding and a direct provider binding for the same vendor model are distinct because their
 * `provider` values differ.
 */
export interface LanguageModelEntry extends LanguageModelRef {
  readonly model: LanguageModel
}

/** Models a project allows Sixb to use, organized by technical model kind. */
export interface ModelCatalog {
  readonly language?: LanguageModelCatalog
  readonly embedding: EmbeddingModelCatalog
}

export interface ModelCatalogInput {
  /** Ordered; the first entry is the project default. */
  readonly language?: readonly LanguageModel[]
  readonly embedding?: readonly EmbeddingModel[]
}

/** Build the immutable project model catalog. Rejects invalid, duplicate, and empty catalogs. */
export function createModelCatalog(
  input: ModelCatalogInput & { readonly language: readonly LanguageModel[] }
): ModelCatalog & { readonly language: LanguageModelCatalog }
export function createModelCatalog(input: ModelCatalogInput): ModelCatalog
export function createModelCatalog(input: ModelCatalogInput): ModelCatalog {
  if (!input || (input.language !== undefined && !Array.isArray(input.language))) {
    throw new RuntimeError("[Sixb] 'models.language' must be an array of Sixb language models.")
  }

  const entries: LanguageModelEntry[] = []
  const byProvider = new Map<string, Map<string, LanguageModelEntry>>()

  for (const [index, model] of (input.language ?? []).entries()) {
    assertLanguageModel(model, index)

    let byModelId = byProvider.get(model.providerId)
    if (byModelId === undefined) {
      byModelId = new Map()
      byProvider.set(model.providerId, byModelId)
    }
    if (byModelId.has(model.modelId)) {
      throw new RuntimeError(
        `[Sixb] Duplicate language model '${model.providerId}/${model.modelId}' in 'models'. Each provider and model id pair may be configured once.`
      )
    }

    const entry = Object.freeze({
      provider: model.providerId,
      modelId: model.modelId,
      model,
    })
    byModelId.set(model.modelId, entry)
    entries.push(entry)
  }

  const [defaultEntry] = entries
  if (input.language !== undefined && defaultEntry === undefined) {
    throw new RuntimeError(
      "[Sixb] 'models.language' needs at least one model. Configure one or omit 'models' from createSixb()."
    )
  }

  const listed = Object.freeze(entries.slice())
  const language: LanguageModelCatalog | undefined =
    defaultEntry === undefined
      ? undefined
      : Object.freeze({
          default: defaultEntry,
          list: () => listed,
          getByRef: (ref: LanguageModelRef) =>
            byProvider.get(ref.provider)?.get(ref.modelId) ?? null,
        })

  if (input.embedding !== undefined && !Array.isArray(input.embedding)) {
    throw new RuntimeError("[Sixb] models.embedding must be an array of embedding models.")
  }
  const embeddings = [...(input.embedding ?? [])]
  const embeddingByRef = new Map<string, EmbeddingModelEntry>()
  for (const model of embeddings) {
    assertEmbeddingModel(model)
    const key = JSON.stringify([model.providerId, model.modelId])
    if (embeddingByRef.has(key)) throw new RuntimeError(`[Sixb] Duplicate embedding model ${key}`)
    embeddingByRef.set(
      key,
      Object.freeze({ provider: model.providerId, modelId: model.modelId, model })
    )
  }
  if (!language && embeddings.length === 0)
    throw new RuntimeError("[Sixb] Configure at least one language or embedding model.")
  const listedEmbeddings = Object.freeze([...embeddingByRef.values()])
  const embedding: EmbeddingModelCatalog = Object.freeze({
    list: () => listedEmbeddings,
    getByRef: (ref: ModelRef) =>
      embeddingByRef.get(JSON.stringify([ref.provider, ref.modelId])) ?? null,
  })
  return Object.freeze({ language, embedding })
}

function assertLanguageModel(model: unknown, index: number): asserts model is LanguageModel {
  if ((typeof model !== "object" && typeof model !== "function") || model === null) {
    throw invalidLanguageModel(index, "expected a Sixb LanguageModel instance")
  }

  const candidate = model as Record<string, unknown>
  assertModelIdentifier(candidate.providerId, "provider", index)
  assertModelIdentifier(candidate.modelId, "modelId", index)
  if (typeof candidate.stream !== "function") {
    throw invalidLanguageModel(index, "expected 'stream' to be a function")
  }
  try {
    const definition = defineLanguageModel(candidate.definition as LanguageModelDefinition)
    if (
      definition.providerId !== candidate.providerId ||
      definition.modelId !== candidate.modelId
    ) {
      throw new Error("definition identity does not match the binding")
    }
  } catch (error) {
    throw invalidLanguageModel(index, error instanceof Error ? error.message : "invalid definition")
  }
}

function assertModelIdentifier(value: unknown, field: "provider" | "modelId", index: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidLanguageModel(index, `expected '${field}' to be a non-empty string`)
  }
  if (value.trim() !== value) {
    throw invalidLanguageModel(index, `expected '${field}' not to have surrounding whitespace`)
  }
}

function invalidLanguageModel(index: number, detail: string): RuntimeError {
  return new RuntimeError(
    `[Sixb] Invalid language model at 'models.language[${index}]': ${detail}.`
  )
}

/** Provider-owned metadata lookup, independent from the project's configured bindings. */
export interface ModelDefinitionCatalog<TDefinition extends ModelDefinition = ModelDefinition> {
  get(modelId: string): Promise<TDefinition | undefined>
  list(): Promise<readonly TDefinition[]>
}

export type LanguageModelDefinitionCatalog = ModelDefinitionCatalog<LanguageModelDefinition>
