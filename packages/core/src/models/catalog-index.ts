import { RuntimeError } from "../runtime/errors"
import type { ModelRef } from "./catalog"

interface ModelBinding {
  readonly providerId: string
  readonly modelId: string
}

interface ModelEntry<TModel> extends ModelRef {
  readonly model: TModel
}

interface ModelIndex<TEntry> {
  list(): readonly TEntry[]
  getByRef(ref: ModelRef): TEntry | null
}

/** Private index shared by model families; default selection belongs to each family. */
export function indexModelBindings<TModel extends ModelBinding>(
  models: readonly TModel[],
  kind: string,
  validate: (model: TModel, index: number) => void
): ModelIndex<ModelEntry<TModel>>
/** A family that adds its own fields to each entry, such as a language model's tier. */
export function indexModelBindings<TModel extends ModelBinding, TFields extends object>(
  models: readonly TModel[],
  kind: string,
  validate: (model: TModel, index: number) => void,
  fields: (index: number) => TFields
): ModelIndex<ModelEntry<TModel> & TFields>
export function indexModelBindings<TModel extends ModelBinding>(
  models: readonly TModel[],
  kind: string,
  validate: (model: TModel, index: number) => void,
  fields?: (index: number) => object
): ModelIndex<ModelEntry<TModel>> {
  const byRef = new Map<string, ModelEntry<TModel>>()

  for (const [index, model] of models.entries()) {
    validate(model, index)
    const key = JSON.stringify([model.providerId, model.modelId])
    if (byRef.has(key)) {
      throw new RuntimeError(
        `[Sixb] Duplicate ${kind} model '${model.providerId}/${model.modelId}' in 'models.${kind}'. Each provider and model id pair may be configured once.`
      )
    }

    const entry = { provider: model.providerId, modelId: model.modelId, model }
    byRef.set(key, Object.freeze(fields ? { ...entry, ...fields(index) } : entry))
  }

  const entries = Object.freeze([...byRef.values()])
  return Object.freeze({
    list: () => entries,
    getByRef: (ref: ModelRef) => byRef.get(JSON.stringify([ref.provider, ref.modelId])) ?? null,
  })
}
