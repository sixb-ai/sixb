import type { RuntimeAccessPlan } from "../../authorization/access-plan"
import { objectReadScopeForAccessPlan } from "../../authorization/access-plan"
import { AuthorizationError } from "../../authorization/errors"
import type { OntologyRegistry } from "../../ontology"
import { compileObjectReadScope } from "../../storage/objects/read-scope"
import type {
  CompiledObjectReadObjectSelection,
  CompiledSelectedObjectReadScope,
} from "../../storage/objects/types"
import type { ObjectExpansion, ObjectQuery, ObjectQueryPredicate, ObjectQuerySortField } from "./ir"

interface ScopeState {
  readonly nodeId: number
  readonly objectTypeId: string
}

interface AuthorizationContext {
  readonly ontology: OntologyRegistry
  readonly scope: CompiledSelectedObjectReadScope
  readonly selectionByState: ReadonlyMap<string, CompiledObjectReadObjectSelection>
}

/**
 * Reject query operations that are not named by the exact selected read-scope path.
 *
 * Storage remains responsible for resolving the live object universe. This check is deliberately
 * identity-free: it follows compiled node ids so a nested permission cannot be borrowed from a
 * different occurrence of the same object type, then rejects unsupported query semantics before
 * any storage call can run.
 */
export function assertObjectQueryAuthorizedByAccessPlan(
  accessPlan: RuntimeAccessPlan,
  query: ObjectQuery,
  ontology: OntologyRegistry
): void {
  const compiled = compileObjectReadScope(objectReadScopeForAccessPlan(accessPlan))
  if (compiled.kind !== "selected") {
    throw new Error("[Sixb] Runtime access plans must compile to a selected object read scope.")
  }

  const selectionByState = new Map<string, CompiledObjectReadObjectSelection>()
  for (const selection of compiled.objects) {
    selectionByState.set(stateKey(selection), selection)
  }

  authorizeQuery(query, "$", { ontology, scope: compiled, selectionByState })
}

function authorizeQuery(
  query: ObjectQuery,
  path: string,
  ctx: AuthorizationContext
): readonly ScopeState[] {
  switch (query.kind) {
    case "start": {
      const objectTypeIds = new Set([
        query.objectTypeId,
        ...(query.includeSubtypes ? ctx.ontology.listSubTypes(query.objectTypeId) : []),
      ])
      const states = uniqueStates(
        ctx.scope.objects.filter((selection) => objectTypeIds.has(selection.objectTypeId))
      )
      if (states.length === 0) {
        throw new AuthorizationError(
          `view:object:${query.objectTypeId}`,
          `[Sixb] Delegated query cannot start from object type '${query.objectTypeId}': the current access plan does not select that type.`
        )
      }
      return states
    }
    case "refs": {
      const objectTypeIds = new Set(query.refs.map((ref) => ref.objectTypeId))
      const states = uniqueStates(
        ctx.scope.objects.filter((selection) => objectTypeIds.has(selection.objectTypeId))
      )
      const selectedObjectTypeIds = new Set(states.map((state) => state.objectTypeId))
      for (const objectTypeId of objectTypeIds) {
        if (selectedObjectTypeIds.has(objectTypeId)) continue
        throw new AuthorizationError(
          `view:object:${objectTypeId}`,
          `[Sixb] Delegated query cannot reference object type '${objectTypeId}': the current access plan does not select that type.`
        )
      }
      return states
    }
    case "filter": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      for (const propertyId of collectPredicatePropertyIds(query.predicate)) {
        assertPropertySelected(states, propertyId, "filter", `${path}.predicate`, ctx)
      }
      return states
    }
    case "text": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      if (query.fields) {
        for (const propertyId of query.fields) {
          assertPropertySelected(states, propertyId, "text search", `${path}.fields`, ctx)
        }
        return states
      }

      for (const objectTypeId of uniqueObjectTypeIds(states)) {
        const fields =
          query.fieldsByObjectType?.[objectTypeId] ??
          ctx.ontology.getObjectTypeById(objectTypeId)?.search?.defaultText ??
          []
        for (const propertyId of fields) {
          assertPropertySelected(
            states,
            propertyId,
            "text search",
            `${path}.fieldsByObjectType.${objectTypeId}`,
            ctx,
            objectTypeId
          )
        }
      }
      return states
    }
    case "vector": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      assertPropertySelected(states, query.propertyId, "vector search", path, ctx)
      return states
    }
    case "traverse": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      return followSelectedSteps(
        states,
        query.linkId,
        query.direction,
        query.sourceObjectTypeId,
        "traverse",
        path,
        ctx
      )
    }
    case "set": {
      const inputs = query.inputs.map((input, index) =>
        authorizeQuery(input, `${path}.inputs[${index}]`, ctx)
      )
      if (query.op === "subtract") return inputs[0] ?? []

      // Union can yield rows from any input. Intersection rows were selected through every input,
      // so they retain every contributing path's authority. A flat union is therefore the safe
      // provenance representation for both operations; exact identities remain storage-owned.
      return uniqueStates(inputs.flat())
    }
    case "sort": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      assertSortFieldsSelected(states, query.fields, "sort", `${path}.fields`, ctx)
      return states
    }
    case "limit":
    case "page":
      return authorizeQuery(query.input, `${path}.input`, ctx)
    case "project": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      for (const propertyId of query.properties ?? []) {
        assertPropertySelected(states, propertyId, "projection", `${path}.properties`, ctx)
      }
      return states
    }
    case "expand": {
      const states = authorizeQuery(query.input, `${path}.input`, ctx)
      authorizeExpansions(query.expansions, states, `${path}.expansions`, ctx)
      return states
    }
  }
}

