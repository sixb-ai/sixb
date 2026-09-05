import { describe, expect, test } from "bun:test"
import { defineObjectType, InMemoryStorage, OntologyRegistry, prop, type Storage } from "../src"
import { StorageTransactionError } from "../src/storage"
import {
  createMaterializerTestFixture,
  queueTestActionRun,
  startTestSyncRun,
  startTestWebhookRun,
} from "../src/testing"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})
const ontology = new OntologyRegistry({ sources: [Room] })

describe("InMemoryStorage.transaction", () => {
  test("commits writes atomically", async () => {
    const storage = new InMemoryStorage()

    await storage.transaction(async (tx) => {
      await queueTestActionRun(tx, actionRunInput("run_commit"))
    })

    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "run_commit" })
    ).not.toBeNull()
  })

  test("rejects root storage calls inside a transaction callback", async () => {
    const storage = new InMemoryStorage()
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

  test("honors facade method replacements without recursively acquiring the root lock", async () => {
    const storage = new InMemoryStorage()
    await materializerFixture(storage).seed({
      objects: [
        {
          ref: { objectTypeId: "Room", primaryId: "room_1" },
          properties: { id: "room_1", name: "Blue" },
        },
      ],
    })

    const originalGetByPrimaryId = storage.objects.getByPrimaryId.bind(storage.objects)
    let objectCalls = 0
    storage.objects.getByPrimaryId = async (input) => {
      objectCalls += 1
      return originalGetByPrimaryId(input)
    }

    await expect(
      storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_1",
      })
    ).resolves.toMatchObject({ primaryId: "room_1" })
    expect(objectCalls).toBe(1)

    const getSessionById = storage.auth.sessions.getById.bind(storage.auth.sessions)
    let sessionCalls = 0
    storage.auth.sessions.getById = async (input) => {
      sessionCalls += 1
      return getSessionById(input)
    }
    await expect(
      storage.auth.sessions.getById({ projectId: "my-app", id: "missing" })
    ).resolves.toBeNull()
    expect(sessionCalls).toBe(1)
  })

  test("rolls back writes across every mutated store when the transaction fails", async () => {
    const storage = new InMemoryStorage()

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

  test("commits writes across every mutated store atomically", async () => {
    const storage = new InMemoryStorage()

    await storage.transaction(async (tx) => {
      requireTransactionalRunStores(tx)
      await queueTestActionRun(tx, actionRunInput("run_commit"))
      await startTestSyncRun(tx, syncRunInput("sync_commit"))
      await startTestWebhookRun(tx, webhookRunInput("webhook_commit"))
    })

    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "run_commit" })
    ).not.toBeNull()
    expect(
      await storage.syncRuns.getById({ projectId: "my-app", id: "sync_commit" })
    ).not.toBeNull()
    expect(
      await storage.webhookRuns.getById({ projectId: "my-app", id: "webhook_commit" })
    ).not.toBeNull()
  })

  test("serializes effective reads and materialization around rollback", async () => {
    const storage = new InMemoryStorage()
    const fixture = materializerFixture(storage)
    await fixture.seed({
      objects: [
        {
          ref: { objectTypeId: "Room", primaryId: "room_1" },
          properties: { id: "room_1", name: "Blue" },
        },
      ],
      telemetry: [
        {
          series: {
            object: { objectTypeId: "Room", primaryId: "room_1" },
            propertyId: "temperature",
          },
          value: 18,
          at: "2026-06-17T10:00:00.000Z",
        },
      ],
    })

    const transactionStarted = deferred()
    const releaseTransaction = deferred()
    const transactionResult = storage
      .transaction(async (tx) => {
        await queueTestActionRun(tx, actionRunInput("run_uncommitted"))
        transactionStarted.resolve()
        await releaseTransaction.promise
        throw new Error("rollback")
      })
      .then(
        () => null,
        (error: unknown) => error
      )

    await transactionStarted.promise

    let objectReadSettled = false
    const objectRead = storage.objects
      .getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_1",
      })
      .then((row) => {
        objectReadSettled = true
        return row
      })

    let timeseriesReadSettled = false
    const timeseriesRead = storage.timeseries
      .getHistory({
        projectId: "my-app",
        objectTypeId: "Room",
        objectId: "room_1",
        propertyId: "temperature",
      })
      .then((points) => {
        timeseriesReadSettled = true
        return points
      })

    let objectWriteSettled = false
    const objectWrite = fixture
      .seed({
        objects: [
          {
            ref: { objectTypeId: "Room", primaryId: "room_2" },
            properties: { id: "room_2", name: "Green" },
          },
        ],
      })
      .then(() => {
        objectWriteSettled = true
      })

    let timeseriesWriteSettled = false
    const timeseriesWrite = fixture
      .appendTelemetry([
        {
          series: {
            object: { objectTypeId: "Room", primaryId: "room_1" },
            propertyId: "temperature",
          },
          value: 20,
          at: "2026-06-17T10:02:00.000Z",
        },
      ])
      .then(() => {
        timeseriesWriteSettled = true
      })

    await flushMicrotasks()
    expect(objectReadSettled).toBe(false)
    expect(timeseriesReadSettled).toBe(false)
    expect(objectWriteSettled).toBe(false)
    expect(timeseriesWriteSettled).toBe(false)

    releaseTransaction.resolve()
    expect(await transactionResult).toBeInstanceOf(Error)

    expect((await objectRead)?.properties).toEqual({ id: "room_1", name: "Blue", temperature: 18 })
    expect((await timeseriesRead).map((point) => point.value)).toEqual([18])

    await objectWrite
    await timeseriesWrite
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "my-app",
          objectTypeId: "Room",
          primaryId: "room_1",
        })
      )?.properties
    ).toEqual({ id: "room_1", name: "Blue", temperature: 20 })
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_2",
      })
    ).not.toBeNull()
    expect(
      (
        await storage.timeseries.getHistory({
          projectId: "my-app",
          objectTypeId: "Room",
          objectId: "room_1",
          propertyId: "temperature",
        })
      ).map((point) => point.value)
    ).toEqual([18, 20])
  })

  test("serializes nested and run-store operations around rollback", async () => {
    const storage = new InMemoryStorage()
    const transactionStarted = deferred()
    const releaseTransaction = deferred()
    const transactionResult = storage
      .transaction(async (tx) => {
        if (!tx.agents || !tx.syncRuns || !tx.webhookRuns) {
          throw new Error("[test] expected transaction storage to expose all run stores")
        }

        await tx.agents.threads.create(agentThreadInput("thread_uncommitted"))
        await startTestSyncRun(tx, syncRunInput("sync_uncommitted"))
        await startTestWebhookRun(tx, webhookRunInput("webhook_uncommitted"))
        transactionStarted.resolve()
        await releaseTransaction.promise
        throw new Error("rollback")
      })
      .then(
        () => null,
        (error: unknown) => error
      )

    await transactionStarted.promise

    const settled = {
      agentRead: false,
      agentWrite: false,
      syncRead: false,
      syncWrite: false,
      webhookRead: false,
      webhookWrite: false,
    }
    const agentRead = storage.agents.threads
      .getById({ projectId: "my-app", id: "thread_uncommitted" })
      .then((record) => {
        settled.agentRead = true
        return record
      })
    const syncRead = storage.syncRuns
      .getById({ projectId: "my-app", id: "sync_uncommitted" })
      .then((record) => {
        settled.syncRead = true
        return record
      })
    const webhookRead = storage.webhookRuns
      .getById({ projectId: "my-app", id: "webhook_uncommitted" })
      .then((record) => {
        settled.webhookRead = true
        return record
      })
    const agentWrite = storage.agents.threads
      .create(agentThreadInput("thread_external"))
      .then((record) => {
        settled.agentWrite = true
        return record
      })
    const syncWrite = startTestSyncRun(storage, syncRunInput("sync_external")).then((record) => {
      settled.syncWrite = true
      return record
    })
    const webhookWrite = startTestWebhookRun(storage, webhookRunInput("webhook_external")).then(
      (record) => {
        settled.webhookWrite = true
        return record
      }
    )

    await flushMicrotasks()
    expect(settled).toEqual({
      agentRead: false,
      agentWrite: false,
      syncRead: false,
      syncWrite: false,
      webhookRead: false,
      webhookWrite: false,
    })

    releaseTransaction.resolve()
    expect(await transactionResult).toBeInstanceOf(Error)

    // Reads queued during the transaction observe the restored state, never dirty data.
    expect(await agentRead).toBeNull()
    expect(await syncRead).toBeNull()
    expect(await webhookRead).toBeNull()

    // Writes queued during rollback execute afterward, so restore cannot erase them.
    await Promise.all([agentWrite, syncWrite, webhookWrite])
    expect(
      await storage.agents.threads.getById({ projectId: "my-app", id: "thread_external" })
    ).not.toBeNull()
    expect(
      await storage.syncRuns.getById({ projectId: "my-app", id: "sync_external" })
    ).not.toBeNull()
    expect(
      await storage.webhookRuns.getById({ projectId: "my-app", id: "webhook_external" })
    ).not.toBeNull()
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

function requireTransactionalRunStores(tx: Storage): void {
  if (!tx.actionRuns || !tx.syncRuns || !tx.webhookRuns) {
    throw new Error("[test] expected transaction storage to expose all run stores")
  }
}

function actionRunInput(id: string) {
  return {
    projectId: "my-app",
    id,
    actionId: "paint",
    subject: { kind: "object" as const, objectTypeId: "Room", primaryId: "room_1" },
    params: {},
    idempotencyKey: `action:my-app:${id}`,
  }
}

function materializerFixture(storage: Storage) {
  return createMaterializerTestFixture({ projectId: "my-app", ontology, storage })
}

function agentThreadInput(id: string) {
  return {
    id,
    projectId: "my-app",
    actorId: "support",
    ownerPrincipal: { type: "user" as const, id: "user_1" },
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
