import { describe, expect, test } from "bun:test"
import { eventAttribution, materializationEvent } from "../src/materialization/event-envelopes"
import type {
  OntologyMaterializationEventAttribution,
  OntologyMaterializationEventCommit,
} from "../src/materialization/events"
import type { EffectiveLinkSnapshot, EffectiveObjectSnapshot } from "../src/materialization/model"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
  buildTelemetryMaterializationEventDraft,
} from "../src/materializer/effective/build-events"

const committedAt = "2026-01-02T03:04:05.000Z"
const commit: OntologyMaterializationEventCommit = {
  projectId: "project",
  id: "commit-1",
  committedAt,
  origin: { kind: "runtime", requestId: "request-1" },
}
const attribution: OntologyMaterializationEventAttribution = {
  correlationId: "correlation-1",
  requestedBy: { type: "user", id: "user-1" },
  executor: { type: "request", requestId: "request-1" },
}
const sequence = { id: "event-1", commitOrdinal: 3 }

/** Every event of `commit` carries this, whatever changed. */
const context = {
  id: "event-1",
  schemaVersion: 1,
  projectId: "project",
  occurredAt: committedAt,
  correlationId: "correlation-1",
  origin: { kind: "runtime", requestId: "request-1" },
  requestedBy: { type: "user", id: "user-1" },
  executor: { type: "request", requestId: "request-1" },
  commitId: "commit-1",
  commitOrdinal: 3,
} as const

const device = { objectTypeId: "Device", primaryId: "d-1" }
const owner = { objectTypeId: "User", primaryId: "u-1" }
const objectIdentity = { objectTypeId: "Device", primaryId: "d-1" } as const
const linkIdentity = {
  sourceTypeId: "Device",
  sourceId: "d-1",
  linkId: "owner",
  targetTypeId: "User",
  targetId: "u-1",
} as const

function object(properties: Record<string, unknown>): EffectiveObjectSnapshot {
  return {
    ref: device,
    properties: properties as EffectiveObjectSnapshot["properties"],
    version: 1,
    createdAt: committedAt,
    updatedAt: committedAt,
    lastCommitId: "commit-1",
  }
}

function link(properties?: Record<string, unknown>): EffectiveLinkSnapshot {
  return {
    ref: { source: device, linkId: "owner", target: owner },
    ...(properties === undefined
      ? {}
      : { properties: properties as NonNullable<EffectiveLinkSnapshot["properties"]> }),
    createdAt: committedAt,
    updatedAt: committedAt,
    lastCommitId: "commit-1",
  }
}

