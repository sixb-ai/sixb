import { describe, expect, test } from "bun:test"
import {
  type ActionRunStorage,
  InMemoryStorage,
  type Storage,
  StorageTransactionError,
  type StoredLinkMutationEvent,
  type StoredObjectMutationEvent,
} from "../src"

describe("InMemoryStorage.transaction", () => {
  test("commits writes atomically", async () => {
    const storage = new InMemoryStorage()

    await storage.transaction(async (tx) => {
      await tx.objects.applyObjectUpsert(objectEvent("event_1", "room_1", { name: "Blue" }))
    })

    const row = await storage.objects.getByPrimaryId({
      projectId: "my-app",
      objectTypeId: "Room",
      primaryId: "room_1",
    })

    expect(row?.properties).toEqual({ name: "Blue" })
  })

  test("rolls back writes across every mutated store when the transaction fails", async () => {
    const storage = new InMemoryStorage()

    // Baseline state: one object exists before the transaction.
    await storage.objects.applyObjectUpsert(objectEvent("event_1", "room_1", { name: "Blue" }))

    await expect(
      storage.transaction(async (tx) => {
        // 1. Update an existing object.
        await tx.objects.applyObjectUpsert(objectEvent("event_2", "room_1", { name: "Red" }))
        // 2. Create a brand-new object.
        await tx.objects.applyObjectUpsert(objectEvent("event_3", "room_2", { name: "Green" }))
        // 3. Create a link.
        await tx.objects.applyLinkUpsert(linkEvent("link_1", "room_1", "room_2"))
        // 4. Write to a different store entirely.
        await requireActionRuns(tx).queue({
          id: "run_rollback",
          projectId: "my-app",
          actionId: "paint",
          subject: { kind: "object", objectTypeId: "Room", primaryId: "room_1" },
          params: {},
          idempotencyKey: "action:my-app:run_rollback",
        })

        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    // The updated object reverts to its pre-transaction value.
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
      )?.properties
    ).toEqual({ name: "Blue" })
    // The created object is gone.
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_2",
      })
    ).toBeNull()
    // The created link is gone.
    expect(
      await storage.objects.listLinks({
        projectId: "my-app",
        objectTypeId: "Room",
        objectId: "room_1",
        linkId: "neighbour",
      })
    ).toHaveLength(0)
    // The action-run write is gone.
    expect(await storage.actionRuns.getById({ projectId: "my-app", id: "run_rollback" })).toBeNull()
  })

  test("commits writes across every mutated store atomically", async () => {
    const storage = new InMemoryStorage()
    await storage.objects.applyObjectUpsert(objectEvent("event_1", "room_1", { name: "Blue" }))

    await storage.transaction(async (tx) => {
      await tx.objects.applyObjectUpsert(objectEvent("event_2", "room_1", { name: "Red" }))
      await tx.objects.applyObjectUpsert(objectEvent("event_3", "room_2", { name: "Green" }))
      await tx.objects.applyLinkUpsert(linkEvent("link_1", "room_1", "room_2"))
      await requireActionRuns(tx).queue({
        id: "run_commit",
        projectId: "my-app",
        actionId: "paint",
        subject: { kind: "object", objectTypeId: "Room", primaryId: "room_1" },
        params: {},
        idempotencyKey: "action:my-app:run_commit",
      })
    })

    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
      )?.properties
    ).toEqual({ name: "Red" })
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_2",
      })
    ).not.toBeNull()
    expect(
      await storage.objects.listLinks({
        projectId: "my-app",
        objectTypeId: "Room",
        objectId: "room_1",
        linkId: "neighbour",
      })
    ).toHaveLength(1)
    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "run_commit" })
    ).not.toBeUndefined()
  })

  test("rejects nested transactions", async () => {
    const storage = new InMemoryStorage()

    await expect(storage.transaction((tx) => tx.transaction(() => undefined))).rejects.toThrow(
      StorageTransactionError
    )
  })

  test("rejects transaction storage usage after completion", async () => {
    const storage = new InMemoryStorage()
    let captured: Storage | undefined

    await storage.transaction((tx) => {
      captured = tx
    })

    const transactionStorage = captured
    if (!transactionStorage) {
      throw new Error("Expected transaction storage to be captured.")
    }

    expect(() => transactionStorage.objects.queryCapabilities()).toThrow(StorageTransactionError)
  })
})

function objectEvent(
  id: string,
  primaryId: string,
  properties: Record<string, unknown>
): StoredObjectMutationEvent {
  return {
    id,
    cursor: id,
    schemaVersion: 1,
    projectId: "my-app",
    type: "object.created",
    topic: "objects",
    partitionKey: `Room:${primaryId}`,
    payload: {
      objectTypeId: "Room",
      primaryId,
      properties,
      propertyChanges: {},
    },
    occurredAt: "2026-06-17T10:00:00.000Z",
  }
}

function requireActionRuns(tx: Storage): ActionRunStorage {
  if (!tx.actionRuns) {
    throw new Error("[test] expected transaction storage to expose actionRuns")
  }
  return tx.actionRuns
}

function linkEvent(id: string, sourceId: string, targetId: string): StoredLinkMutationEvent {
  return {
    id,
    cursor: id,
    schemaVersion: 1,
    projectId: "my-app",
    type: "link.created",
    topic: "links",
    partitionKey: `Room:${sourceId}:neighbour`,
    payload: {
      sourceTypeId: "Room",
      sourceId,
      linkId: "neighbour",
      targetTypeId: "Room",
      targetId,
      propertyChanges: {},
    },
    occurredAt: "2026-06-17T10:00:00.000Z",
  }
}
