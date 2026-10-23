import { describe, expect, test } from "bun:test"
import { type AuthorizationContext, isAllowed } from "../src"
import {
  assertAuthorized,
  assertCanAppendTelemetry,
  assertCanEdit,
  canViewEvent,
  emptyGrantIndex,
  evaluate,
} from "../src/authorization"
import type {
  StoredDatasetVersionCommittedEvent,
  StoredDomainEvent,
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredPipelineRunStartedEvent,
  StoredRuleTriggeredEvent,
  StoredScheduleTriggeredEvent,
  StoredSyncRunStartedEvent,
  StoredTelemetryAppendedEvent,
  StoredWorkflowRunStartedEvent,
} from "../src/events"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"

function context(grants: {
  view?: readonly string[]
  datasets?: readonly string[]
  edit?: readonly string[]
  append?: readonly string[]
  run?: readonly string[]
  syncs?: readonly string[]
  pipelines?: readonly string[]
  agent?: boolean
  logs?: boolean
  activity?: boolean
  agentThreads?: boolean
  users?: boolean
  memory?: boolean
}): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: {
      ...emptyGrantIndex(),
      "view:object": new Set(grants.view ?? []),
      "view:dataset": new Set(grants.datasets ?? []),
      "edit:object": new Set(grants.edit ?? []),
      "append:telemetry": new Set(grants.append ?? []),
      "run:workflow": new Set(grants.run ?? []),
      "run:sync": new Set(grants.syncs ?? []),
      "run:pipeline": new Set(grants.pipelines ?? []),
      "run:agent": grants.agent ?? false,
      "observe:logs": grants.logs ?? false,
      "observe:activity": grants.activity ?? false,
      "observe:agentThreads": grants.agentThreads ?? false,
      "view:users": grants.users ?? false,
      "manage:agentMemory": grants.memory ?? false,
    },
  }
}

function principalRuntime(grants: Parameters<typeof context>[0]) {
  const scope = createTestingScope({
    projectId: "decision-test",
    context: context(grants),
  })
  return {
    projectId: "decision-test",
    runtimeAuthorization: scope.authorization,
  }
}

const unrestrictedScope = createTestingScope({ projectId: "decision-test" })
const unrestrictedRuntime = {
  projectId: "decision-test",
  runtimeAuthorization: unrestrictedScope.authorization,
}
const delegatedScope = createDelegatedRequestScope({
  projectId: "decision-test",
  requestId: "delegated-request",
  correlationId: "delegated-correlation",
  objectRead: {
    selection: {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "quote", primaryId: "quote-1" },
          node: {
            objects: [{ objectTypeId: "quote", propertyIds: ["id"] }],
            links: [],
          },
        },
      ],
    },
    limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
  },
  actionApply: [
    {
      actionId: "approve",
      subject: { objectTypeId: "quote", primaryId: "quote-1" },
    },
  ],
})
const delegatedRuntime = {
  projectId: "decision-test",
  runtimeAuthorization: delegatedScope.authorization,
}

