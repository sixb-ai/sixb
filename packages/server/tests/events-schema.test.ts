import { describe, expect, test } from "bun:test"
import { EventSchema } from "../src/schemas/events"

const storedEventBase = {
  id: "event-1",
  cursor: "cursor-1",
  schemaVersion: 1,
  projectId: "project-1",
  occurredAt: "2026-07-26T10:00:00.000Z",
  partitionKey: "device:device-1",
} as const

const materializedObject = {
  ...storedEventBase,
  type: "object.updated",
  topic: "objects",
  origin: { kind: "runtime", requestId: "request-1" },
  requestedBy: { type: "user", id: "user-1" },
  executor: { type: "request", requestId: "request-1" },
  commitId: "commit-1",
  commitOrdinal: 0,
  payload: {
    objectTypeId: "device",
    primaryId: "device-1",
    properties: {},
    propertyChanges: {
      name: { operation: "cleared", before: "old", after: null },
    },
  },
} as const

const { commitId: _commitId, ...withoutCommit } = materializedObject
const { executor: _executor, ...withoutExecutor } = materializedObject

describe("EventSchema", () => {
  test.each([
    ["accepts an exact materialized ontology event", materializedObject, true],
    ["requires commit identity for ontology events", withoutCommit, false],
    ["requires the executor that made an ontology change", withoutExecutor, false],
    [
      "validates authoritative property changes",
      {
        ...materializedObject,
        payload: {
          ...materializedObject.payload,
          propertyChanges: { name: { operation: "cleared", before: "old", after: "not-null" } },
        },
      },
      false,
    ],
    [
      "keeps authorable events outside the materialization contract",
      {
        ...storedEventBase,
        type: "sync.run.finished",
        topic: "syncs",
        payload: { syncId: "import-devices", runId: "run-1", status: "succeeded" },
      },
      true,
    ],
  ] as const)("%s", (_case, event, success) => {
    expect(EventSchema.safeParse(event).success).toBe(success)
  })
})
