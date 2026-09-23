import { RuntimeError } from "../../runtime/errors"
import type { ModelRef } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import type { DecisionModel } from "./types"
import { assertDecisionModel } from "./validation"

export interface DecisionModelEntry extends ModelRef {
  readonly model: DecisionModel
}

export interface DecisionModelCatalog {
  readonly default: DecisionModelEntry
  list(): readonly DecisionModelEntry[]
  getByRef(ref: ModelRef): DecisionModelEntry | null
}

export function createDecisionCatalog(
  models: readonly DecisionModel[] | undefined
): DecisionModelCatalog | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models)) {
    throw new RuntimeError("[Sixb] models.decision must be a nonempty array of decision models.")
  }

  const index = indexModelBindings(models, "decision", assertDecisionModel)
  const [defaultEntry] = index.list()
  if (!defaultEntry) {
    throw new RuntimeError("[Sixb] models.decision must be a nonempty array of decision models.")
  }

  return Object.freeze({ ...index, default: defaultEntry })
}
