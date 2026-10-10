import { RuntimeError } from "../runtime/errors"
import {
  type AudioModelCatalog,
  type AudioModelCatalogInput,
  createAudioCatalog,
} from "./audio/catalog"
import { indexModelBindings } from "./catalog-index"
import { createDecisionCatalog, type DecisionModelCatalog } from "./decision/catalog"
import type { DecisionModel } from "./decision/types"
import {
  defineLanguageModel,
  type LanguageModelDefinition,
  type ModelDefinition,
} from "./definitions"
import { assertEmbeddingModel, type EmbeddingModel } from "./embedding-model"
import {
  type LanguageModel,
  MODEL_REASONING_LEVELS,
  type ModelReasoningLevel,
  modelReasoningSupportIssue,
} from "./language-model"
import { assertRerankingModel, type RerankingModel } from "./reranking-model"

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

export interface RerankingModelEntry extends ModelRef {
  readonly model: RerankingModel
}

export interface RerankingModelCatalog {
  list(): readonly RerankingModelEntry[]
  getByRef(ref: ModelRef): RerankingModelEntry | null
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
  /** Reasoning applied when a caller selects this model without choosing one. */
  readonly reasoning?: ModelReasoningLevel
}

/** A language model configured with project defaults. A bare model has none. */
export interface LanguageModelEntryInput {
  readonly model: LanguageModel
  /**
   * Reasoning applied whenever this model is used without an explicit choice: chat turns, AI
   * workflow steps, and direct generation. Must be supported by the model.
   */
  readonly reasoning?: ModelReasoningLevel
}

/** Models a project allows Sixb to use, organized by technical model kind. */
export interface ModelCatalog {
  readonly audio?: AudioModelCatalog
  readonly language?: LanguageModelCatalog
  readonly decision?: DecisionModelCatalog
  readonly embedding: EmbeddingModelCatalog
  readonly reranking?: RerankingModelCatalog
}

export interface ModelCatalogInput {
  readonly audio?: AudioModelCatalogInput
  /** Ordered; the first entry is the project default. */
  readonly language?: readonly (LanguageModel | LanguageModelEntryInput)[]
  /** Ordered; the first entry is the project default decision model. */
  readonly decision?: readonly DecisionModel[]
  readonly embedding?: readonly EmbeddingModel[]
  /** Available rerankers; no default model and no automatic activation. */
  readonly reranking?: readonly RerankingModel[]
}

// Only statically required inputs make their corresponding catalogs required.
type ConfiguredModelKinds<TInput> = {
  [Kind in keyof ModelCatalog]-?: [TInput] extends [Record<Kind, readonly unknown[]>] ? Kind : never
}[keyof ModelCatalog]

export type ModelCatalogFor<TInput extends ModelCatalogInput> = ModelCatalog &
  Required<Pick<ModelCatalog, ConfiguredModelKinds<TInput>>> &
  ([TInput] extends [{ readonly audio: { readonly transcription: readonly unknown[] } }]
    ? {
        readonly audio: AudioModelCatalog & {
          readonly transcription: NonNullable<AudioModelCatalog["transcription"]>
        }
      }
    : unknown)

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
  const audio = createAudioCatalog(input.audio)
  const reranking = createRerankingCatalog(input.reranking)

  if (
    !language &&
    !decision &&
    !audio &&
    embedding.list().length === 0 &&
    !reranking?.list().length
  ) {
    throw new RuntimeError(
      "[Sixb] Configure at least one language, embedding, decision, audio or reranking model."
    )
  }

  return Object.freeze({ language, embedding, decision, audio, reranking })
}

function createRerankingCatalog(
  models: readonly RerankingModel[] | undefined
): RerankingModelCatalog | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new RuntimeError("[Sixb] models.reranking must be an array of reranking models.")
  }
  return indexModelBindings(models, "reranking", assertRerankingModel)
}

function createLanguageCatalog(
  inputs: readonly (LanguageModel | LanguageModelEntryInput)[] | undefined
): LanguageModelCatalog | undefined {
  if (inputs === undefined) return undefined
  if (!Array.isArray(inputs)) {
    throw new RuntimeError("[Sixb] 'models.language' must be an array of Sixb language models.")
  }

  const entries = inputs.map(languageModelEntryInput)
  const index = indexModelBindings(
    entries.map((entry) => entry.model),
    "language",
    (model, position) => {
      assertLanguageModel(model, position)
      assertDefaultReasoning(model, entries[position]?.reasoning, position)
    },
    (position): Pick<LanguageModelEntry, "reasoning"> => {
      const reasoning = entries[position]?.reasoning
      return reasoning === undefined ? {} : { reasoning }
    }
  )
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

/** Accept a bare model or `{ model, reasoning }`; the model itself is validated by the index. */
function languageModelEntryInput(input: unknown, index: number): LanguageModelEntryInput {
  if (!isLanguageModelEntryInput(input)) return { model: input as LanguageModel }
  const unknownKey = Object.keys(input).find((key) => key !== "model" && key !== "reasoning")
  if (unknownKey !== undefined) {
    throw invalidLanguageModel(index, `unknown option '${unknownKey}'`)
  }
  const reasoning: unknown = input.reasoning
  if (
    reasoning !== undefined &&
    !(MODEL_REASONING_LEVELS as readonly unknown[]).includes(reasoning)
  ) {
    throw invalidLanguageModel(
      index,
      `expected 'reasoning' to be one of: ${MODEL_REASONING_LEVELS.join(", ")}`
    )
  }
  return input
}

// A model binding carries `stream`; an entry wraps one under `model`.
function isLanguageModelEntryInput(input: unknown): input is LanguageModelEntryInput {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "model" in input &&
    typeof (input as { readonly stream?: unknown }).stream !== "function"
  )
}

// Capabilities known without catalog I/O. Unknown support is accepted: providers fall back to their
// default when a resolved model turns out not to support the level.
function assertDefaultReasoning(
  model: LanguageModel,
  reasoning: ModelReasoningLevel | undefined,
  index: number
): void {
  const issue = modelReasoningSupportIssue(model.definition.capabilities.reasoning, reasoning)
  if (issue !== undefined) {
    throw invalidLanguageModel(index, `default reasoning '${reasoning}' cannot be used: ${issue}`)
  }
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