describe("evaluate", () => {
  // Each request kind requires one grant and reports it whether or not it is held. A grant of
  // another kind does not count: a viewer holds no edit, and an editor holds no append. The pairing
  // the write leaves require lives in `assertCanEdit`, not in the atom.
  test.each([
    ["logs.observe", { kind: "logs.observe" }, { logs: true }, {}, "observe:logs"],
    [
      "activity.observe",
      { kind: "activity.observe" },
      { activity: true },
      { logs: true },
      "observe:activity",
    ],
    [
      "agentThreads.observe",
      { kind: "agentThreads.observe" },
      { agentThreads: true },
      { activity: true },
      "observe:agentThreads",
    ],
    [
      "object.view",
      { kind: "object.view", objectTypeId: "quote" },
      { view: ["quote"] },
      {},
      "view:object:quote",
    ],
    [
      "dataset.view",
      { kind: "dataset.view", datasetId: "raw.orders" },
      { datasets: ["raw.orders"] },
      {},
      "view:dataset:raw.orders",
    ],
    [
      "object.edit",
      { kind: "object.edit", objectTypeId: "quote" },
      { edit: ["quote"] },
      { view: ["quote"] },
      "edit:object:quote",
    ],
    [
      "telemetry.append",
      { kind: "telemetry.append", objectTypeId: "sensor" },
      { append: ["sensor"] },
      { view: ["sensor"], edit: ["sensor"] },
      "append:telemetry:sensor",
    ],
    [
      "sync.run",
      { kind: "sync.run", syncId: "sync-orders" },
      { syncs: ["sync-orders"] },
      {},
      "run:sync:sync-orders",
    ],
    [
      "pipeline.run",
      { kind: "pipeline.run", pipelineId: "pipeline-orders" },
      { pipelines: ["pipeline-orders"] },
      {},
      "run:pipeline:pipeline-orders",
    ],
    ["agent.run", { kind: "agent.run" }, { agent: true }, {}, "run:agent"],
    ["users.view", { kind: "users.view" }, { users: true }, { view: ["quote"] }, "view:users"],
    [
      "agentMemory.manage",
      { kind: "agentMemory.manage" },
      { memory: true },
      { agent: true },
      "manage:agentMemory",
    ],
  ] as const)("%s requires its grant and reports the requirement", (_kind, request, held, other, requirement) => {
    expect(evaluate(context(held), request)).toEqual({
      allowed: true,
      requirements: [requirement],
      missing: [],
    })
    expect(evaluate(context(other), request)).toEqual({
      allowed: false,
      requirements: [requirement],
      missing: [requirement],
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
    expect(isAllowed(undefined, { kind: "workflow.run", workflowId: "w" })).toBe(true)
  })
})

describe("write asserts", () => {
  test("generic authorization denies delegated operations instead of treating them as unrestricted", () => {
    for (const operation of [
      () => assertAuthorized(delegatedRuntime, { kind: "object.view", objectTypeId: "quote" }),
      () =>
        assertAuthorized(delegatedRuntime, {
          kind: "object.query",
          touchedObjectTypeIds: ["quote"],
        }),
      () => assertAuthorized(delegatedRuntime, { kind: "action.apply", actionId: "approve" }),
      () => assertCanEdit(delegatedRuntime, "quote"),
      () => assertCanAppendTelemetry(delegatedRuntime, "sensor"),
    ]) {
      expect(operation).toThrow("not covered by delegated authorization")
    }
  })

  test("assertCanEdit demands view as well as edit, and names the missing one", () => {
    const both = principalRuntime({ view: ["quote"], edit: ["quote"] })
    expect(() => assertCanEdit(both, "quote")).not.toThrow()

    // Edit alone: refused, because an upsert answers with the merged row.
    expect(() => assertCanEdit(principalRuntime({ edit: ["quote"] }), "quote")).toThrow(
      /not allowed to view object type 'quote'/
    )

    // View alone: refused with the write message, so the operator knows which grant to add.
    expect(() => assertCanEdit(principalRuntime({ view: ["quote"] }), "quote")).toThrow(
      /not allowed to write object type 'quote'/
    )
  })

  test("assertCanAppendTelemetry needs no view grant", () => {
    expect(() =>
      assertCanAppendTelemetry(principalRuntime({ append: ["sensor"] }), "sensor")
    ).not.toThrow()

    expect(() =>
      assertCanAppendTelemetry(principalRuntime({ view: ["sensor"] }), "sensor")
    ).toThrow(/not allowed to append telemetry for object type 'sensor'/)
  })

  test("both asserts are inert for explicitly unrestricted authority", () => {
    expect(() => assertCanEdit(unrestrictedRuntime, "quote")).not.toThrow()
    expect(() => assertCanAppendTelemetry(unrestrictedRuntime, "sensor")).not.toThrow()
  })

  test("both asserts fail closed without registered execution authority", () => {
    expect(() => assertCanEdit({ projectId: "decision-test" }, "quote")).toThrow(
      "registered execution scope"
    )
    expect(() => assertCanAppendTelemetry({ projectId: "decision-test" }, "sensor")).toThrow(
      "registered execution scope"
    )
  })
})

const envelope = {
  id: "evt_1",
  schemaVersion: 1 as const,
  projectId: "p1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: "correlation-1",
  cursor: "c1",
  origin: { kind: "runtime" as const, requestId: "request-1" },
  executor: { type: "request" as const, requestId: "request-1" },
  commitId: "commit-1",
  commitOrdinal: 0,
}

const objectEvent: StoredObjectMutationEvent = {
  ...envelope,
  type: "object.created",
  topic: "objects",
  partitionKey: "note/n1",
  payload: { objectTypeId: "note", primaryId: "n1", properties: {}, propertyChanges: {} },
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

const linkEvent: StoredLinkMutationEvent = {
  ...envelope,
  type: "link.created",
  topic: "links",
  partitionKey: "note/n1",
  payload: {
    sourceTypeId: "note",
    sourceId: "n1",
    linkId: "author",
    targetTypeId: "user",
    targetId: "u1",
    propertyChanges: {},
  },
}

const workflowEvent: StoredWorkflowRunStartedEvent = {
  ...envelope,
  type: "workflow.run.started",
  topic: "workflows",
  partitionKey: "review/r1",
  payload: { workflowId: "review", runId: "r1", startedAt: envelope.occurredAt },
}

const syncEvent: StoredSyncRunStartedEvent = {
  ...envelope,
  type: "sync.run.started",
  topic: "syncs",
  partitionKey: "sync-orders/run_1",
  payload: { syncId: "sync-orders", runId: "run_1", startedAt: envelope.occurredAt },
}

const pipelineEvent: StoredPipelineRunStartedEvent = {
  ...envelope,
  type: "pipeline.run.started",
  topic: "pipelines",
  partitionKey: "pipeline-orders/run_1",
  payload: { pipelineId: "pipeline-orders", runId: "run_1", startedAt: envelope.occurredAt },
}

const datasetEvent: StoredDatasetVersionCommittedEvent = {
  ...envelope,
  type: "dataset.version.committed",
  topic: "datasets",
  partitionKey: "raw.orders",
  payload: {
    datasetId: "raw.orders",
    versionId: "v1",
    createdAt: envelope.occurredAt,
    producer: { kind: "sync", id: "erp-orders", runId: "run_1" },
  },
}

const ruleEvent: StoredRuleTriggeredEvent = {
  ...envelope,
  type: "rule.triggered",
  topic: "rules",
  partitionKey: "note/n1",
  payload: {
    ruleId: "stale-note",
    subject: { kind: "object", objectTypeId: "note", primaryId: "n1" },
    triggeredAt: envelope.occurredAt,
  },
}

const memberEvent: Extract<StoredDomainEvent, { type: "user.invited" }> = {
  ...envelope,
  type: "user.invited",
  topic: "users",
  partitionKey: "invitation:ava@acme.com",
  payload: {
    invitationId: "inv_1",
    email: "ava@acme.com",
    expiresAt: envelope.occurredAt,
    requestedBy: { type: "user", id: "u2" },
  },
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
  // Visible with the grant that governs the subject, hidden without it: an event must not leak a
  // hidden object's existence or id.
  test.each([
    ["object", objectEvent, { view: ["note"] }],
    ["telemetry", telemetryEvent, { view: ["note"] }],
    ["rule", ruleEvent, { view: ["note"] }],
    ["workflow", workflowEvent, { run: ["review"] }],
    ["sync", syncEvent, { syncs: ["sync-orders"] }],
    ["pipeline", pipelineEvent, { pipelines: ["pipeline-orders"] }],
    ["dataset", datasetEvent, { datasets: ["raw.orders"] }],
    ["member", memberEvent, { users: true }],
  ] as const)("%s events require the grant that governs their subject", (_kind, event, grants) => {
    expect(canViewEvent(context(grants), event)).toBe(true)
    expect(canViewEvent(context({}), event)).toBe(false)
  })

  test("link events require viewing BOTH the source and the target type", () => {
    expect(canViewEvent(context({ view: ["note", "user"] }), linkEvent)).toBe(true)
    // Seeing the source but not the target must not leak the link (or the target id).
    expect(canViewEvent(context({ view: ["note"] }), linkEvent)).toBe(false)
    expect(canViewEvent(context({ view: ["user"] }), linkEvent)).toBe(false)
  })

  test("dataset version provenance is visible to a dataset viewer who cannot run the producer", () => {
    // datasetEvent.payload.producer is sync 'erp-orders'. A principal who can
    // view the dataset but cannot run that sync still sees the event (and its
    // producer): provenance is intentionally exposed to dataset viewers,
    // matching the versions API. It is NOT gated on running the producer.
    const datasetViewerOnly = context({ datasets: ["raw.orders"] })
    expect(canViewEvent(datasetViewerOnly, datasetEvent)).toBe(true)
    expect(isAllowed(datasetViewerOnly, { kind: "sync.run", syncId: "erp-orders" })).toBe(false)
  })

  test("viewing every object type does not reveal members or invitees", () => {
    expect(canViewEvent(context({ view: ["note", "user"] }), memberEvent)).toBe(false)
  })

  test("subject-free infra events stay visible to any scoped principal (no grant governs them)", () => {
    expect(canViewEvent(context({}), scheduleEvent)).toBe(true)
  })

  test("a privileged caller (no context) sees every event", () => {
    expect(canViewEvent(null, linkEvent)).toBe(true)
    expect(canViewEvent(null, scheduleEvent)).toBe(true)
    expect(canViewEvent(null, memberEvent)).toBe(true)
  })
})
