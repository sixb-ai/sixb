import { AuthorizationError } from "../../authorization/errors"
import type {
  CompiledObjectReadObjectSelection,
  CompiledObjectReadStep,
  CompiledSelectedObjectReadScope,
} from "../../storage/objects/types"
import type {
  ObjectQueryAdmissionState,
  ObjectQueryAdmissionTransition,
  ObjectQueryEdgeUse,
  ObjectQueryPropertyUse,
  ObjectQuerySemanticAdmission,
} from "./validate"

const selectedStateBrand = Symbol("sixb.selected-object-query-admission-state")

interface SelectedObjectQueryState extends ObjectQueryAdmissionState {
  readonly [selectedStateBrand]: true
  readonly selections: readonly CompiledObjectReadObjectSelection[]
}

export interface SelectedObjectQueryAdmission extends ObjectQuerySemanticAdmission {
  /** Terminal hook for property-bearing operations outside the query IR, such as facets. */
  assertPropertySelected(input: {
    readonly state: ObjectQueryAdmissionState
    readonly propertyId: string
    readonly objectTypeId?: string
    readonly use: ObjectQueryPropertyUse
    readonly path: string
  }): void
  /** Terminal hook for the physical-link selector that sits outside `queryLinks.query`. */
  assertIncidentEdgeSelected(input: {
    readonly state: ObjectQueryAdmissionState
    readonly linkId?: string
    readonly direction: "outgoing" | "incoming" | "both"
    readonly path: string
  }): void
}

/**
 * Build an immutable semantic admission over one already-compiled selected reader scope.
 *
 * Object identities remain provider-owned: query admission follows exact path occurrences while
 * the selected storage relation decides which live roots and linked instances exist.
 */
export function createSelectedObjectQueryAdmission(
  scope: CompiledSelectedObjectReadScope
): SelectedObjectQueryAdmission {
  const selectionByKey = new Map<string, CompiledObjectReadObjectSelection>()
  const selectionsByType = new Map<string, CompiledObjectReadObjectSelection[]>()
  const propertiesBySelection = new Map<string, ReadonlySet<string>>()

  for (const selection of scope.objects) {
    const key = selectionKey(selection.nodeId, selection.objectTypeId)
    selectionByKey.set(key, selection)
    propertiesBySelection.set(key, new Set(selection.propertyIds))
    const byType = selectionsByType.get(selection.objectTypeId) ?? []
    byType.push(selection)
    selectionsByType.set(selection.objectTypeId, byType)
  }

  const outgoing = indexSteps(scope.steps, "outgoing", selectionByKey)
  const incoming = indexSteps(scope.steps, "incoming", selectionByKey)
  const emptyState = selectedState([])

  const admission: SelectedObjectQueryAdmission = {
    empty: () => emptyState,
    source: (input) => {
      const selections = input.result.objectTypeIds.flatMap(
        (objectTypeId) => selectionsByType.get(objectTypeId) ?? []
      )
      const state = selectedState(selections)

      if (input.kind === "refs") {
        const missingType = [...new Set(input.refs?.map((ref) => ref.objectTypeId) ?? [])]
          .sort()
          .find((objectTypeId) => !selectionsByType.has(objectTypeId))
        if (missingType) {
          return denied(
            state,
            new AuthorizationError(
              `view:object:${missingType}`,
              `[Sixb] Delegated query cannot reference object type '${missingType}' at '${input.path}': the selected object scope does not contain that type.`
            )
          )
        }
      }

      if (state.selections.length > 0) return { state }
      const objectTypeId = input.objectTypeId ?? input.result.objectTypeIds[0] ?? "unknown"
      return denied(
        state,
        new AuthorizationError(
          `view:object:${objectTypeId}`,
          `[Sixb] Delegated query cannot start from object type '${objectTypeId}' at '${input.path}': the selected object scope does not contain that type.`
        )
      )
    },
    property: (input) =>
      propertyDenial(
        asSelectedState(input.state),
        input.propertyId,
        input.objectTypeId,
        input.use,
        input.path,
        propertiesBySelection
      ),
    edge: (input) => {
      const state = asSelectedState(input.state)
      const next = followEdge(
        state,
        input.linkId,
        input.direction,
        input.sourceObjectTypeId,
        outgoing,
        incoming,
        input.result.objectTypeIds
      )
      if (next.selections.length > 0 || state.selections.length === 0) return { state: next }
      return denied(
        next,
        edgeDenial(
          state,
          input.linkId,
          input.direction,
          input.sourceObjectTypeId,
          input.use,
          input.path
        )
      )
    },
    set: ({ op, states }) => {
      if (op === "subtract") return asSelectedState(states[0] ?? emptyState)
      return selectedState(states.flatMap((state) => asSelectedState(state).selections))
    },
    assertPropertySelected: (input) => {
      const denial = propertyDenial(
        asSelectedState(input.state),
        input.propertyId,
        input.objectTypeId,
        input.use,
        input.path,
        propertiesBySelection
      )
      if (denial) throw denial
    },
    assertIncidentEdgeSelected: (input) => {
      if (input.linkId === undefined) return
      const state = asSelectedState(input.state)
      const directions: readonly ("outgoing" | "incoming")[] =
        input.direction === "both" ? ["outgoing", "incoming"] : [input.direction]
      const next = selectedState(
        directions.flatMap(
          (direction) =>
            followEdge(state, input.linkId!, direction, undefined, outgoing, incoming).selections
        )
      )
      if (next.selections.length > 0 || state.selections.length === 0) return
      throw edgeDenial(state, input.linkId, input.direction, undefined, "queryLinks", input.path)
    },
  }

  return Object.freeze(admission)
}

