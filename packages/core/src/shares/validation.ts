import { type ActionDefinitionCatalog, isObjectActionDefinition } from "../actions"
import type { OntologyDefinitionCatalog } from "../ontology"
import { assertGrantDefinition, type GrantDefinition } from "../security"
import type { SharedAccessGrantRef } from "../storage/share-grants"
import { ShareError } from "./errors"
import { isRouteSafeShareTypeId, SHARE_TYPE_ID_REQUIREMENT } from "./id"
import type { ShareTypeDefinition } from "./types"

export function validateShareTypesAtStartup(input: {
  readonly shares: readonly ShareTypeDefinition[]
  readonly ontology: OntologyDefinitionCatalog
  readonly actions: ActionDefinitionCatalog
}): ReadonlyMap<string, ShareTypeDefinition> {
  const byId = new Map<string, ShareTypeDefinition>()

  for (const share of input.shares) {
    if (share.kind !== "share") {
      throw invalid("Share type kind must be 'share'.")
    }
    if (!isRouteSafeShareTypeId(share.id)) {
      throw invalid(`Share type id ${SHARE_TYPE_ID_REQUIREMENT}.`)
    }
    if (byId.has(share.id)) {
      throw invalid(`Duplicate share type id: ${share.id}`)
    }
    if (share.description !== undefined && typeof share.description !== "string") {
      throw invalid(`Share type '${share.id}' description must be a string.`)
    }

    if (
      typeof share.target !== "object" ||
      share.target === null ||
      typeof share.target.id !== "string" ||
      !share.target.id.trim()
    ) {
      throw invalid(`Share type '${share.id}' target must be an object type.`)
    }
    const target = input.ontology.getObjectTypeById(share.target.id)
    if (!target) {
      throw invalid(`Share type '${share.id}' targets unknown object type '${share.target.id}'.`)
    }
    if (!Array.isArray(share.grants) || share.grants.length === 0) {
      throw invalid(`Share type '${share.id}' must declare at least one grant.`)
    }

    let viewsTarget = false
    for (const grant of share.grants) {
      assertGrantDefinition(grant, `Share type '${share.id}' grants`, (message) =>
        invalid(message.replace(/^\[Sixb\] /, ""))
      )
      if (grant.capability === "view") {
        if (grant.target !== "object") {
          throw invalid(`Share type '${share.id}' can view only its target object type.`)
        }
        assertExactSelection(share, grant, [share.target.id])
        viewsTarget = true
        continue
      }

      if (grant.capability !== "apply") {
        throw invalid(
          `Share type '${share.id}' supports only exact can.view(object) and can.apply(action) grants in V1.`
        )
      }

      const actionIds = explicitIds(share, grant)
      for (const actionId of actionIds) {
        const action = input.actions.getById(actionId)
        if (!action || !isObjectActionDefinition(action)) {
          throw invalid(
            `Share type '${share.id}' grants unknown or global action '${actionId}'. Shared actions must be object-bound.`
          )
        }
        if (!input.actions.listForType(target).some((candidate) => candidate.id === actionId)) {
          throw invalid(
            `Share type '${share.id}' action '${actionId}' does not apply to '${share.target.id}'.`
          )
        }
        if (
          Object.values(action.params).some(
            (param) =>
              typeof param.schema === "object" &&
              param.schema !== null &&
              param.schema.type === "objectRef"
          )
        ) {
          throw invalid(
            `Share type '${share.id}' action '${actionId}' cannot expose objectRef parameters in V1.`
          )
        }
      }
    }

    if (!viewsTarget) {
      throw invalid(
        `Share type '${share.id}' must include can.view(${share.target.id}) for its target.`
      )
    }
    byId.set(share.id, share)
  }

  return byId
}

export function snapshotShareTypeGrants(
  share: ShareTypeDefinition
): readonly SharedAccessGrantRef[] {
  const result: SharedAccessGrantRef[] = []
  for (const grant of share.grants) {
    for (const id of explicitIds(share, grant)) {
      result.push(
        grant.capability === "view"
          ? { capability: "view", objectTypeId: id }
          : { capability: "apply", actionId: id }
      )
    }
  }
  return result
}

function assertExactSelection(
  share: ShareTypeDefinition,
  grant: GrantDefinition,
  expectedIds: readonly string[]
): void {
  const ids = explicitIds(share, grant)
  if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
    throw invalid(
      `Share type '${share.id}' view grant must select only its target '${share.target.id}'.`
    )
  }
}

function explicitIds(share: ShareTypeDefinition, grant: GrantDefinition): readonly string[] {
  if (grant.selection.all) {
    throw invalid(
      `Share type '${share.id}' cannot use broad grants. Select exact object types and actions.`
    )
  }
  if (grant.selection.ids.length === 0) {
    throw invalid(`Share type '${share.id}' contains an empty ${grant.capability} grant.`)
  }
  return grant.selection.ids
}

function invalid(message: string): ShareError {
  return new ShareError("invalid_definition", `[Sixb] ${message}`)
}
