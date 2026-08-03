import { SixbError } from "../errors"
import type { EventSelectorSpec } from "../events/selectors"
import type { ObjectLink, ObjectType, OntologyRegistry } from "../ontology"
import { assertPredicateShape, type Predicate } from "../predicates"
import { createCronMatcher } from "./cron"
import type { EventScheduleCondition, EventScheduleDefinition, ScheduleDefinition } from "./types"

const objectEventTypes = new Set(["object.created", "object.updated", "object.deleted"])
const linkEventTypes = new Set(["link.created", "link.updated", "link.deleted"])
const ruleEventTypes = new Set(["rule.triggered", "rule.resolved"])
const actionEventTypes = new Set(["action.requested", "action.completed", "action.failed"])
const datasetEventTypes = new Set(["dataset.version.committed"])
const syncEventTypes = new Set(["sync.run.finished"])
const pipelineEventTypes = new Set(["pipeline.run.finished"])
const runStatuses = new Set(["succeeded", "failed", "cancelled"])
const linkIdentityFields = new Set(["target.objectTypeId", "target.primaryId"])

export interface ValidateSchedulesAtStartupOptions {
  readonly registeredRuleIds?: ReadonlySet<string>
  readonly registeredActionIds?: ReadonlySet<string>
  readonly registeredDatasetIds?: ReadonlySet<string>
  readonly registeredSyncIds?: ReadonlySet<string>
  readonly registeredPipelineIds?: ReadonlySet<string>
}

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

export function assertScheduleDefinition(
  value: unknown,
  createError: (message: string) => Error = (message) =>
    new SixbError("runtime.invalid_definition", message)
): asserts value is ScheduleDefinition {
  if (!isRecord(value)) throw createError("Schedule definition must be an object.")
  if (value.kind !== "schedule") {
    throw createError("Schedule definition kind must be 'schedule'.")
  }

  assertNonEmptyString(value.id, "Schedule id", createError)
  if (!isRecord(value.trigger))
    throw createError(`Schedule "${value.id}" trigger must be an object.`)

  if (value.trigger.type === "cron") {
    assertNonEmptyString(
      value.trigger.expression,
      `Schedule "${value.id}" cron expression`,
      createError
    )
    if (value.trigger.timezone !== undefined && typeof value.trigger.timezone !== "string") {
      throw createError(`Schedule "${value.id}" timezone must be a string.`)
    }
    return
  }

  if (value.trigger.type !== "event") {
    throw createError(`Schedule "${value.id}" trigger type is unsupported.`)
  }

  assertEventSourceShape(value.trigger.source, `Schedule "${value.id}" event source`, createError)
  if (value.trigger.condition !== undefined) {
    assertEventConditionShape(
      value.trigger.condition,
      `Schedule "${value.id}" condition`,
      createError
    )
  }
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  try {
    assertScheduleDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

export function validateSchedulesAtStartup(
  schedules: readonly ScheduleDefinition[],
  ontology: OntologyRegistry,
  options: ValidateSchedulesAtStartupOptions = {}
): void {
  const seenIds = new Set<string>()

  for (const schedule of schedules) {
    assertScheduleDefinition(schedule)
    if (seenIds.has(schedule.id)) {
      throw new SixbError("runtime.invalid_definition", `Duplicate schedule id: ${schedule.id}`)
    }
    seenIds.add(schedule.id)

    if (schedule.trigger.type === "cron") {
      createCronMatcher(schedule.trigger.expression)
      if (schedule.trigger.timezone !== undefined) validateTimezone(schedule.trigger.timezone)
      continue
    }

    validateEventSchedule(schedule as EventScheduleDefinition, ontology, options)
  }
}

function validateTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    throw new SixbError("runtime.invalid_definition", `Invalid timezone '${timezone}'.`)
  }
}

