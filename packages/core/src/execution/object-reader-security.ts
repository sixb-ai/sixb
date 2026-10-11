import { assertAuthorized, isAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizationContext } from "../authorization/types"
import { unreadableError } from "../objects/property-clearance"
import {
  createSelectedObjectQueryAdmission,
  type SelectedObjectQueryAdmission,
} from "../objects/query/selected-read-admission"
import type { OntologyRegistry } from "../ontology"
import type { AppliedMarkings } from "../security/applied-markings"
import type { CompiledObjectReadStep, ObjectLinkRow } from "../storage"
import type { resolveExecutionScopeAuthorization } from "./authorization"
import { type Clearance, ObjectReaderClearance } from "./object-reader-clearance"
import type { RuntimeAuthorization } from "./types"

export type ResolvedExecutionAuthority = ReturnType<typeof resolveExecutionScopeAuthorization>

export type RuntimeReadAuthorization = {
  readonly projectId: string
  readonly runtimeAuthorization: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

/** What a delegated authority selected: the object types, links, and queries it may read. */
export interface ObjectReaderDelegation {
  readonly objectTypeIds: ReadonlySet<string>
  readonly linkDefinitions: ReadonlySet<string>
  readonly queryAdmission: SelectedObjectQueryAdmission
}

/**
 * Who reads, and what it may read: the exact execution authority, the selection a delegated one
 * carries, and its clearance. It decides whether an object type or a link is viewable.
 */
export class ObjectReaderSecurity {
  /** The registered authority the reader is bound to. */
  readonly authorization: RuntimeAuthorization
  readonly authority: ResolvedExecutionAuthority
  /** The authority as generic authorization checks take it. */
  readonly runtime: RuntimeReadAuthorization
  /** Present for delegated authority only. */
  readonly delegation?: ObjectReaderDelegation
  readonly clearance: ObjectReaderClearance

  constructor(input: {
    readonly authorization: RuntimeAuthorization
    readonly authority: ResolvedExecutionAuthority
    readonly projectId: string
    readonly ontology: OntologyRegistry
    readonly appliedMarkings?: AppliedMarkings
  }) {
    const authority = input.authority
    this.authorization = input.authorization
    this.authority = authority
    this.runtime = Object.freeze({
      projectId: input.projectId,
      runtimeAuthorization: input.authorization,
      ...(authority.type === "principal" ? { authorization: authority.context } : {}),
    })
    if (authority.type === "delegated") {
      const scope = authority.objectRead.scope
      this.delegation = Object.freeze({
        objectTypeIds: new Set(scope.objects.map((object) => object.objectTypeId)),
        linkDefinitions: new Set(scope.steps.map(delegatedLinkDefinitionKey)),
        queryAdmission: createSelectedObjectQueryAdmission(scope),
      })
    }
    this.clearance = new ObjectReaderClearance({
      ontology: input.ontology,
      clearances: clearancesForAuthority(authority),
      ...(input.appliedMarkings === undefined ? {} : { appliedMarkings: input.appliedMarkings }),
    })
    Object.freeze(this)
  }

  assertObjectTypesViewable(objectTypeIds: readonly string[], clearance: Clearance): void {
    if (this.delegation) {
      for (const objectTypeId of new Set(objectTypeIds)) {
        if (this.delegation.objectTypeIds.has(objectTypeId)) continue
        throw new AuthorizationError(
          `delegated:object.view:${objectTypeId}`,
          `[Sixb] Delegated authorization does not select object type '${objectTypeId}'.`
        )
      }
    } else {
      for (const objectTypeId of new Set(objectTypeIds)) {
        assertAuthorized(this.runtime, { kind: "object.view", objectTypeId })
      }
    }
    if (!clearance) return
    for (const objectTypeId of new Set(objectTypeIds)) {
      const unreadable = clearance.unreadableType(objectTypeId)
      if (unreadable) throw unreadableError(unreadable)
    }
  }

  isObjectTypeViewable(objectTypeId: string, clearance: Clearance): boolean {
    if (clearance?.unreadableType(objectTypeId)) return false
    if (this.delegation) return this.delegation.objectTypeIds.has(objectTypeId)
    return isAllowed(this.runtime.authorization, { kind: "object.view", objectTypeId })
  }

  isLinkViewable(link: ObjectLinkRow, clearance: Clearance): boolean {
    if (
      !this.isObjectTypeViewable(link.sourceTypeId, clearance) ||
      !this.isObjectTypeViewable(link.targetTypeId, clearance) ||
      clearance?.unreadableLink(link.sourceTypeId, link.linkId)
    ) {
      return false
    }
    return this.delegation?.linkDefinitions.has(delegatedLinkDefinitionKey(link)) ?? true
  }
}

/**
 * Unrestricted authority reads every property. A principal reads what its roles clear; delegated
 * shared access carries no clearance, so no share can expose a marked property.
 */
function clearancesForAuthority(
  authority: ResolvedExecutionAuthority
): ReadonlySet<string> | undefined {
  switch (authority.type) {
    case "unrestricted":
      return undefined
    case "principal":
      return authority.context.clearances ?? new Set()
    case "delegated":
      return new Set()
  }
}

function delegatedLinkDefinitionKey(
  input:
    | Pick<CompiledObjectReadStep, "sourceObjectTypeId" | "linkId" | "targetObjectTypeId">
    | Pick<ObjectLinkRow, "sourceTypeId" | "linkId" | "targetTypeId">
): string {
  return "sourceObjectTypeId" in input
    ? JSON.stringify([input.sourceObjectTypeId, input.linkId, input.targetObjectTypeId])
    : JSON.stringify([input.sourceTypeId, input.linkId, input.targetTypeId])
}