function authorizeExpansions(
  expansions: readonly ObjectExpansion[],
  parentStates: readonly ScopeState[],
  path: string,
  ctx: AuthorizationContext
): void {
  for (const [index, expansion] of expansions.entries()) {
    const expansionPath = `${path}[${index}]`
    const targetStates = followSelectedSteps(
      parentStates,
      expansion.linkId,
      expansion.direction,
      expansion.sourceObjectTypeId,
      "expand",
      expansionPath,
      ctx
    )
    assertSortFieldsSelected(
      targetStates,
      expansion.orderBy ?? [],
      "expansion orderBy",
      `${expansionPath}.orderBy`,
      ctx
    )
    authorizeExpansions(expansion.expand ?? [], targetStates, `${expansionPath}.expand`, ctx)
  }
}

function followSelectedSteps(
  states: readonly ScopeState[],
  linkId: string,
  direction: "outgoing" | "incoming",
  sourceObjectTypeId: string | undefined,
  operation: "traverse" | "expand",
  path: string,
  ctx: AuthorizationContext
): readonly ScopeState[] {
  const next: ScopeState[] = []

  for (const state of states) {
    for (const step of ctx.scope.steps) {
      if (step.linkId !== linkId) continue
      if (direction === "outgoing") {
        if (step.parentNodeId === state.nodeId && step.sourceObjectTypeId === state.objectTypeId) {
          next.push({ nodeId: step.nodeId, objectTypeId: step.targetObjectTypeId })
        }
        continue
      }

      if (
        step.nodeId === state.nodeId &&
        step.targetObjectTypeId === state.objectTypeId &&
        (!sourceObjectTypeId || step.sourceObjectTypeId === sourceObjectTypeId)
      ) {
        next.push({ nodeId: step.parentNodeId, objectTypeId: step.sourceObjectTypeId })
      }
    }
  }

  const result = uniqueStates(next)
  if (result.length > 0) return result

  const sourceConstraint = sourceObjectTypeId ? ` from source type '${sourceObjectTypeId}'` : ""
  throw new AuthorizationError(
    `view:link:${direction}:${sourceObjectTypeId ? `${sourceObjectTypeId}:` : ""}${linkId}`,
    `[Sixb] Delegated query cannot ${operation} ${direction} link '${linkId}'${sourceConstraint} from ${formatStates(states)} at '${path}'. Select this exact link with withLinks(...) on the current path.`
  )
}

function assertSortFieldsSelected(
  states: readonly ScopeState[],
  fields: readonly ObjectQuerySortField[],
  operation: "sort" | "expansion orderBy",
  path: string,
  ctx: AuthorizationContext
): void {
  for (const field of fields) {
    if (field.kind === "property") {
      assertPropertySelected(states, field.propertyId, operation, path, ctx)
    }
  }
}

function assertPropertySelected(
  states: readonly ScopeState[],
  propertyId: string,
  operation: string,
  path: string,
  ctx: AuthorizationContext,
  objectTypeId?: string
): void {
  const candidates = objectTypeId
    ? states.filter((state) => state.objectTypeId === objectTypeId)
    : states
  if (
    candidates.some((state) =>
      ctx.selectionByState.get(stateKey(state))?.propertyIds.includes(propertyId)
    )
  ) {
    return
  }

  const objectTypeIds = uniqueObjectTypeIds(candidates.length > 0 ? candidates : states)
  const typeKey = objectTypeIds.join(",") || "unknown"
  throw new AuthorizationError(
    `view:object:${typeKey}:property:${propertyId}`,
    `[Sixb] Delegated query cannot use property '${propertyId}' for ${operation} from ${formatStates(candidates.length > 0 ? candidates : states)} at '${path}'. Add this property to the object selection for the current path.`
  )
}

function collectPredicatePropertyIds(predicate: ObjectQueryPredicate): readonly string[] {
  switch (predicate.op) {
    case "and":
    case "or":
      return [...new Set(predicate.items.flatMap(collectPredicatePropertyIds))]
    case "not":
      return collectPredicatePropertyIds(predicate.item)
    default:
      return [predicate.propertyId]
  }
}

function uniqueStates(states: readonly ScopeState[]): readonly ScopeState[] {
  const byKey = new Map<string, ScopeState>()
  for (const state of states) byKey.set(stateKey(state), state)
  return [...byKey.values()].sort(
    (left, right) =>
      left.nodeId - right.nodeId || left.objectTypeId.localeCompare(right.objectTypeId)
  )
}

function uniqueObjectTypeIds(states: readonly ScopeState[]): readonly string[] {
  return [...new Set(states.map((state) => state.objectTypeId))].sort()
}

function stateKey(state: ScopeState): string {
  return JSON.stringify([state.nodeId, state.objectTypeId])
}

function formatStates(states: readonly ScopeState[]): string {
  if (states.length === 0) return "an empty read-scope provenance"
  return `read-scope provenance ${uniqueStates(states)
    .map((state) => `'${state.objectTypeId}'@node ${state.nodeId}`)
    .join(", ")}`
}