function assertEventSourceShape(
  value: unknown,
  path: string,
  createError: (message: string) => Error
): asserts value is EventSelectorSpec {
  if (!isRecord(value)) throw createError(`${path} must be an event selector.`)
  if (!Array.isArray(value.types) || value.types.length === 0) {
    throw createError(`${path} must select at least one event type.`)
  }

  switch (value.topic) {
    case "objects":
      assertNonEmptyString(value.objectTypeId, `${path} objectTypeId`, createError)
      return
    case "links":
      assertNonEmptyString(value.objectTypeId, `${path} objectTypeId`, createError)
      assertNonEmptyString(value.linkId, `${path} linkId`, createError)
      return
    case "rules":
      assertNonEmptyString(value.ruleId, `${path} ruleId`, createError)
      return
    case "actions":
      assertNonEmptyString(value.actionId, `${path} actionId`, createError)
      return
    case "datasets":
      assertNonEmptyString(value.datasetId, `${path} datasetId`, createError)
      return
    case "syncs":
      assertNonEmptyString(value.syncId, `${path} syncId`, createError)
      assertRunStatus(value.runStatus, path, createError)
      return
    case "pipelines":
      assertNonEmptyString(value.pipelineId, `${path} pipelineId`, createError)
      assertRunStatus(value.runStatus, path, createError)
      return
    default:
      throw createError(
        `${path} must select object, link, rule, action, dataset, sync, or pipeline events.`
      )
  }
}

function assertRunStatus(
  value: unknown,
  path: string,
  createError: (message: string) => Error
): void {
  if (typeof value !== "string" || !runStatuses.has(value)) {
    throw createError(`${path} must select succeeded, failed, or cancelled runs.`)
  }
}

function assertEventConditionShape(
  value: unknown,
  path: string,
  createError: (message: string) => Error
): asserts value is EventScheduleCondition {
  if (!isRecord(value)) throw createError(`${path} must be an object.`)
  if (value.kind !== "becomesTrue") throw createError(`${path} kind must be 'becomesTrue'.`)
  if (value.scope !== "event.object" && value.scope !== "event.link") {
    throw createError(`${path} scope must be 'event.object' or 'event.link'.`)
  }
  assertPredicateShape(value.predicate, { subject: "Schedule", createError })
}

function validateEventSchedule(
  schedule: EventScheduleDefinition,
  ontology: OntologyRegistry,
  options: ValidateSchedulesAtStartupOptions
): void {
  const { source } = schedule.trigger

  switch (source.topic) {
    case "objects":
    case "links": {
      const objectTypeId = source.objectTypeId
      const objectType = objectTypeId ? ontology.getObjectTypeById(objectTypeId) : undefined
      if (!objectType) {
        throw new SixbError(
          "runtime.invalid_definition",
          `Schedule "${schedule.id}": unknown object type "${objectTypeId}".`
        )
      }
      if (source.topic === "objects") validateObjectSource(schedule, objectType)
      else validateLinkSource(schedule, objectType)
      return
    }
    case "rules":
      validateRegisteredSource(
        schedule,
        source.ruleId,
        options.registeredRuleIds,
        ruleEventTypes,
        "rule"
      )
      return
    case "actions":
      validateRegisteredSource(
        schedule,
        source.actionId,
        options.registeredActionIds,
        actionEventTypes,
        "action"
      )
      return
    case "datasets":
      validateRegisteredSource(
        schedule,
        source.datasetId,
        options.registeredDatasetIds,
        datasetEventTypes,
        "dataset"
      )
      return
    case "syncs":
      validateRegisteredSource(
        schedule,
        source.syncId,
        options.registeredSyncIds,
        syncEventTypes,
        "sync"
      )
      return
    case "pipelines":
      validateRegisteredSource(
        schedule,
        source.pipelineId,
        options.registeredPipelineIds,
        pipelineEventTypes,
        "pipeline"
      )
      return
  }
}

function validateObjectSource(schedule: EventScheduleDefinition, objectType: ObjectType): void {
  validateEventTypes(schedule, objectEventTypes, "object")
  const propertyIds = new Set(objectType.properties.map((property) => property.id))
  validateSelectorProperty(schedule, propertyIds)

  const condition = schedule.trigger.condition
  if (!condition) return
  if (condition.scope !== "event.object") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": object event sources can only use event.object conditions.`
    )
  }
  validateConditionPredicate(schedule, propertyIds, condition.predicate)
}

