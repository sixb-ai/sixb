import { ObjectQueryValidationError } from "../objects/query/errors"
import type { ObjectQueryPredicate } from "../objects/query/ir"
import {
  type ObjectQuerySemanticAdmission,
  validateObjectQueryWithAdmission,
} from "../objects/query/validate"
import type { OntologyRegistry } from "../ontology"
import { SecurityValidationError } from "./errors"
import type { GrantDefinition, Selection } from "./types"

/** A role's `can.view(Type).where(...)`, validated against the ontology at startup. */
export interface ViewCondition {
  readonly roleId: string
  /** The type the grant names. The condition also applies to its subtypes. */
  readonly objectTypeId: string
  /**
   * The condition as the validator returns it, `scalarKind` resolved, and deeply frozen. It may
   * still hold `currentUser()`, which each reader binds to its own user.
   */
  readonly predicate: ObjectQueryPredicate
}

/**
 * Validate a role grant's condition at startup: `can.view(Type).where(...)`.
 *
 * The condition is validated as a filter over the type and every subtype the grant covers, which
 * is the query its reads run. Without an ontology there is nothing to validate it against, so it
 * is refused.
 */
export function resolveViewCondition(
  roleId: string,
  grant: GrantDefinition,
  ontology: OntologyRegistry | undefined
): ViewCondition | undefined {
  if (!("condition" in grant) || grant.condition === undefined) return undefined

  const objectTypeId =
    grant.capability === "view" && grant.target === "object" ? onlyId(grant.selection) : undefined

  if (objectTypeId === undefined) {
    throw new SecurityValidationError(
      `[Sixb] Role '${roleId}' declares a condition on a grant that is not a view grant on one object type. Write can.view(Type).where(...).`
    )
  }

  const subject = viewConditionSubject({ roleId, objectTypeId })

  if (!ontology) {
    throw new SecurityValidationError(`[Sixb] ${subject} needs the ontology to be validated.`)
  }

  const objectTypeIds = [objectTypeId, ...ontology.listSubTypes(objectTypeId)]

  try {
    const validated = validateObjectQueryWithAdmission(
      {
        kind: "filter",
        input: { kind: "start", objectTypeId, includeSubtypes: true },
        predicate: grant.condition,
      },
      { ontology },
      unmarkedPropertiesOnly(subject, objectTypeIds, ontology)
    )

    if (validated.query.kind !== "filter") {
      throw new Error(`[Sixb] ${subject} did not validate as a filter.`)
    }

    const ordered = orderedTextComparison(validated.query.predicate)
    if (ordered) {
      throw new SecurityValidationError(
        `[Sixb] ${subject} compares '${objectTypeId}.${ordered.propertyId}' with ${ordered.op}(). Storage providers order text differently, so a condition cannot order text: compare with eq, neq, in or contains instead.`
      )
    }

    return {
      roleId,
      objectTypeId,
      predicate: deepFreeze(structuredClone(validated.query.predicate)),
    }
  } catch (error) {
    if (!(error instanceof ObjectQueryValidationError)) throw error

    const reasons = error.issues.map((issue) => issue.message).join("; ")
    throw new SecurityValidationError(`[Sixb] ${subject}: ${reasons}`)
  }
}

/**
 * A type a reader sees only through a condition is denied by events, telemetry, runs, files and
 * writes, which do not apply conditions yet. Every condition is refused until they do, so a role
 * never grants less than it reads as granting.
 */
export function refuseViewConditions(conditions: readonly ViewCondition[]): void {
  const [first] = conditions
  if (first === undefined) return

  throw new SecurityValidationError(`[Sixb] ${viewConditionSubject(first)} is not supported yet.`)
}

function viewConditionSubject(condition: Pick<ViewCondition, "roleId" | "objectTypeId">): string {
  return `Role '${condition.roleId}': can.view(${condition.objectTypeId}).where(...)`
}

/**
 * PostgreSQL orders text by the database collation, SQLite and the in-memory store by code unit, so
 * `code.gte("M")` would show different objects depending on the store.
 */
function orderedTextComparison(
  predicate: ObjectQueryPredicate
): { readonly propertyId: string; readonly op: string } | null {
  switch (predicate.op) {
    case "and":
    case "or":
      for (const item of predicate.items) {
        const ordered = orderedTextComparison(item)
        if (ordered) return ordered
      }
      return null

    case "not":
      return orderedTextComparison(predicate.item)

    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return predicate.scalarKind === "string" || predicate.scalarKind === "uuid"
        ? { propertyId: predicate.propertyId, op: predicate.op }
        : null

    default:
      return null
  }
}

function onlyId(selection: Selection): string | undefined {
  if (selection.all || selection.ids.length !== 1) return undefined
  return selection.ids[0]
}

/**
 * Refuse a condition that reads a marked property, on the type or on any subtype the grant covers.
 * Which objects match would reveal values their reader cannot read.
 *
 * The validator walks the condition and reports each property it reads; its own issues are raised
 * before this denial.
 */
function unmarkedPropertiesOnly(
  subject: string,
  objectTypeIds: readonly string[],
  ontology: OntologyRegistry
): ObjectQuerySemanticAdmission {
  const state = Object.freeze({})

  const admission: ObjectQuerySemanticAdmission = {
    empty: () => state,
    source: () => ({ state }),
    edge: () => ({ state }),
    set: () => state,
    property: ({ propertyId }) => {
      for (const objectTypeId of objectTypeIds) {
        const property = ontology
          .getObjectTypeById(objectTypeId)
          ?.properties.find((candidate) => candidate.id === propertyId)

        const markings = property?.markings ?? []
        if (markings.length === 0) continue

        return new SecurityValidationError(
          `[Sixb] ${subject} reads '${objectTypeId}.${propertyId}', which carries [${markings.join(", ")}]. A condition can only read unmarked properties.`
        )
      }

      return undefined
    },
  }

  return Object.freeze(admission)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value

  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
