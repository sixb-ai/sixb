import { RuntimeError } from "../runtime/errors"
import type { ModelRef } from "./catalog"

interface ModelBinding {
  readonly providerId: string
  readonly modelId: string
}

interface ModelEntry<TModel> extends ModelRef {
  readonly model: TModel
}

/**
 * Private index shared by model families; default selection belongs to each family. `details`
 * adds family-specific settings configured next to a binding to its entry.
 */
export function indexModelBindings<TModel extends ModelBinding, TDetails extends object = object>(
  models: readonly TModel[],
  kind: string,
  validate: (model: TModel, index: number) => void,
  details?: (index: number) => TDetails
) {
  const byRef = new Map<string, ModelEntry<TModel> & TDetails>()

  for (const [index, model] of models.entries()) {
    validate(model, index)
    const key = JSON.stringify([model.providerId, model.modelId])
    if (byRef.has(key)) {
      throw new RuntimeError(
        `[Sixb] Duplicate ${kind} model '${model.providerId}/${model.modelId}' in 'models.${kind}'. Each provider and model id pair may be configured once.`
      )
    }

    // Without `details`, `TDetails` is the empty default.
    const entryDetails = details ? details(index) : ({} as TDetails)
    byRef.set(
      key,
      Object.freeze({
        ...entryDetails,
        provider: model.providerId,
        modelId: model.modelId,
        model,
      })
    )
  }

  const entries = Object.freeze([...byRef.values()])
  return Object.freeze({
    list: () => entries,
    getByRef: (ref: ModelRef) => byRef.get(JSON.stringify([ref.provider, ref.modelId])) ?? null,
  })
}
