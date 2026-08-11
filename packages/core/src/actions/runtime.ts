import type { ObjectType } from "../ontology"
import type { ActionRegistry } from "./registry"
import type { ActionDefinition } from "./types"

export interface ActionsRuntime {
  list(): readonly ActionDefinition[]
  getById(actionId: string): ActionDefinition | null
  listGlobal(): readonly ActionDefinition[]
  listForType(objectType: ObjectType): readonly ActionDefinition[]
}

/** Compose the host-owned Action definition catalog. Run operations live on bound `Sixb`. */
export function createActionsRuntime(registry: ActionRegistry): ActionsRuntime {
  return {
    list: () => registry.list(),
    getById: (actionId) => registry.getById(actionId),
    listGlobal: () => registry.getGlobalActions(),
    listForType: (objectType) => registry.getActionsForType(objectType),
  }
}