function indexSteps(
  steps: readonly CompiledObjectReadStep[],
  direction: "outgoing" | "incoming",
  selectionByKey: ReadonlyMap<string, CompiledObjectReadObjectSelection>
): ReadonlyMap<string, readonly CompiledObjectReadObjectSelection[]> {
  const index = new Map<string, CompiledObjectReadObjectSelection[]>()
  for (const step of steps) {
    const fromKey =
      direction === "outgoing"
        ? selectionKey(step.parentNodeId, step.sourceObjectTypeId)
        : selectionKey(step.nodeId, step.targetObjectTypeId)
    const toKey =
      direction === "outgoing"
        ? selectionKey(step.nodeId, step.targetObjectTypeId)
        : selectionKey(step.parentNodeId, step.sourceObjectTypeId)
    const target = selectionByKey.get(toKey)
    if (!selectionByKey.has(fromKey) || !target) {
      throw new Error("[Sixb] Compiled selected object scope contains an invalid query path step.")
    }
    const key = edgeKey(
      direction === "outgoing" ? step.parentNodeId : step.nodeId,
      direction === "outgoing" ? step.sourceObjectTypeId : step.targetObjectTypeId,
      step.linkId
    )
    const targets = index.get(key) ?? []
    targets.push(target)
    index.set(key, targets)
  }
  return index
}

function followEdge(
  state: SelectedObjectQueryState,
  linkId: string,
  direction: "outgoing" | "incoming",
  sourceObjectTypeId: string | undefined,
  outgoing: ReadonlyMap<string, readonly CompiledObjectReadObjectSelection[]>,
  incoming: ReadonlyMap<string, readonly CompiledObjectReadObjectSelection[]>,
  resultObjectTypeIds?: readonly string[]
): SelectedObjectQueryState {
  const index = direction === "outgoing" ? outgoing : incoming
  const resultTypes = resultObjectTypeIds ? new Set(resultObjectTypeIds) : undefined
  const selections = state.selections.flatMap((selection) => {
    const candidates = index.get(edgeKey(selection.nodeId, selection.objectTypeId, linkId)) ?? []
    return candidates.filter(
      (candidate) =>
        (resultTypes === undefined || resultTypes.has(candidate.objectTypeId)) &&
        (direction === "outgoing" ||
          sourceObjectTypeId === undefined ||
          candidate.objectTypeId === sourceObjectTypeId)
    )
  })
  return selectedState(selections)
}

