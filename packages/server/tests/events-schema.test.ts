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

describe("EventSchema", () => {
  test("accepts exact materialized ontology events", () => {
    expect(EventSchema.safeParse(materializedObject).success).toBe(true)
  })

  test("requires commit identity for ontology events", () => {
    const { commitId: _, ...withoutCommit } = materializedObject

    expect(EventSchema.safeParse(withoutCommit).success).toBe(false)
  })

  test("validates authoritative property changes", () => {
    const invalid = {
      ...materializedObject,
      payload: {
        ...materializedObject.payload,
        propertyChanges: {
          name: { operation: "cleared", before: "old", after: "not-null" },
        },
      },
    }

    expect(EventSchema.safeParse(invalid).success).toBe(false)
  })

  test("keeps authorable events outside the materialization contract", () => {
    const event = {
      ...storedEventBase,
      type: "action.completed",
      topic: "actions",
      payload: {
        actionId: "approve-device",
        runId: "run-1",
        subject: { objectTypeId: "device", primaryId: "device-1" },
        finishedAt: "2026-07-26T10:00:00.000Z",
      },
    } as const

    expect(EventSchema.safeParse(event).success).toBe(true)
  })
})
