import type { LanguageModelV4 } from "@ai-sdk/provider"
import { createDefinitionCatalog, type DefinitionCatalog } from "../runtime/definitions"
import { RuntimeError } from "../runtime/errors"

/** The configured language models, with the project default. */
export interface LanguageModelCatalog extends DefinitionCatalog<LanguageModelEntry> {
  readonly default: LanguageModelEntry
}

/**
 * One configured language model.
 *
 * `ref` is derived, never author-supplied, and stays internal to the runtime: it identifies the
 * configured binding, not a vendor model. The AI SDK's `provider` names the binding, so
 * `openai.chat(...)` and `openai.responses(...)` are distinct entries even for one vendor model,
 * and neither matches the canonical id the worker resolves for billing
 * (`SDK_PROVIDER_BINDINGS` in `@sixb/agent-worker`). Anything user-facing should key on
 * `provider` + `modelId` instead.
 */
export interface LanguageModelEntry {
  readonly ref: string
  readonly provider: string
  readonly modelId: string
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

/**
 * Identify a catalog entry by the binding its model was constructed from.
 *
 * `gateway("openai/gpt-5.4")` and `openai("gpt-5.4")` are different entries on purpose: they route
 * differently and bill differently. See {@link LanguageModelEntry}.
 */
export function modelRef(model: LanguageModelV4): string {
  return `${model.provider}/${model.modelId}`
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
    byRef.set(ref, Object.freeze({ ref, provider: model.provider, modelId: model.modelId, model }))
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
