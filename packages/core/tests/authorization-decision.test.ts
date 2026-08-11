import { describe, expect, test } from "bun:test"
import { type AuthorizationContext, emptyGrantIndex, isAllowed } from "../src"
import {
  assertCanAppendTelemetry,
  assertCanEdit,
  canViewEvent,
  evaluate,
} from "../src/authorization"
import type {
  StoredActionRequestedEvent,
  StoredDatasetVersionCommittedEvent,
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredPipelineRunStartedEvent,
  StoredRuleTriggeredEvent,
  StoredScheduleTriggeredEvent,
  StoredSyncRunStartedEvent,
  StoredTelemetryAppendedEvent,
  StoredWorkflowRunStartedEvent,
} from "../src/events"
import {
  createDisabledRuntimeAuthorization,
  createPrincipalRuntimeAuthorization,
} from "../src/execution/authorization"

function context(grants: {
  applications?: readonly string[]
  view?: readonly string[]
  datasets?: readonly string[]
  edit?: readonly string[]
  append?: readonly string[]
  apply?: readonly string[]
  run?: readonly string[]
  syncs?: readonly string[]
  pipelines?: readonly string[]
  agents?: readonly string[]
  logs?: boolean
}): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: {
      ...emptyGrantIndex(),
      "access:application": new Set(grants.applications ?? []),
      "view:object": new Set(grants.view ?? []),
      "view:dataset": new Set(grants.datasets ?? []),
      "edit:object": new Set(grants.edit ?? []),
      "append:telemetry": new Set(grants.append ?? []),
      "apply:action": new Set(grants.apply ?? []),
      "run:workflow": new Set(grants.run ?? []),
      "run:sync": new Set(grants.syncs ?? []),
      "run:pipeline": new Set(grants.pipelines ?? []),
      "run:agent": new Set(grants.agents ?? []),
      "observe:logs": new Set(grants.logs ? ["logs"] : []),
    },
  }
}

function principalRuntime(grants: Parameters<typeof context>[0]) {
  return {
    runtimeAuthorization: createPrincipalRuntimeAuthorization({
      projectId: "decision-test",
      context: context(grants),
    }),
  }
}

const unrestrictedRuntime = {
  runtimeAuthorization: createDisabledRuntimeAuthorization("decision-test"),
}