function validateLinkSource(schedule: EventScheduleDefinition, objectType: ObjectType): void {
  validateEventTypes(schedule, linkEventTypes, "link")
  const source = schedule.trigger.source
  const link = objectType.links.find((candidate) => candidate.id === source.linkId)
  if (!link) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": unknown link "${source.linkId}" on object type "${objectType.id}".`
    )
  }

  const propertyIds = new Set((link.properties ?? []).map((property) => property.id))
  validateSelectorProperty(schedule, propertyIds)

  const condition = schedule.trigger.condition
  if (!condition) return
  if (condition.scope !== "event.link") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": link event sources can only use event.link conditions.`
    )
  }
  validateConditionPredicate(schedule, propertyIds, condition.predicate, link)
}

function validateRegisteredSource(
  schedule: EventScheduleDefinition,
  sourceId: string | undefined,
  registeredIds: ReadonlySet<string> | undefined,
  supportedTypes: ReadonlySet<string>,
  sourceKind: "rule" | "action" | "dataset" | "sync" | "pipeline"
): void {
  validateEventTypes(schedule, supportedTypes, sourceKind)
  if (!registeredIds?.has(sourceId ?? "")) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": unknown ${sourceKind} "${sourceId}".`
    )
  }
  if (schedule.trigger.condition) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": ${sourceKind} event sources do not support .where() conditions.`
    )
  }
}

function validateEventTypes(
  schedule: EventScheduleDefinition,
  supportedTypes: ReadonlySet<string>,
  sourceKind: string
): void {
  for (const type of schedule.trigger.source.types ?? []) {
    if (!supportedTypes.has(type)) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Schedule "${schedule.id}": unsupported ${sourceKind} event type "${type}".`
      )
    }
  }
}

function validateSelectorProperty(
  schedule: EventScheduleDefinition,
  propertyIds: ReadonlySet<string>
): void {
  const propertyId = schedule.trigger.source.propertyId
  if (propertyId !== undefined && !propertyIds.has(propertyId)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": unknown selector property "${propertyId}".`
    )
  }
}

function validateConditionPredicate(
  schedule: EventScheduleDefinition,
  propertyIds: ReadonlySet<string>,
  predicate: Predicate,
  link?: ObjectLink
): void {
  if (predicate.kind === "all" || predicate.kind === "any") {
    if (predicate.predicates.length === 0) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Schedule "${schedule.id}": ${predicate.kind} predicate must contain at least one predicate.`
      )
    }
    for (const child of predicate.predicates) {
      validateConditionPredicate(schedule, propertyIds, child, link)
    }
    return
  }

  if (predicate.kind === "not") {
    validateConditionPredicate(schedule, propertyIds, predicate.predicate, link)
    return
  }

  if (predicate.kind === "link") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": link predicates are not supported in event conditions.`
    )
  }

  if (predicate.kind === "field") {
    if (!link || !linkIdentityFields.has(predicate.field)) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Schedule "${schedule.id}": unsupported event field predicate "${predicate.field}".`
      )
    }
    if (typeof predicate.value !== "string" || !predicate.value.trim()) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Schedule "${schedule.id}": event field "${predicate.field}" must compare against a non-empty string.`
      )
    }
    if (predicate.field === "target.objectTypeId") {
      const targetIds = Array.isArray(link.targetObjectTypeId)
        ? link.targetObjectTypeId
        : [link.targetObjectTypeId]
      if (!targetIds.includes("*") && !targetIds.includes(predicate.value)) {
        throw new SixbError(
          "runtime.invalid_definition",
          `Schedule "${schedule.id}": object type "${predicate.value}" is not a target of link "${link.id}".`
        )
      }
    }
    return
  }

  if (!propertyIds.has(predicate.propertyId)) {
    const source = schedule.trigger.source
    const subject = link ? `link "${link.id}"` : `object type "${source.objectTypeId}"`
    throw new SixbError(
      "runtime.invalid_definition",
      `Schedule "${schedule.id}": unknown property "${predicate.propertyId}" on ${subject}.`
    )
  }
}
