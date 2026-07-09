import type { EventSelectorSpec } from "../events/selectors"
import type { ObjectLink, ObjectType, OntologyRegistry } from "../ontology"
import { assertPredicateShape, type Predicate } from "../predicates"
import { TriggerValidationError } from "./errors"
import type { TriggerCondition, TriggerDefinition } from "./types"

const objectEventTypes = new Set(["object.created", "object.updated", "object.deleted"])
const linkEventTypes = new Set(["link.created", "link.updated", "link.deleted"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  createError: (message: string) => Error
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(`${field} must not be empty.`)
  }
}

export function assertTriggerDefinition(
  value: unknown,
  createError: (message: string) => Error = (message) => new TriggerValidationError(message)
): asserts value is TriggerDefinition {
  if (!isRecord(value)) {
    throw createError("Trigger definition must be an object.")
  }

  if (value.kind !== "trigger") {
    throw createError("Trigger definition kind must be 'trigger'.")
  }

  assertNonEmptyString(value.id, "Trigger id", createError)
  assertTriggerSourceShape(value.source, `Trigger "${value.id}" source`, createError)

  if (value.condition !== undefined) {
    assertTriggerConditionShape(value.condition, `Trigger "${value.id}" condition`, createError)
  }
}

export function isTriggerDefinition(value: unknown): value is TriggerDefinition {
  try {
    assertTriggerDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function validateTriggersAtStartup(
  triggers: readonly TriggerDefinition[],
  ontology: OntologyRegistry
): void {
  const seenTriggerIds = new Set<string>()

  for (const trigger of triggers) {
    assertTriggerDefinition(trigger)

    if (seenTriggerIds.has(trigger.id)) {
      throw new TriggerValidationError(`Duplicate trigger id: ${trigger.id}`)
    }
    seenTriggerIds.add(trigger.id)

    const objectTypeId = trigger.source.objectTypeId
    if (!objectTypeId) {
      throw new TriggerValidationError(`Trigger "${trigger.id}": source objectTypeId is missing.`)
    }

    const objectType = ontology.getObjectTypeById(objectTypeId)
    if (!objectType) {
      throw new TriggerValidationError(
        `Trigger "${trigger.id}": unknown object type "${objectTypeId}".`
      )
    }

    if (trigger.source.topic === "objects") {
      validateObjectTriggerSource(trigger, objectType)
      continue
    }

    validateLinkTriggerSource(trigger, objectType)
  }
}

function assertTriggerSourceShape(
  value: unknown,
  path: string,
  createError: (message: string) => Error
): asserts value is EventSelectorSpec & { topic: "objects" | "links"; objectTypeId: string } {
  if (!isRecord(value)) {
    throw createError(`${path} must be an event selector.`)
  }

  if (value.topic !== "objects" && value.topic !== "links") {
    throw createError(`${path} must select object or link events.`)
  }

  assertNonEmptyString(value.objectTypeId, `${path} objectTypeId`, createError)

  if (!Array.isArray(value.types) || value.types.length === 0) {
    throw createError(`${path} must select at least one event type.`)
  }

  if (value.topic === "links") {
    assertNonEmptyString(value.linkId, `${path} linkId`, createError)
  }
}

function assertTriggerConditionShape(
  value: unknown,
  path: string,
  createError: (message: string) => Error
): asserts value is TriggerCondition {
  if (!isRecord(value)) {
    throw createError(`${path} must be an object.`)
  }

  if (value.kind !== "becomesTrue") {
    throw createError(`${path} kind must be 'becomesTrue'.`)
  }

  if (value.scope !== "event.object" && value.scope !== "event.link") {
    throw createError(`${path} scope must be 'event.object' or 'event.link'.`)
  }

  assertPredicateShape(value.predicate, { subject: "Trigger", createError })
}

function validateObjectTriggerSource(trigger: TriggerDefinition, objectType: ObjectType): void {
  for (const type of trigger.source.types ?? []) {
    if (!objectEventTypes.has(type)) {
      throw new TriggerValidationError(
        `Trigger "${trigger.id}": unsupported object event type "${type}".`
      )
    }
  }

  const propertyIds = new Set(objectType.properties.map((property) => property.id))
  validateSelectorProperty(trigger, propertyIds)

  if (!trigger.condition) return
  if (trigger.condition.scope !== "event.object") {
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": object triggers can only use event.object conditions.`
    )
  }
  validateTriggerPredicate(trigger, propertyIds, trigger.condition.predicate)
}

function validateLinkTriggerSource(trigger: TriggerDefinition, objectType: ObjectType): void {
  for (const type of trigger.source.types ?? []) {
    if (!linkEventTypes.has(type)) {
      throw new TriggerValidationError(
        `Trigger "${trigger.id}": unsupported link event type "${type}".`
      )
    }
  }

  const link = objectType.links.find((candidate) => candidate.id === trigger.source.linkId)
  if (!link) {
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": unknown link "${trigger.source.linkId}" on object type "${objectType.id}".`
    )
  }

  const propertyIds = new Set((link.properties ?? []).map((property) => property.id))
  validateSelectorProperty(trigger, propertyIds)

  if (!trigger.condition) return
  if (trigger.condition.scope !== "event.link") {
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": link triggers can only use event.link conditions.`
    )
  }
  validateTriggerPredicate(trigger, propertyIds, trigger.condition.predicate, link)
}

function validateSelectorProperty(
  trigger: TriggerDefinition,
  propertyIds: ReadonlySet<string>
): void {
  if (trigger.source.propertyId === undefined) {
    return
  }

  if (!propertyIds.has(trigger.source.propertyId)) {
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": unknown selector property "${trigger.source.propertyId}".`
    )
  }
}

function validateTriggerPredicate(
  trigger: TriggerDefinition,
  propertyIds: ReadonlySet<string>,
  predicate: Predicate,
  link?: ObjectLink
): void {
  if (predicate.kind === "all" || predicate.kind === "any") {
    if (predicate.predicates.length === 0) {
      throw new TriggerValidationError(
        `Trigger "${trigger.id}": ${predicate.kind} predicate must contain at least one predicate.`
      )
    }

    for (const child of predicate.predicates) {
      validateTriggerPredicate(trigger, propertyIds, child, link)
    }
    return
  }

  if (predicate.kind === "not") {
    validateTriggerPredicate(trigger, propertyIds, predicate.predicate, link)
    return
  }

  if (predicate.kind === "link") {
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": link predicates are not supported in trigger conditions.`
    )
  }

  if (!propertyIds.has(predicate.propertyId)) {
    const subject = link ? `link "${link.id}"` : `object type "${trigger.source.objectTypeId}"`
    throw new TriggerValidationError(
      `Trigger "${trigger.id}": unknown property "${predicate.propertyId}" on ${subject}.`
    )
  }
}