describe("evaluate", () => {
  test("requires the explicit project log observation capability", () => {
    expect(evaluate(context({ logs: true }), { kind: "logs.observe" })).toEqual({
      allowed: true,
      requirements: ["observe:logs"],
      missing: [],
    })
    expect(evaluate(context({}), { kind: "logs.observe" })).toEqual({
      allowed: false,
      requirements: ["observe:logs"],
      missing: ["observe:logs"],
    })
  })

  test("application.access checks application grants", () => {
    expect(
      evaluate(context({ applications: ["atlas"] }), {
        kind: "application.access",
        audience: "atlas",
      })
    ).toEqual({ allowed: true, requirements: ["access:application:atlas"], missing: [] })

    expect(evaluate(context({}), { kind: "application.access", audience: "atlas" })).toEqual({
      allowed: false,
      requirements: ["access:application:atlas"],
      missing: ["access:application:atlas"],
    })
  })

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

  test("dataset.view checks dataset grants", () => {
    expect(
      evaluate(context({ datasets: ["raw.orders"] }), {
        kind: "dataset.view",
        datasetId: "raw.orders",
      })
    ).toEqual({ allowed: true, requirements: ["view:dataset:raw.orders"], missing: [] })

    expect(evaluate(context({}), { kind: "dataset.view", datasetId: "raw.orders" })).toEqual({
      allowed: false,
      requirements: ["view:dataset:raw.orders"],
      missing: ["view:dataset:raw.orders"],
    })
  })

  test("object.edit checks edit grants, independently of view", () => {
    expect(
      evaluate(context({ edit: ["quote"] }), { kind: "object.edit", objectTypeId: "quote" })
    ).toEqual({ allowed: true, requirements: ["edit:object:quote"], missing: [] })

    // A viewer holds no edit grant, and an editor's `object.edit` atom does not consult view. The
    // pairing the write leaves require lives in `assertCanEdit`, not in the atom.
    expect(
      evaluate(context({ view: ["quote"] }), { kind: "object.edit", objectTypeId: "quote" })
    ).toEqual({
      allowed: false,
      requirements: ["edit:object:quote"],
      missing: ["edit:object:quote"],
    })
  })

  test("telemetry.append checks append grants and nothing else", () => {
    expect(
      evaluate(context({ append: ["sensor"] }), {
        kind: "telemetry.append",
        objectTypeId: "sensor",
      })
    ).toEqual({ allowed: true, requirements: ["append:telemetry:sensor"], missing: [] })

    // Editing a type does not carry the right to push points at it.
    expect(
      evaluate(context({ view: ["sensor"], edit: ["sensor"] }), {
        kind: "telemetry.append",
        objectTypeId: "sensor",
      })
    ).toEqual({
      allowed: false,
      requirements: ["append:telemetry:sensor"],
      missing: ["append:telemetry:sensor"],
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

  test("sync.run checks sync grants", () => {
    expect(
      evaluate(context({ syncs: ["sync-orders"] }), { kind: "sync.run", syncId: "sync-orders" })
    ).toEqual({ allowed: true, requirements: ["run:sync:sync-orders"], missing: [] })

    expect(evaluate(context({}), { kind: "sync.run", syncId: "sync-orders" })).toEqual({
      allowed: false,
      requirements: ["run:sync:sync-orders"],
      missing: ["run:sync:sync-orders"],
    })
  })

  test("pipeline.run checks pipeline grants", () => {
    expect(
      evaluate(context({ pipelines: ["pipeline-orders"] }), {
        kind: "pipeline.run",
        pipelineId: "pipeline-orders",
      })
    ).toEqual({ allowed: true, requirements: ["run:pipeline:pipeline-orders"], missing: [] })

    expect(evaluate(context({}), { kind: "pipeline.run", pipelineId: "pipeline-orders" })).toEqual({
      allowed: false,
      requirements: ["run:pipeline:pipeline-orders"],
      missing: ["run:pipeline:pipeline-orders"],
    })
  })

  test("agent.run checks agent grants", () => {
    expect(
      evaluate(context({ agents: ["ops"] }), {
        kind: "agent.run",
        agentId: "ops",
      })
    ).toEqual({ allowed: true, requirements: ["run:agent:ops"], missing: [] })

    expect(evaluate(context({}), { kind: "agent.run", agentId: "ops" })).toEqual({
      allowed: false,
      requirements: ["run:agent:ops"],
      missing: ["run:agent:ops"],
    })
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
    expect(() => assertCanEdit({}, "quote")).toThrow("registered execution scope")
    expect(() => assertCanAppendTelemetry({}, "sensor")).toThrow("registered execution scope")
  })
})

const envelope = {
  id: "evt_1",
  schemaVersion: 1 as const,
  projectId: "p1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  cursor: "c1",
  origin: { kind: "runtime" as const, requestId: "request-1" },
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

  test("object-bound action events require BOTH apply and viewing the subject type", () => {
    expect(
      canViewEvent(context({ apply: ["acknowledge-note"], view: ["note"] }), actionEvent)
    ).toBe(true)
    // Apply without view must not leak the bound object's id/type via the event.
    expect(canViewEvent(context({ apply: ["acknowledge-note"] }), actionEvent)).toBe(false)
    expect(canViewEvent(context({ view: ["note"] }), actionEvent)).toBe(false)
  })

  test("workflow events require running the workflow", () => {
    expect(canViewEvent(context({ run: ["review"] }), workflowEvent)).toBe(true)
    expect(canViewEvent(context({}), workflowEvent)).toBe(false)
  })

  test("sync events require running the sync", () => {
    expect(canViewEvent(context({ syncs: ["sync-orders"] }), syncEvent)).toBe(true)
    expect(canViewEvent(context({}), syncEvent)).toBe(false)
  })

  test("pipeline events require running the pipeline", () => {
    expect(canViewEvent(context({ pipelines: ["pipeline-orders"] }), pipelineEvent)).toBe(true)
    expect(canViewEvent(context({}), pipelineEvent)).toBe(false)
  })

  test("dataset events require viewing the dataset", () => {
    expect(canViewEvent(context({ datasets: ["raw.orders"] }), datasetEvent)).toBe(true)
    expect(canViewEvent(context({}), datasetEvent)).toBe(false)
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

  test("rule events require viewing the object the rule fired on", () => {
    expect(canViewEvent(context({ view: ["note"] }), ruleEvent)).toBe(true)
    // No view of the subject type must not leak the hidden object's existence/id.
    expect(canViewEvent(context({}), ruleEvent)).toBe(false)
  })

  test("subject-free infra events stay visible to any scoped principal (no grant governs them)", () => {
    expect(canViewEvent(context({}), scheduleEvent)).toBe(true)
  })

  test("a privileged caller (no context) sees every event", () => {
    expect(canViewEvent(null, linkEvent)).toBe(true)
    expect(canViewEvent(null, scheduleEvent)).toBe(true)
  })
})
