import type { ObjectType } from "../ontology"
import type { OntologyRegistry } from "../ontology/registry"
import {
  ActionDefinitionError,
  effectsWithoutEditsMessage,
  missingActionMutationMessage,
} from "./errors"
import type { ActionDefinition, ObjectActionDefinition } from "./types"
import { isObjectActionDefinition } from "./validation"

export interface ActionDefinitionCatalog {
  list(): readonly ActionDefinition[]
  getById(id: string): ActionDefinition | null
  listGlobal(): readonly ActionDefinition[]
  listForType(type: ObjectType): readonly ObjectActionDefinition[]
}

export class ActionRegistry implements ActionDefinitionCatalog {
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

      const objectType = action.binding.objectType
      const target = this.ontology.getObjectTypeById(objectType.id)
      if (!target) {
        throw new ActionDefinitionError(
          `Action "${action.id}" targets unknown object type "${objectType.id}". Add the object type to ontology before registering the action.`
        )
      }

      const bucket = this.byTargetId.get(objectType.id) ?? []
      bucket.push(action)
      this.byTargetId.set(objectType.id, bucket)
    }
  }

  private validatePhases(action: ActionDefinition): void {
    const hasWriteback = action.phases.writeback !== undefined
    const hasEdits = action.phases.edits !== undefined
    const hasEffects = action.phases.effects !== undefined

    if (!hasWriteback && !hasEdits) {
      throw new ActionDefinitionError(missingActionMutationMessage(action.id))
    }

    if (hasEffects && !hasEdits) {
      throw new ActionDefinitionError(effectsWithoutEditsMessage(action.id))
    }
  }

  list(): readonly ActionDefinition[] {
    return [...this.byId.values()]
  }

  getById(id: string): ActionDefinition | null {
    return this.byId.get(id) ?? null
  }

  listGlobal(): readonly ActionDefinition[] {
    return [...this.globalActions]
  }

  listForType(type: ObjectType): readonly ObjectActionDefinition[] {
    this.ontology.resolveObjectType(type.id)

    const seen = new Set<string>()
    const result: ObjectActionDefinition[] = []

    for (const ancestor of this.ontology.listAncestorChain(type)) {
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

    const actionObjectType = action.binding.objectType
    const previousObjectType = previous.binding.objectType

    if (actionObjectType.id === previousObjectType.id) {
      return null
    }

    const actionChain = this.ontology.listAncestorChain(actionObjectType)
    if (actionChain.some((ancestor) => ancestor.id === previousObjectType.id)) {
      return {
        objectTypeId: actionObjectType.id,
        firstTargetId: previousObjectType.id,
        secondTargetId: actionObjectType.id,
      }
    }

    const previousChain = this.ontology.listAncestorChain(previousObjectType)
    if (previousChain.some((ancestor) => ancestor.id === actionObjectType.id)) {
      return {
        objectTypeId: previousObjectType.id,
        firstTargetId: actionObjectType.id,
        secondTargetId: previousObjectType.id,
      }
    }

    return null
  }
}
