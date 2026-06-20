import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Storage, StorageTransactionError, type StoredObjectUpsertedEvent } from "@sixb/core"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PostgresStorage.transaction", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("commits writes atomically", async () => {
    await storage.transaction(async (tx) => {
      await tx.objects.applyObjectUpserted(objectEvent("event_1", "room_1", { name: "Blue" }))
    })

    const row = await storage.objects.getByPrimaryId({
      projectId: "my-app",
      objectTypeId: "Room",
      primaryId: "room_1",
    })

    expect(row?.properties).toEqual({ name: "Blue" })
  })

  test("rolls back all writes when the transaction fails", async () => {
    await storage.objects.applyObjectUpserted(objectEvent("event_1", "room_1", { name: "Blue" }))

    await expect(
      storage.transaction(async (tx) => {
        await tx.objects.applyObjectUpserted(objectEvent("event_2", "room_1", { name: "Red" }))

        const row = await tx.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
        expect(row?.properties).toEqual({ name: "Red" })

        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    const row = await storage.objects.getByPrimaryId({
      projectId: "my-app",
      objectTypeId: "Room",
      primaryId: "room_1",
    })

    expect(row?.properties).toEqual({ name: "Blue" })
  })

  test("rejects nested transactions", async () => {
    await expect(storage.transaction((tx) => tx.transaction(() => undefined))).rejects.toThrow(
      StorageTransactionError
    )
  })

  test("rejects transaction storage usage after completion", async () => {
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
): StoredObjectUpsertedEvent {
  return {
    id,
    cursor: id,
    schemaVersion: 1,
    projectId: "my-app",
    type: "object.upserted",
    topic: "objects",
    partitionKey: `Room:${primaryId}`,
    payload: {
      objectTypeId: "Room",
      primaryId,
      properties,
    },
    occurredAt: "2026-06-17T10:00:00.000Z",
  }
}
