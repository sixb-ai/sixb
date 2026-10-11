import { AuthorizationError } from "../../authorization/errors"
import { type PropertyClearance, type Unreadable, unreadableError } from "../property-clearance"
import type {
  ObjectQueryAdmissionState,
  ObjectQueryPropertyUse,
  ObjectQuerySemanticAdmission,
} from "./validate"

/**
 * Reject every query use of a property the reader cannot read, except projection.
 *
 * Filtering, ordering, searching, or faceting by a hidden value would reveal it through which
 * objects match and in what order. Projection only shapes the output, which is redacted anyway.
 */
export function createClearanceQueryAdmission(
  clearance: PropertyClearance
): ObjectQuerySemanticAdmission {
  // Each state stands for the object types a query has reached so far. A property without an
  // explicit type is checked against all of them.
  const reachedTypes = new WeakMap<ObjectQueryAdmissionState, readonly string[]>()
  const state = (objectTypeIds: readonly string[]): ObjectQueryAdmissionState => {
    const created = Object.freeze({})
    reachedTypes.set(created, Object.freeze([...objectTypeIds]))
    return created
  }

  const reached = (input: ObjectQueryAdmissionState): readonly string[] => {
    const objectTypeIds = reachedTypes.get(input)
    if (!objectTypeIds) {
      throw new Error("[Sixb] Clearance query admission received a state it did not create.")
    }
    return objectTypeIds
  }

  const empty = state([])

  const admission: ObjectQuerySemanticAdmission = {
    empty: () => empty,
    // An object type or link the reader cannot read is denied like one it has no view grant for.
    source: (input) => ({
      state: state(input.result.objectTypeIds),
      ...denied(unreadableTypeAmong(clearance, input.result.objectTypeIds)),
    }),
    edge: (input) => {
      // A link is keyed by its source type: the reached types going out, the result coming in.
      const sourceTypeIds =
        input.direction === "outgoing"
          ? reached(input.state)
          : [
              ...input.result.objectTypeIds,
              ...(input.sourceObjectTypeId ? [input.sourceObjectTypeId] : []),
            ]

      const link = sourceTypeIds
        .map((objectTypeId) => clearance.unreadableLink(objectTypeId, input.linkId))
        .find((unreadable) => unreadable !== undefined)

      return {
        state: state(input.result.objectTypeIds),
        ...denied(link ?? unreadableTypeAmong(clearance, input.result.objectTypeIds)),
      }
    },
    // A difference only returns objects of its first input.
    set: (input) =>
      input.op === "subtract"
        ? (input.states[0] ?? empty)
        : state([...new Set(input.states.flatMap(reached))]),
    property: (input) => {
      if (input.use === "project") return undefined

      const objectTypeIds =
        input.objectTypeId === undefined ? reached(input.state) : [input.objectTypeId]
      for (const objectTypeId of objectTypeIds) {
        const marking = clearance.missingMarking(objectTypeId, input.propertyId)
        if (marking === undefined) continue
        return new AuthorizationError(
          `clearance:marking:${marking}`,
          `[Sixb] Cannot ${PROPERTY_USE_VERBS[input.use]} '${objectTypeId}.${input.propertyId}' at '${input.path}': it requires clearance for marking '${marking}'.`
        )
      }

      return undefined
    },
  }

  return Object.freeze(admission)
}

function unreadableTypeAmong(
  clearance: PropertyClearance,
  objectTypeIds: readonly string[]
): Unreadable | undefined {
  for (const objectTypeId of objectTypeIds) {
    const unreadable = clearance.unreadableType(objectTypeId)
    if (unreadable) return unreadable
  }
  return undefined
}

function denied(unreadable: Unreadable | undefined): { readonly denial?: Error } {
  return unreadable ? { denial: unreadableError(unreadable) } : {}
}

const PROPERTY_USE_VERBS: Readonly<Record<ObjectQueryPropertyUse, string>> = {
  filter: "filter by",
  text: "search",
  vector: "run a vector search over",
  sort: "sort by",
  project: "project",
  "expand.orderBy": "order expanded objects by",
  facet: "facet by",
}
