import type { ObjectType } from "../ontology"
import type { OntologyRegistry } from "../ontology/registry"
import { ActionDefinitionError } from "./errors"
import type { ActionDefinition, ObjectActionDefinition } from "./types"

function isObjectActionDefinition(action: ActionDefinition): action is ObjectActionDefinition {
  return action.binding.kind === "object"
}

export class ActionRegistry {
  private readonly byId = new Map<string, ActionDefinition>()
  private readonly globalActions: ActionDefinition[] = []
  private readonly byTargetId = new Map<string, ObjectActionDefinition[]>()

  constructor(
    actions: readonly ActionDefinition[],
    private readonly ontology: OntologyRegistry
  ) {
    for (const action of actions) {
      const previous = this.byId.get(action.id)
      if (previous) {
        const chainDuplicate = this.getInheritanceDuplicate(action, previous)
        if (chainDuplicate) {
          throw new ActionDefinitionError(
            `Duplicate action id "${action.id}" in inheritance chain of "${chainDuplicate.objectTypeId}": defined on both "${chainDuplicate.firstTargetId}" and "${chainDuplicate.secondTargetId}".`
          )
        }

        throw new ActionDefinitionError(
          `Duplicate action id "${action.id}" declared in multiple files.`
        )
      }

      this.validatePhases(action)
      this.byId.set(action.id, action)

      if (!isObjectActionDefinition(action)) {
        this.globalActions.push(action)
        continue
      }

      const target = this.ontology.getObjectTypeById(action.target.id)
      if (!target) {
        throw new ActionDefinitionError(
          `Action "${action.id}" targets unknown object type "${action.target.id}". Add the object type to ontology before registering the action.`
        )
      }

      const bucket = this.byTargetId.get(action.target.id) ?? []
      bucket.push(action)
      this.byTargetId.set(action.target.id, bucket)
    }
  }

  private validatePhases(action: ActionDefinition): void {
    const hasWriteback = action.phases.writeback !== undefined
    const hasEdits = action.phases.edits !== undefined
    const hasEffects = action.phases.effects !== undefined

    if (!hasWriteback && !hasEdits) {
      throw new ActionDefinitionError(
        `Action "${action.id}" must declare .writeback(...) or .edits(...).`
      )
    }

    if (hasEffects && !hasEdits) {
      throw new ActionDefinitionError(
        `Action "${action.id}" cannot declare .effects(...) without .edits(...).`
      )
    }
  }

  list(): readonly ActionDefinition[] {
    return [...this.byId.values()]
  }

  getById(id: string): ActionDefinition | null {
    return this.byId.get(id) ?? null
  }

  getGlobalActions(): readonly ActionDefinition[] {
    return [...this.globalActions]
  }

  getActionsForType(type: ObjectType): readonly ObjectActionDefinition[] {
    this.ontology.resolveObjectType(type.id)

    const seen = new Set<string>()
    const result: ObjectActionDefinition[] = []

    for (const ancestor of this.ontology.getAncestorChain(type)) {
      for (const action of this.byTargetId.get(ancestor.id) ?? []) {
        if (seen.has(action.id)) continue
        seen.add(action.id)
        result.push(action)
      }
    }

    return result
  }

  private getInheritanceDuplicate(
    action: ActionDefinition,
    previous: ActionDefinition
  ): { objectTypeId: string; firstTargetId: string; secondTargetId: string } | null {
    if (!isObjectActionDefinition(action) || !isObjectActionDefinition(previous)) {
      return null
    }

    if (action.target.id === previous.target.id) {
      return null
    }

    const actionChain = this.ontology.getAncestorChain(action.target)
    if (actionChain.some((ancestor) => ancestor.id === previous.target.id)) {
      return {
        objectTypeId: action.target.id,
        firstTargetId: previous.target.id,
        secondTargetId: action.target.id,
      }
    }

    const previousChain = this.ontology.getAncestorChain(previous.target)
    if (previousChain.some((ancestor) => ancestor.id === action.target.id)) {
      return {
        objectTypeId: previous.target.id,
        firstTargetId: action.target.id,
        secondTargetId: previous.target.id,
      }
    }

    return null
  }
}
