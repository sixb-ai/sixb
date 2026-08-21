import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage, type Storage } from "@sixb/core"
import { StorageTransactionError } from "@sixb/core/storage"
import { queueTestActionRun, startTestSyncRun, startTestWebhookRun } from "@sixb/core/testing"
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

test("file-backed snapshot reads remain available during a write transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-concurrent-read-"))
  const storage = new SqliteStorage({ path: directory })
  await migrateStorage(storage)
  let releaseTransaction!: () => void
  const blocked = new Promise<void>((resolve) => {
    releaseTransaction = resolve
  })
  let transactionEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    transactionEntered = resolve
  })
  const transaction = storage.transaction(async (tx) => {
    await queueTestActionRun(tx, actionRunInput("concurrent-read-writer"))
    transactionEntered()
    await blocked
  })

  try {
    await entered
    const read = storage.objects
      .getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room-1",
      })
      .then(() => "read" as const)
    const outcome = await Promise.race([read, Bun.sleep(500).then(() => "blocked" as const)])
    expect(outcome).toBe("read")
  } finally {
    releaseTransaction()
    await transaction
    storage.close()
    await rm(directory, { recursive: true, force: true })
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
      await queueTestActionRun(tx, actionRunInput("run_commit"))
    })

    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "run_commit" })
    ).not.toBeNull()
  })

  test("rejects root storage calls inside a transaction callback", async () => {
    await expect(
      storage.transaction(async () => {
        await storage.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
      })
    ).rejects.toThrow("use the provided tx storage")
  })

  test("rolls back writes across every mutated table when the transaction fails", async () => {
    await expect(
      storage.transaction(async (tx) => {
        requireTransactionalRunStores(tx)
        await queueTestActionRun(tx, actionRunInput("run_rollback"))
        await startTestSyncRun(tx, syncRunInput("sync_rollback"))
        await startTestWebhookRun(tx, webhookRunInput("webhook_rollback"))

        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    expect(await storage.actionRuns.getById({ projectId: "my-app", id: "run_rollback" })).toBeNull()
    expect(await storage.syncRuns.getById({ projectId: "my-app", id: "sync_rollback" })).toBeNull()
    expect(
      await storage.webhookRuns.getById({ projectId: "my-app", id: "webhook_rollback" })
    ).toBeNull()
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
      await queueTestActionRun(tx, {
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
    const rootWrite = queueTestActionRun(storage, {
      id: "root-write",
      projectId: "my-app",
      actionId: "paint",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "root-write",
    }).then((run) => {
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
        return queueTestActionRun(storage, {
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

function actionRunInput(id: string) {
  return {
    projectId: "my-app",
    id,
    actionId: "paint",
    subject: { kind: "none" as const },
    params: {},
    idempotencyKey: `action:my-app:${id}`,
  }
}

function requireTransactionalRunStores(tx: Storage): void {
  if (!tx.actionRuns || !tx.syncRuns || !tx.webhookRuns) {
    throw new Error("[test] expected transaction storage to expose all run stores")
  }
}

function syncRunInput(id: string) {
  return {
    id,
    projectId: "my-app",
    syncId: `sync_${id}`,
    datasetId: "orders",
    mode: "append" as const,
    startedAt: new Date("2026-06-17T10:00:00.000Z"),
  }
}

function webhookRunInput(id: string) {
  return {
    id,
    projectId: "my-app",
    connectorId: "stripe",
    webhookId: "payments",
    method: "POST",
    route: "/webhooks/stripe/payments",
    requestBodyBytes: 2,
    requestBodySha256: "0".repeat(64),
    startedAt: new Date("2026-06-17T10:00:00.000Z"),
  }
}
