import { assertAuthorized, assertRuntimeAuthorizationBound, isAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizationContext } from "../authorization/types"
import { type Unreadable, unreadableError } from "../objects/property-clearance"
import { bindCurrentUserPredicate } from "../objects/query/current-user"
import type { ObjectQueryPredicate } from "../objects/query/ir"
import {
  createSelectedObjectQueryAdmission,
  type SelectedObjectQueryAdmission,
} from "../objects/query/selected-read-admission"
import type { OntologyRegistry } from "../ontology"
import type { UserRef } from "../ontology/user-ref"
import type { AppliedMarkings } from "../security/applied-markings"
import type {
  CompiledConditionalObjectReadScope,
  CompiledObjectReadStep,
  ObjectLinkRow,
} from "../storage"
import { compileConditionalObjectReadScope } from "../storage/objects/read-scope"
import type { resolveExecutionScopeAuthorization } from "./authorization"
import { type Clearance, ObjectReaderClearance } from "./object-reader-clearance"
import type { AuthorizablePrincipal, RuntimeAuthorization } from "./types"

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
 * carries, the conditions a principal reads some types through, and its clearance. It decides
 * whether an object type or a link is viewable.
 *
 * A type a principal views only through a condition is viewable here, and nowhere else: the
 * reader's storage shows only the objects the condition matches. A check that answers for one
 * object of such a type reads that object through the same storage.
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
  /** The user `currentUser()` stands for in this reader's queries; absent when no user reads. */
  readonly requestingUser?: UserRef
  /** What the reader's storage reads through: present when a principal views a type under one. */
  readonly conditionalScope?: CompiledConditionalObjectReadScope
  /** The properties each conditioned type's condition reads, which its clearance must show. */
  readonly #conditionProperties: ReadonlyMap<string, readonly string[]>

  constructor(input: {
    readonly authorization: RuntimeAuthorization
    readonly authority: ResolvedExecutionAuthority
    readonly projectId: string
    readonly ontology: OntologyRegistry
    readonly appliedMarkings?: AppliedMarkings
    readonly requestedBy: AuthorizablePrincipal | undefined
  }) {
    const authority = input.authority
    this.authorization = input.authorization
    this.authority = authority
    if (input.requestedBy?.type === "user") {
      this.requestingUser = Object.freeze({ type: "user", id: input.requestedBy.id })
    }
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

    const conditions = authority.type === "principal" ? authority.context.viewConditions : undefined
    this.#conditionProperties = new Map(
      [...(conditions ?? [])].map(([objectTypeId, predicates]) => [
        objectTypeId,
        [...new Set(predicates.flatMap(propertiesReadBy))],
      ])
    )

    if (authority.type === "principal" && conditions && conditions.size > 0) {
      // A reader sees an object any of its conditions matches. In a condition, `currentUser()` is
      // the principal the grant was resolved for, when it is a user: never the user who requested
      // the execution, which an agent's service account runs for. Otherwise it is no one.
      const principal = authority.context.principal
      const grantee: UserRef | undefined =
        principal.type === "user" ? { type: "user", id: principal.id } : undefined

      this.conditionalScope = compileConditionalObjectReadScope({
        kind: "conditional",
        conditions: [...conditions].map(([objectTypeId, predicates]) => ({
          objectTypeId,
          predicate: bindCurrentUserPredicate(anyOf(predicates), grantee),
        })),
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
      this.assertObjectTypesGranted(objectTypeIds, clearance)
    }

    if (!clearance) return

    for (const objectTypeId of new Set(objectTypeIds)) {
      const unreadable = clearance.unreadableType(objectTypeId)
      if (unreadable) throw unreadableError(unreadable)
    }
  }

  /**
   * Refuse a type a principal holds no view grant for, before its clearance is applied to what it
   * reads. A type viewed through a condition passes while the clearance shows every property the
   * condition reads.
   */
  assertObjectTypesGranted(objectTypeIds: readonly string[], clearance: Clearance): void {
    for (const objectTypeId of new Set(objectTypeIds)) {
      if (!this.#conditionProperties.has(objectTypeId)) {
        assertAuthorized(this.runtime, { kind: "object.view", objectTypeId })
        continue
      }

      assertRuntimeAuthorizationBound(this.runtime)

      const unreadable = this.#unreadableCondition(objectTypeId, clearance)
      if (unreadable) throw unreadableError(unreadable)
    }
  }

  /** Whether the principal views this type only through a condition, which decides per object. */
  viewsThroughCondition(objectTypeId: string): boolean {
    return this.#conditionProperties.has(objectTypeId)
  }

  isObjectTypeGranted(objectTypeId: string, clearance: Clearance): boolean {
    if (this.delegation) return this.delegation.objectTypeIds.has(objectTypeId)

    if (this.#conditionProperties.has(objectTypeId)) {
      return this.#unreadableCondition(objectTypeId, clearance) === undefined
    }

    return isAllowed(this.runtime.authorization, { kind: "object.view", objectTypeId })
  }

  isObjectTypeViewable(objectTypeId: string, clearance: Clearance): boolean {
    if (clearance?.unreadableType(objectTypeId)) return false
    return this.isObjectTypeGranted(objectTypeId, clearance)
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

  #unreadableCondition(objectTypeId: string, clearance: Clearance): Unreadable | undefined {
    const propertyIds = this.#conditionProperties.get(objectTypeId)
    return propertyIds && unreadableConditionOf(objectTypeId, propertyIds, clearance)
  }
}

/**
 * Which objects match a condition would reveal a property the reader cannot read, so a clearance
 * that hides one, a marking applied by a dataset version included, hides the whole type.
 */
function unreadableConditionOf(
  objectTypeId: string,
  propertyIds: readonly string[],
  clearance: Clearance
): Unreadable | undefined {
  for (const propertyId of propertyIds) {
    const marking = clearance?.missingMarking(objectTypeId, propertyId)
    if (marking === undefined) continue

    return {
      marking,
      message: `[Sixb] Cannot read '${objectTypeId}': the condition it is viewed through reads '${objectTypeId}.${propertyId}', which requires clearance for marking '${marking}'.`,
    }
  }

  return undefined
}

function propertiesReadBy(predicate: ObjectQueryPredicate): readonly string[] {
  switch (predicate.op) {
    case "and":
    case "or":
      return predicate.items.flatMap(propertiesReadBy)
    case "not":
      return propertiesReadBy(predicate.item)
    case "constant":
      return []
    default:
      return [predicate.propertyId]
  }
}

function anyOf(predicates: readonly ObjectQueryPredicate[]): ObjectQueryPredicate {
  return predicates.length === 1 ? predicates[0]! : { op: "or", items: predicates }
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
