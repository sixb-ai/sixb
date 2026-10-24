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
import { createImageCatalog, type ImageModelCatalog } from "./image/catalog"
import type { ImageModel } from "./image/types"
import {
  type LanguageModel,
  MODEL_REASONING_LEVELS,
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

/** The cost and strength classes a project can configure language models in. */
export const LANGUAGE_MODEL_TIERS = ["light", "standard", "heavy"] as const

export type LanguageModelTier = (typeof LANGUAGE_MODEL_TIERS)[number]

/** How likely a decision model judged each tier, each from 0 to 1. */
export type LanguageModelTierProbabilities = Readonly<Record<LanguageModelTier, number>>

export function isLanguageModelTier(value: unknown): value is LanguageModelTier {
  return (LANGUAGE_MODEL_TIERS as readonly unknown[]).includes(value)
}

/** The tiers as errors list them: "light, standard or heavy". */
export function formatLanguageModelTiers(): string {
  const last = LANGUAGE_MODEL_TIERS.at(-1)
  return `${LANGUAGE_MODEL_TIERS.slice(0, -1).join(", ")} or ${last}`
}

/** Language models by tier; each takes a model or an ordered list, whose first is the tier's. */
export interface LanguageModelTiers {
  readonly light?: LanguageModel | readonly LanguageModel[]
  /** Its first model is the project default, and stands in for a tier left out. */
  readonly standard: LanguageModel | readonly LanguageModel[]
  readonly heavy?: LanguageModel | readonly LanguageModel[]
}

/** The configured language models, with the project default. */
export interface LanguageModelCatalog {
  readonly default: LanguageModelEntry
  /** The tiers the project configures, in tier order; empty when `models.language` is a list. */
  readonly tiers: readonly LanguageModelTier[]
  /** Configured order; with tiers, light, standard then heavy, each tier in its own order. */
  list(): readonly LanguageModelEntry[]
  getByRef(ref: LanguageModelRef): LanguageModelEntry | null
  /** The tier's first model; a tier left out, or any tier of a list, gives the default. */
  getByTier(tier: LanguageModelTier): LanguageModelEntry
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
  /** The tier the model is configured in; absent when `models.language` is a list. */
  readonly tier?: LanguageModelTier
}

/** Models a project allows Sixb to use, organized by technical model kind. */
export interface ModelCatalog {
  readonly audio?: AudioModelCatalog
  readonly language?: LanguageModelCatalog
  readonly decision?: DecisionModelCatalog
  readonly embedding: EmbeddingModelCatalog
  readonly image?: ImageModelCatalog
  readonly reranking?: RerankingModelCatalog
}

export interface ModelCatalogInput {
  readonly audio?: AudioModelCatalogInput
  /**
   * Ordered, the first entry being the project default; or tiers, whose first `standard` model is
   * the default.
   */
  readonly language?: readonly LanguageModel[] | LanguageModelTiers
  /** Ordered; the first entry is the project default decision model. */
  readonly decision?: readonly DecisionModel[]
  readonly embedding?: readonly EmbeddingModel[]
  /** Ordered; the first entry is the default image model. */
  readonly image?: readonly ImageModel[]
  /** Available rerankers; no default model and no automatic activation. */
  readonly reranking?: readonly RerankingModel[]
}

// Only statically required inputs make their corresponding catalogs required.
type ConfiguredModelKinds<TInput> = {
  [Kind in keyof ModelCatalog]-?: [TInput] extends [
    Record<Kind, readonly unknown[] | LanguageModelTiers>,
  ]
    ? Kind
    : never
}[keyof ModelCatalog]

export type ModelCatalogFor<TInput extends ModelCatalogInput> = ModelCatalog &
  Required<Pick<ModelCatalog, ConfiguredModelKinds<TInput>>> &
  ([TInput] extends [{ readonly audio: { readonly transcription: readonly unknown[] } }]
    ? {
        readonly audio: AudioModelCatalog & {
          readonly transcription: NonNullable<AudioModelCatalog["transcription"]>
        }
      }
    : unknown) &
  ([TInput] extends [{ readonly audio: { readonly speech: readonly unknown[] } }]
    ? {
        readonly audio: AudioModelCatalog & {
          readonly speech: NonNullable<AudioModelCatalog["speech"]>
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
  const image = createImageCatalog(input.image)
  const reranking = createRerankingCatalog(input.reranking)

  if (
    !language &&
    !decision &&
    !audio &&
    !image &&
    embedding.list().length === 0 &&
    !reranking?.list().length
  ) {
    throw new RuntimeError(
      "[Sixb] Configure at least one language, embedding, decision, audio, image or reranking model."
    )
  }

  return Object.freeze({ language, embedding, decision, audio, image, reranking })
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
  input: ModelCatalogInput["language"]
): LanguageModelCatalog | undefined {
  if (input === undefined) return undefined

  const configured = configuredLanguageModels(input)
  const index = indexModelBindings(
    configured.map(({ model }) => model),
    "language",
    (model, position) => {
      const { path } = configured[position]
      assertValidLanguageModel(model, (detail) => invalidLanguageModel(path, detail))
    },
    (position): Pick<LanguageModelEntry, "tier"> => {
      const { tier } = configured[position]
      return tier === undefined ? {} : { tier }
    }
  )
  const entries = index.list()

  const defaultEntry = entries.find((entry) => entry.tier === "standard") ?? entries[0]
  if (!defaultEntry) {
    throw new RuntimeError(
      "[Sixb] 'models.language' needs at least one model. Configure one or omit 'models.language'."
    )
  }

  const tiers = LANGUAGE_MODEL_TIERS.filter((tier) => entries.some((entry) => entry.tier === tier))

  return Object.freeze({
    ...index,
    default: defaultEntry,
    tiers: Object.freeze(tiers),
    getByTier: (tier: LanguageModelTier) =>
      entries.find((entry) => entry.tier === tier) ?? defaultEntry,
  })
}

/**
 * The model code runs: its own as given, a tier's model from the catalog, or the default. A string
 * that is not a tier throws, since a caller's types may not have checked it.
 */
export function selectLanguageModel(
  catalog: LanguageModelCatalog | undefined,
  model: LanguageModel | LanguageModelTier | undefined
): LanguageModel | undefined {
  if (model === undefined) return catalog?.default.model
  if (typeof model !== "string") return model

  if (!isLanguageModelTier(model)) {
    throw new TypeError(
      `[Sixb] Unknown model tier '${model}'. Use ${formatLanguageModelTiers()}, or pass a model.`
    )
  }

  return catalog?.getByTier(model).model
}

interface ConfiguredLanguageModel {
  readonly model: LanguageModel
  readonly tier?: LanguageModelTier
  /** Where the model was configured, for its errors. */
  readonly path: string
}

/** Flatten a list, or tiers in tier order, without validating the models themselves. */
function configuredLanguageModels(
  input: readonly LanguageModel[] | LanguageModelTiers
): readonly ConfiguredLanguageModel[] {
  if (Array.isArray(input)) {
    return input.map((model, index) => ({ model, path: `models.language[${index}]` }))
  }
  if (typeof input !== "object" || input === null) {
    throw new RuntimeError(
      "[Sixb] 'models.language' must be an array of Sixb language models, or tiers: { light, standard, heavy }."
    )
  }

  const unknown = Object.keys(input).find((key) => !isLanguageModelTier(key))
  if (unknown !== undefined) {
    throw new RuntimeError(
      `[Sixb] Unknown model tier '${unknown}' in 'models.language'. Use ${formatLanguageModelTiers()}, or pass an array of models.`
    )
  }
  // Array.isArray does not narrow a readonly array out of the union.
  const tiers = input as LanguageModelTiers
  if (tiers.standard === undefined) {
    throw new RuntimeError(
      "[Sixb] 'models.language' tiers need 'standard': its first model is the project default."
    )
  }

  return LANGUAGE_MODEL_TIERS.flatMap((tier) => {
    const models = tiers[tier]
    if (models === undefined) return []
    if (!Array.isArray(models)) {
      return [{ model: models, tier, path: `models.language.${tier}` }]
    }
    if (models.length === 0) {
      throw new RuntimeError(`[Sixb] 'models.language.${tier}' needs at least one model.`)
    }
    return models.map((model, index) => ({
      model,
      tier,
      path: `models.language.${tier}[${index}]`,
    }))
  })
}

function createEmbeddingCatalog(
  models: readonly EmbeddingModel[] | undefined
): EmbeddingModelCatalog {
  if (models !== undefined && !Array.isArray(models)) {
    throw new RuntimeError("[Sixb] models.embedding must be an array of embedding models.")
  }

  return indexModelBindings(models ?? [], "embedding", assertEmbeddingModel)
}

/** Builds the error for an invalid language model, naming where it was configured. */
type InvalidLanguageModel = (detail: string) => Error

/**
 * Check a language model the project configures, in the catalog or on an agent step: its shape
 * and identity, its default reasoning and its output limit.
 */
export function assertValidLanguageModel(
  model: unknown,
  fail: InvalidLanguageModel
): asserts model is LanguageModel {
  assertLanguageModel(model, fail)
  assertDefaultReasoning(model, fail)
  assertMaxOutputTokens(model, fail)
}

// Capabilities known without catalog I/O. Unknown support is accepted: providers fall back to their
// default when a resolved model turns out not to support the level.
function assertDefaultReasoning(model: LanguageModel, fail: InvalidLanguageModel): void {
  const reasoning: unknown = model.defaultReasoning
  if (reasoning === undefined) return
  if (!(MODEL_REASONING_LEVELS as readonly unknown[]).includes(reasoning)) {
    throw fail(`expected 'defaultReasoning' to be one of: ${MODEL_REASONING_LEVELS.join(", ")}`)
  }
  const issue = modelReasoningSupportIssue(model.definition.capabilities.reasoning, reasoning)
  if (issue !== undefined) {
    throw fail(`default reasoning '${reasoning}' cannot be used: ${issue}`)
  }
}

// Providers validate their own options; this holds the same rule for providers written elsewhere.
function assertMaxOutputTokens(model: LanguageModel, fail: InvalidLanguageModel): void {
  const maxOutputTokens: unknown = model.maxOutputTokens
  if (maxOutputTokens === undefined) return
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  ) {
    throw fail("expected 'maxOutputTokens' to be a positive safe integer")
  }
  const modelMaximum = model.definition.maxOutputTokens
  if (modelMaximum !== undefined && maxOutputTokens > modelMaximum) {
    throw fail(`'maxOutputTokens' (${maxOutputTokens}) exceeds the model maximum (${modelMaximum})`)
  }
}

function assertLanguageModel(
  model: unknown,
  fail: InvalidLanguageModel
): asserts model is LanguageModel {
  if ((typeof model !== "object" && typeof model !== "function") || model === null) {
    throw fail("expected a Sixb LanguageModel instance")
  }

  const candidate = model as Record<string, unknown>
  assertModelIdentifier(candidate.providerId, "provider", fail)
  assertModelIdentifier(candidate.modelId, "modelId", fail)
  if (typeof candidate.stream !== "function") {
    throw fail("expected 'stream' to be a function")
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
    throw fail(error instanceof Error ? error.message : "invalid definition")
  }
}

function assertModelIdentifier(
  value: unknown,
  field: "provider" | "modelId",
  fail: InvalidLanguageModel
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw fail(`expected '${field}' to be a non-empty string`)
  }
  if (value.trim() !== value) {
    throw fail(`expected '${field}' not to have surrounding whitespace`)
  }
}

function invalidLanguageModel(path: string, detail: string): RuntimeError {
  return new RuntimeError(`[Sixb] Invalid language model at '${path}': ${detail}.`)
}

/** Provider-owned metadata lookup, independent from the project's configured bindings. */
export interface ModelDefinitionCatalog<TDefinition extends ModelDefinition = ModelDefinition> {
  get(modelId: string): Promise<TDefinition | undefined>
  list(): Promise<readonly TDefinition[]>
}

export type LanguageModelDefinitionCatalog = ModelDefinitionCatalog<LanguageModelDefinition>