function propertyDenial(
  state: SelectedObjectQueryState,
  propertyId: string,
  objectTypeId: string | undefined,
  use: ObjectQueryPropertyUse,
  path: string,
  propertiesBySelection: ReadonlyMap<string, ReadonlySet<string>>
): AuthorizationError | undefined {
  const candidates = objectTypeId
    ? state.selections.filter((selection) => selection.objectTypeId === objectTypeId)
    : state.selections
  // A selected reader has no rows for result types absent from this provenance. Those empty
  // branches cannot observe a property and must not make includeSubtypes queries fail closed.
  if (candidates.length === 0) return undefined

  const missing = candidates.find(
    (selection) =>
      !propertiesBySelection
        .get(selectionKey(selection.nodeId, selection.objectTypeId))
        ?.has(propertyId)
  )
  if (!missing) return undefined

  const objectTypeIds = [...new Set(candidates.map((selection) => selection.objectTypeId))].sort()
  return new AuthorizationError(
    `view:object:${objectTypeIds.join(",")}:property:${propertyId}`,
    `[Sixb] Delegated query cannot use property '${propertyId}' for ${use} at '${path}': it is not selected on every matching read-scope path (missing on ${formatSelection(missing)}).`
  )
}

function edgeDenial(
  state: SelectedObjectQueryState,
  linkId: string,
  direction: "outgoing" | "incoming" | "both",
  sourceObjectTypeId: string | undefined,
  use: ObjectQueryEdgeUse,
  path: string
): AuthorizationError {
  const source = sourceObjectTypeId ? `:${sourceObjectTypeId}` : ""
  return new AuthorizationError(
    `view:link:${direction}${source}:${linkId}`,
    `[Sixb] Delegated query cannot use ${direction} link '${linkId}' for ${use} from ${formatState(state)} at '${path}': that exact read-scope path is not selected.`
  )
}

function formatState(state: SelectedObjectQueryState): string {
  if (state.selections.length === 0) return "an empty read-scope provenance"
  return `read-scope provenance ${state.selections.map(formatSelection).join(", ")}`
}

function formatSelection(selection: CompiledObjectReadObjectSelection): string {
  return `'${selection.objectTypeId}'@node ${selection.nodeId}`
}

function selectedState(
  selections: readonly CompiledObjectReadObjectSelection[]
): SelectedObjectQueryState {
  const unique = new Map<string, CompiledObjectReadObjectSelection>()
  for (const selection of selections) {
    unique.set(selectionKey(selection.nodeId, selection.objectTypeId), selection)
  }
  return Object.freeze({
    [selectedStateBrand]: true as const,
    selections: Object.freeze(
      [...unique.values()].sort(
        (left, right) =>
          left.nodeId - right.nodeId || left.objectTypeId.localeCompare(right.objectTypeId)
      )
    ),
  })
}

function asSelectedState(state: ObjectQueryAdmissionState): SelectedObjectQueryState {
  if ((state as Partial<SelectedObjectQueryState>)[selectedStateBrand] !== true) {
    throw new Error("[Sixb] Object query admission state belongs to another semantic admission.")
  }
  return state as SelectedObjectQueryState
}

function denied(state: SelectedObjectQueryState, denial: Error): ObjectQueryAdmissionTransition {
  return { state, denial }
}

function selectionKey(nodeId: number, objectTypeId: string): string {
  return JSON.stringify([nodeId, objectTypeId])
}

function edgeKey(nodeId: number, objectTypeId: string, linkId: string): string {
  return JSON.stringify([nodeId, objectTypeId, linkId])
}
