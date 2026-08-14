import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Storage } from "@sixb/core"
import { StorageTransactionError } from "@sixb/core/storage"
import { queueTestActionRun } from "@sixb/core/testing"
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
        const runs = requireTransactionalRunStores(tx)
        await queueTestActionRun(tx, actionRunInput("run_rollback"))
        await runs.syncRuns.start(syncRunInput("sync_rollback"))
        await runs.webhookRuns.start(webhookRunInput("webhook_rollback"))

        throw new Error("boom")
      })
    ).rejects.toThrow("boom")

    expect(await storage.actionRuns.getById({ projectId: "my-app", id: "run_rollback" })).toBeNull()
    expect(await storage.syncRuns.getById({ projectId: "my-app", id: "sync_rollback" })).toBeNull()
    expect(
      await storage.webhookRuns.getById({ projectId: "my-app", id: "webhook_rollback" })
    ).toBeNull()
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

function requireTransactionalRunStores(tx: Storage) {
  if (!tx.actionRuns || !tx.syncRuns || !tx.webhookRuns) {
    throw new Error("[test] expected transaction storage to expose all run stores")
  }
  return {
    actionRuns: tx.actionRuns,
    syncRuns: tx.syncRuns,
    webhookRuns: tx.webhookRuns,
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
    startedAt: new Date("2026-06-17T10:00:00.000Z"),
  }
}
