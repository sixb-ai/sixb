import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Storage } from "@sixb/core"
import type { StoredLinkMutationEvent, StoredObjectMutationEvent } from "@sixb/core/internal/events"
import { type ActionRunStorage, StorageTransactionError } from "@sixb/core/storage"
import { SqliteStorage } from "../src"
import { closeSqliteStoreConnection, openSqliteStoreConnection } from "../src/transactions"

test("SQLite storage connections enforce foreign keys", () => {
  const connection = openSqliteStoreConnection()
  try {
    expect(connection.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
  } finally {
    closeSqliteStoreConnection(connection)
  }
})

describe("SqliteStorage.transaction", () => {
  let storage: SqliteStorage

  beforeEach(() => {
    storage = new SqliteStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("commits writes atomically", async () => {
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

  test("rolls back writes across every mutated table when the transaction fails", async () => {
    await storage.objects.applyObjectUpsert(objectEvent("event_1", "room_1", { name: "Blue" }))

    await expect(
      storage.transaction(async (tx) => {
        // Update an existing object, create a new one, create a link, and write to another store.
        await tx.objects.applyObjectUpsert(objectEvent("event_2", "room_1", { name: "Red" }))
        await tx.objects.applyObjectUpsert(objectEvent("event_3", "room_2", { name: "Green" }))
        await tx.objects.applyLinkUpsert(linkEvent("link_1", "room_1", "room_2"))
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

    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
      )?.properties
    ).toEqual({ name: "Blue" })
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_2",
      })
    ).toBeNull()
    expect(
      await storage.objects.listLinks({
        projectId: "my-app",
        objectTypeId: "Room",
        objectId: "room_1",
        linkId: "neighbour",
      })
    ).toHaveLength(0)
    expect(await storage.actionRuns.getById({ projectId: "my-app", id: "run_rollback" })).toBeNull()
  })

  test("serializes unrelated root operations behind an active transaction", async () => {
    let releaseTransaction!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    let transactionEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      transactionEntered = resolve
    })

    const failed = storage.transaction(async (tx) => {
      await requireActionRuns(tx).queue({
        id: "rolled-back",
        projectId: "my-app",
        actionId: "paint",
        subject: { kind: "none" },
        params: {},
        idempotencyKey: "rolled-back",
      })
      transactionEntered()
      await blocked
      throw new Error("rollback active transaction")
    })
    await entered

    let rootFinished = false
    const rootWrite = storage.actionRuns
      .queue({
        id: "root-write",
        projectId: "my-app",
        actionId: "paint",
        subject: { kind: "none" },
        params: {},
        idempotencyKey: "root-write",
      })
      .then((run) => {
        rootFinished = true
        return run
      })
    await Promise.resolve()
    expect(rootFinished).toBe(false)

    releaseTransaction()
    await expect(failed).rejects.toThrow("rollback active transaction")
    await expect(rootWrite).resolves.toMatchObject({ id: "root-write" })
    expect(await storage.actionRuns.getById({ projectId: "my-app", id: "rolled-back" })).toBeNull()
  })

  test("does not let detached transaction context escape into a later transaction", async () => {
    let releaseDetached!: () => void
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve
    })
    let detachedWrite!: Promise<unknown>
    let detachedResolved = false

    await storage.transaction(() => {
      detachedWrite = Promise.resolve().then(async () => {
        await detachedGate
        return storage.actionRuns.queue({
          id: "detached-write",
          projectId: "my-app",
          actionId: "paint",
          subject: { kind: "none" },
          params: {},
          idempotencyKey: "detached-write",
        })
      })
      detachedWrite.then(
        () => {
          detachedResolved = true
        },
        () => undefined
      )
    })

    let releaseLaterTransaction!: () => void
    const laterGate = new Promise<void>((resolve) => {
      releaseLaterTransaction = resolve
    })
    let laterEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      laterEntered = resolve
    })
    const later = storage.transaction(async () => {
      laterEntered()
      await laterGate
      throw new Error("roll back later transaction")
    })
    await entered

    releaseDetached()
    await Promise.resolve()
    expect(detachedResolved).toBe(false)

    releaseLaterTransaction()
    await expect(later).rejects.toThrow("roll back later transaction")
    await expect(detachedWrite).resolves.toMatchObject({ id: "detached-write" })
    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "detached-write" })
    ).toMatchObject({ id: "detached-write" })
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