// Removal proof: drop the property changes `materializationEvent` derives for a creation, or a
// context field it copies from the commit; the matching case no longer equals the event core
// built in one piece before drafts.
describe("materializationEvent", () => {
  test("rebuilds every event kind exactly as it was built in one piece", () => {
    const cases = [
      {
        draft: buildObjectMaterializationEventDraft({
          kind: "created",
          ref: device,
          before: null,
          after: object({ status: "on", name: "A" }),
          propertyChanges: {
            name: { operation: "created", after: "A" },
            status: { operation: "created", after: "on" },
          },
        }),
        event: {
          type: "object.created",
          topic: "objects",
          partitionKey: "Device:d-1",
          payload: {
            ...objectIdentity,
            properties: { status: "on", name: "A" },
            propertyChanges: {
              name: { operation: "created", after: "A" },
              status: { operation: "created", after: "on" },
            },
          },
        },
      },
      {
        draft: buildObjectMaterializationEventDraft({
          kind: "updated",
          ref: device,
          before: object({ status: "on" }),
          after: object({ status: "off" }),
          propertyChanges: { status: { operation: "updated", before: "on", after: "off" } },
        }),
        event: {
          type: "object.updated",
          topic: "objects",
          partitionKey: "Device:d-1",
          payload: {
            ...objectIdentity,
            properties: { status: "off" },
            propertyChanges: { status: { operation: "updated", before: "on", after: "off" } },
          },
        },
      },
      {
        draft: buildObjectMaterializationEventDraft({
          kind: "deleted",
          ref: device,
          before: object({ status: "off" }),
          after: null,
          propertyChanges: { status: { operation: "cleared", before: "off", after: null } },
        }),
        event: {
          type: "object.deleted",
          topic: "objects",
          partitionKey: "Device:d-1",
          payload: {
            ...objectIdentity,
            propertyChanges: { status: { operation: "cleared", before: "off", after: null } },
          },
        },
      },
      {
        draft: buildLinkMaterializationEventDraft({
          kind: "created",
          ref: link().ref,
          before: null,
          after: link({ role: "admin" }),
          propertyChanges: { role: { operation: "created", after: "admin" } },
        }),
        event: {
          type: "link.created",
          topic: "links",
          partitionKey: "Device:d-1:owner",
          payload: {
            ...linkIdentity,
            properties: { role: "admin" },
            propertyChanges: { role: { operation: "created", after: "admin" } },
          },
        },
      },
      {
        draft: buildLinkMaterializationEventDraft({
          kind: "created",
          ref: link().ref,
          before: null,
          after: link(),
          propertyChanges: {},
        }),
        event: {
          type: "link.created",
          topic: "links",
          partitionKey: "Device:d-1:owner",
          payload: { ...linkIdentity, propertyChanges: {} },
        },
      },
      {
        draft: buildLinkMaterializationEventDraft({
          kind: "updated",
          ref: link().ref,
          before: link({ role: "admin" }),
          after: link({ role: "viewer" }),
          propertyChanges: { role: { operation: "updated", before: "admin", after: "viewer" } },
        }),
        event: {
          type: "link.updated",
          topic: "links",
          partitionKey: "Device:d-1:owner",
          payload: {
            ...linkIdentity,
            properties: { role: "viewer" },
            propertyChanges: { role: { operation: "updated", before: "admin", after: "viewer" } },
          },
        },
      },
      {
        draft: buildLinkMaterializationEventDraft({
          kind: "deleted",
          ref: link().ref,
          before: link(),
          after: null,
          propertyChanges: {},
        }),
        event: {
          type: "link.deleted",
          topic: "links",
          partitionKey: "Device:d-1:owner",
          payload: { ...linkIdentity, propertyChanges: {} },
        },
      },
      {
        draft: buildTelemetryMaterializationEventDraft({
          series: { object: device, propertyId: "temperature" },
          value: 21.5,
          at: committedAt,
          unit: "celsius",
        }),
        event: {
          type: "telemetry.appended",
          topic: "telemetry",
          partitionKey: "Device:d-1:temperature",
          payload: {
            objectTypeId: "Device",
            objectId: "d-1",
            propertyId: "temperature",
            value: 21.5,
            at: committedAt,
            unit: "celsius",
          },
        },
      },
    ] as const

    for (const { draft, event } of cases) {
      expect(materializationEvent(draft.draft, sequence, commit, attribution)).toStrictEqual({
        ...context,
        ...event,
      })
    }
  })

  test("leaves requestedBy out of an event whose execution has none", () => {
    const { requestedBy: _requestedBy, ...anonymous } = attribution
    const { draft } = buildLinkMaterializationEventDraft({
      kind: "deleted",
      ref: link().ref,
      before: link(),
      after: null,
      propertyChanges: {},
    })

    expect(materializationEvent(draft, sequence, commit, anonymous)).not.toHaveProperty(
      "requestedBy"
    )
  })

  test("shares no state with the commit and execution it was rebuilt from", () => {
    const { draft } = buildLinkMaterializationEventDraft({
      kind: "deleted",
      ref: link().ref,
      before: link(),
      after: null,
      propertyChanges: {},
    })
    const first = materializationEvent(draft, sequence, commit, attribution)
    const second = materializationEvent(
      draft,
      { id: "event-2", commitOrdinal: 4 },
      commit,
      attribution
    )

    expect(first.origin).not.toBe(commit.origin)
    expect(first.executor).not.toBe(second.executor)
    expect(first.requestedBy).not.toBe(attribution.requestedBy)
  })
})

describe("eventAttribution", () => {
  const execution = {
    id: "execution-1",
    correlationId: "correlation-1",
    requestedBy: { type: "user", id: "user-1" },
    executor: { type: "primitive", kind: "action", runId: "run-1" },
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "action", id: "approve", runId: "run-1" },
    },
  } as const

  // Removal proof: take the primitive id from anywhere but the execution's authority; the
  // durable record keeps it nowhere else, and the executor below loses its id.
  test("names a primitive by the id its authority records", () => {
    expect(eventAttribution(execution)).toStrictEqual({
      correlationId: "correlation-1",
      requestedBy: { type: "user", id: "user-1" },
      executor: { type: "primitive", kind: "action", id: "approve", runId: "run-1" },
    })
  })

  test("refuses a primitive execution without that primitive's authority", () => {
    expect(() =>
      eventAttribution({
        ...execution,
        authorizationRef: {
          type: "trustedPrimitive",
          primitive: { kind: "action", id: "approve", runId: "another-run" },
        },
      })
    ).toThrow("runs a primitive without that primitive's authority")
  })
})
