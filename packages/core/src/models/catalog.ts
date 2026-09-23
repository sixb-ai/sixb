import { RuntimeError } from "../runtime/errors"
import { indexModelBindings } from "./catalog-index"
import { createDecisionCatalog, type DecisionModelCatalog } from "./decision/catalog"
import type { DecisionModel } from "./decision/types"
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
  readonly decision?: DecisionModelCatalog
  readonly embedding: EmbeddingModelCatalog
}

export interface ModelCatalogInput {
  /** Ordered; the first entry is the project default. */
  readonly language?: readonly LanguageModel[]
  /** Ordered; the first entry is the project default decision model. */
  readonly decision?: readonly DecisionModel[]
  readonly embedding?: readonly EmbeddingModel[]
}

// Only statically required inputs make their corresponding catalogs required.
type ConfiguredModelKinds<TInput> = {
  [Kind in keyof ModelCatalog]-?: [TInput] extends [Record<Kind, readonly unknown[]>] ? Kind : never
}[keyof ModelCatalog]

export type ModelCatalogFor<TInput extends ModelCatalogInput> = ModelCatalog &
  Required<Pick<ModelCatalog, ConfiguredModelKinds<TInput>>>

/** Build an immutable catalog while preserving each family's default and empty-list rules. */
export function createModelCatalog<TInput extends ModelCatalogInput>(
  input: TInput
): ModelCatalogFor<TInput>
export function createModelCatalog(input: ModelCatalogInput): ModelCatalog {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeError("[Sixb] 'models' must be a model catalog configuration.")
  }

  const language = createLanguageCatalog(input.language)
  const embedding = createEmbeddingCatalog(input.embedding)
  const decision = createDecisionCatalog(input.decision)

  if (!language && !decision && embedding.list().length === 0) {
    throw new RuntimeError("[Sixb] Configure at least one language, embedding or decision model.")
  }

  return Object.freeze({ language, embedding, decision })
}

function createLanguageCatalog(
  models: readonly LanguageModel[] | undefined
): LanguageModelCatalog | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new RuntimeError("[Sixb] 'models.language' must be an array of Sixb language models.")
  }

  const index = indexModelBindings(models, "language", assertLanguageModel)
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new RuntimeError(
      "[Sixb] 'models.language' needs at least one model. Configure one or omit 'models.language'."
    )
  }

  return Object.freeze({ ...index, default: defaultEntry })
}

function createEmbeddingCatalog(
  models: readonly EmbeddingModel[] | undefined
): EmbeddingModelCatalog {
  if (models !== undefined && !Array.isArray(models)) {
    throw new RuntimeError("[Sixb] models.embedding must be an array of embedding models.")
  }

  return indexModelBindings(models ?? [], "embedding", assertEmbeddingModel)
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
