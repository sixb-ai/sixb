import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  canViewEvent,
  evaluate,
  isAllowed,
  type StoredActionRequestedEvent,
  type StoredLinkUpsertedEvent,
  type StoredObjectUpsertedEvent,
  type StoredScheduleTriggeredEvent,
  type StoredTelemetryAppendedEvent,
  type StoredWorkflowRunStartedEvent,
} from "../src"

function context(grants: {
  view?: readonly string[]
  apply?: readonly string[]
  start?: readonly string[]
}): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: {
      objectTypes: { view: new Set(grants.view ?? []) },
      actions: { apply: new Set(grants.apply ?? []) },
      workflows: { start: new Set(grants.start ?? []) },
    },
  }
}

describe("evaluate", () => {
  test("reports the requirement and allows when the grant is held", () => {
    expect(
      evaluate(context({ view: ["quote"] }), { kind: "object.view", objectTypeId: "quote" })
    ).toEqual({ allowed: true, requirements: ["view:object:quote"], missing: [] })
  })

  test("reports the missing requirement when the grant is absent", () => {
    expect(evaluate(context({}), { kind: "object.view", objectTypeId: "quote" })).toEqual({
      allowed: false,
      requirements: ["view:object:quote"],
      missing: ["view:object:quote"],
    })
  })

  test("object.query requires every touched type and lists only the unviewable ones", () => {
    const decision = evaluate(context({ view: ["quote"] }), {
      kind: "object.query",
      touchedObjectTypeIds: ["quote", "contact"],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.requirements).toEqual(["view:object:quote", "view:object:contact"])
    expect(decision.missing).toEqual(["view:object:contact"])
  })

  test("a missing authorization context (privileged caller) allows everything", () => {
    expect(evaluate(null, { kind: "object.view", objectTypeId: "anything" })).toEqual({
      allowed: true,
      requirements: ["view:object:anything"],
      missing: [],
    })
    expect(isAllowed(undefined, { kind: "workflow.start", workflowId: "w" })).toBe(true)
  })
})

const envelope = {
  id: "evt_1",
  schemaVersion: 1 as const,
  projectId: "p1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  cursor: "c1",
}

const objectEvent: StoredObjectUpsertedEvent = {
  ...envelope,
  type: "object.upserted",
  topic: "objects",
  partitionKey: "note/n1",
  payload: { objectTypeId: "note", primaryId: "n1", properties: {} },
}

const telemetryEvent: StoredTelemetryAppendedEvent = {
  ...envelope,
  type: "telemetry.appended",
  topic: "telemetry",
  partitionKey: "note/n1",
  payload: {
    objectTypeId: "note",
    objectId: "n1",
    propertyId: "temp",
    value: 1,
    at: envelope.occurredAt,
  },
}

const linkEvent: StoredLinkUpsertedEvent = {
  ...envelope,
  type: "link.upserted",
  topic: "links",
  partitionKey: "note/n1",
  payload: {
    sourceTypeId: "note",
    sourceId: "n1",
    linkId: "author",
    targetTypeId: "user",
    targetId: "u1",
  },
}

const actionEvent: StoredActionRequestedEvent = {
  ...envelope,
  type: "action.requested",
  topic: "actions",
  partitionKey: "note/n1",
  payload: {
    actionId: "acknowledge-note",
    subject: { kind: "object", objectTypeId: "note", primaryId: "n1" },
    params: {},
    runId: "r1",
  },
}

const workflowEvent: StoredWorkflowRunStartedEvent = {
  ...envelope,
  type: "workflow.run.started",
  topic: "workflows",
  partitionKey: "review/r1",
  payload: { workflowId: "review", runId: "r1", startedAt: envelope.occurredAt },
}

const scheduleEvent: StoredScheduleTriggeredEvent = {
  ...envelope,
  type: "schedule.triggered",
  topic: "schedules",
  partitionKey: "nightly",
  payload: {
    scheduleId: "nightly",
    occurrenceAt: envelope.occurredAt,
    triggeredAt: envelope.occurredAt,
    occurrenceKey: "k1",
  },
}

describe("canViewEvent", () => {
  test("object and telemetry events require viewing the subject type", () => {
    expect(canViewEvent(context({ view: ["note"] }), objectEvent)).toBe(true)
    expect(canViewEvent(context({}), objectEvent)).toBe(false)
    expect(canViewEvent(context({ view: ["note"] }), telemetryEvent)).toBe(true)
    expect(canViewEvent(context({}), telemetryEvent)).toBe(false)
  })

  test("link events require viewing BOTH the source and the target type", () => {
    expect(canViewEvent(context({ view: ["note", "user"] }), linkEvent)).toBe(true)
    // Seeing the source but not the target must not leak the link (or the target id).
    expect(canViewEvent(context({ view: ["note"] }), linkEvent)).toBe(false)
    expect(canViewEvent(context({ view: ["user"] }), linkEvent)).toBe(false)
  })

  test("action events require apply; workflow events require start", () => {
    expect(canViewEvent(context({ apply: ["acknowledge-note"] }), actionEvent)).toBe(true)
    expect(canViewEvent(context({ view: ["note"] }), actionEvent)).toBe(false)
    expect(canViewEvent(context({ start: ["review"] }), workflowEvent)).toBe(true)
    expect(canViewEvent(context({}), workflowEvent)).toBe(false)
  })

  test("infra-topic events stay visible to any scoped principal (no grant governs them yet)", () => {
    expect(canViewEvent(context({}), scheduleEvent)).toBe(true)
  })

  test("a privileged caller (no context) sees every event", () => {
    expect(canViewEvent(null, linkEvent)).toBe(true)
    expect(canViewEvent(null, scheduleEvent)).toBe(true)
  })
})
