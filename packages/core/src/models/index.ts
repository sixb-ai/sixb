import type { LanguageModelV4 } from "@ai-sdk/provider"
import { RuntimeError } from "../runtime/errors"

/** Stable identity of one configured language-model binding. */
export interface LanguageModelRef {
  readonly provider: string
  readonly modelId: string
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
 * `gateway("openai/gpt-5.4")` and `openai("gpt-5.4")` are distinct entries because their
 * `provider` values differ.
 */
export interface LanguageModelEntry extends LanguageModelRef {
  readonly model: LanguageModelV4
}

/** Models a project allows Sixb to use, organized by technical model kind. */
export interface ModelCatalog {
  readonly language: LanguageModelCatalog
}

export interface ModelCatalogInput {
  /** Ordered; the first entry is the project default. */
  readonly language: readonly LanguageModelV4[]
}

/** Build the immutable project model catalog. Rejects invalid, duplicate, and empty catalogs. */
export function createModelCatalog(input: ModelCatalogInput): ModelCatalog {
  if (!Array.isArray(input?.language)) {
    throw new RuntimeError("[Sixb] 'models.language' must be an array of AI SDK language models.")
  }

  const entries: LanguageModelEntry[] = []
  const byProvider = new Map<string, Map<string, LanguageModelEntry>>()

  for (const [index, model] of input.language.entries()) {
    assertLanguageModel(model, index)

    let byModelId = byProvider.get(model.provider)
    if (byModelId === undefined) {
      byModelId = new Map()
      byProvider.set(model.provider, byModelId)
    }
    if (byModelId.has(model.modelId)) {
      throw new RuntimeError(
        `[Sixb] Duplicate language model '${formatLanguageModelRef(model)}' in 'models'. Each provider and model id pair may be configured once.`
      )
    }

    const entry = Object.freeze({
      provider: model.provider,
      modelId: model.modelId,
      model,
    })
    byModelId.set(model.modelId, entry)
    entries.push(entry)
  }

  const [defaultEntry] = entries
  if (defaultEntry === undefined) {
    throw new RuntimeError(
      "[Sixb] 'models.language' needs at least one model. Configure one or omit 'models' from createSixb()."
    )
  }

  const listed = Object.freeze(entries.slice())
  const language: LanguageModelCatalog = Object.freeze({
    default: defaultEntry,
    list: () => listed,
    getByRef: (ref: LanguageModelRef) => byProvider.get(ref.provider)?.get(ref.modelId) ?? null,
  })

  return Object.freeze({ language })
}

function assertLanguageModel(model: unknown, index: number): asserts model is LanguageModelV4 {
  if ((typeof model !== "object" && typeof model !== "function") || model === null) {
    throw invalidLanguageModel(index, "expected an AI SDK LanguageModelV4 instance")
  }

  const candidate = model as Record<string, unknown>
  if (candidate.specificationVersion !== "v4") {
    throw invalidLanguageModel(index, "expected 'specificationVersion' to be 'v4'")
  }
  assertModelIdentifier(candidate.provider, "provider", index)
  assertModelIdentifier(candidate.modelId, "modelId", index)
  if (!isSupportedUrls(candidate.supportedUrls)) {
    throw invalidLanguageModel(index, "expected 'supportedUrls' to be an object or PromiseLike")
  }
  if (typeof candidate.doGenerate !== "function") {
    throw invalidLanguageModel(index, "expected 'doGenerate' to be a function")
  }
  if (typeof candidate.doStream !== "function") {
    throw invalidLanguageModel(index, "expected 'doStream' to be a function")
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

function isSupportedUrls(value: unknown): value is object {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return true
  return (
    typeof value === "function" &&
    typeof (value as unknown as { readonly then?: unknown }).then === "function"
  )
}

function invalidLanguageModel(index: number, detail: string): RuntimeError {
  return new RuntimeError(
    `[Sixb] Invalid language model at 'models.language[${index}]': ${detail}.`
  )
}

function formatLanguageModelRef(ref: LanguageModelRef): string {
  return `${ref.provider}/${ref.modelId}`
}
