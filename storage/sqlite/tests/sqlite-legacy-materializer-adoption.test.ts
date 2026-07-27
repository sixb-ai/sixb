import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  Sixb,
} from "@sixb/core"
import { createStoredObjectMutationEvent } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("note", "string", { nullable: true }),
  ],
})

describe("SQLite legacy materializer adoption", () => {
  test("preserves a legacy object while applying its first partial update", async () => {
    const storage = new SqliteStorage()
    const sixb = new Sixb({
      id: "sqlite-legacy-adoption",
      ontology: [Room],
      storage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    try {
      const legacy = await storage.objects.applyObjectUpsert(
        createStoredObjectMutationEvent({
          id: "legacy-room",
          cursor: "1",
          projectId: sixb.id,
          occurredAt: "2026-07-27T08:00:00.000Z",
          objectTypeId: Room.id,
          primaryId: "room-1",
          properties: { id: "room-1", name: "Kitchen" },
        })
      )
      expect(legacy.lastCommitId).toBeUndefined()

      const patched = await sixb.upsertObject(Room.id, { id: "room-1", note: "Warm" })

      expect(patched.properties).toEqual({ id: "room-1", name: "Kitchen", note: "Warm" })
      expect(patched.version).toBe(2)
      expect(patched.lastCommitId).toBeString()
    } finally {
      await sixb.closeBroker()
      storage.close()
    }
  })
})
