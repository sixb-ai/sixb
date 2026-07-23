import { describe, expect, spyOn, test } from "bun:test"
import { InMemoryStorage, type Storage } from "../src"
import type {
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredTelemetryAppendedEvent,
} from "../src/events"
import { type ActionRunStorage, StorageTransactionError } from "../src/storage"

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

  test("does not recursively lock object and timeseries batch methods", async () => {
    const storage = new InMemoryStorage()

    await storage.objects.applyObjectUpsertBatch([
      objectEvent("event_batch_1", "room_1", { name: "Blue" }),
      objectEvent("event_batch_2", "room_2", { name: "Green" }),
    ])
    await storage.timeseries.applyTelemetryAppendedBatch([
      telemetryEvent("telemetry_batch_1", 18, "2026-06-17T10:00:00.000Z"),
      telemetryEvent("telemetry_batch_2", 19, "2026-06-17T10:01:00.000Z"),
    ])

    expect(
      await storage.objects.getByPrimaryId({
        projectId: "my-app",
        objectTypeId: "Room",
        primaryId: "room_2",
      })
    ).not.toBeNull()
    expect(
      await storage.timeseries.getLatest({
        projectId: "my-app",
        objectTypeId: "Room",
        objectId: "room_1",
        propertyId: "temperature",
      })
    ).toMatchObject({ value: 19 })
  })

  test("honors facade method replacements without recursively acquiring the root lock", async () => {
    const storage = new InMemoryStorage()
    await storage.objects.applyObjectUpsert(
      objectEvent("event_decorated", "room_1", { name: "Blue" })
    )

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

    const sessionSpy = spyOn(storage.auth.sessions, "getById")
    await expect(
      storage.auth.sessions.getById({ projectId: "my-app", id: "missing" })
    ).resolves.toBeNull()
    expect(sessionSpy).toHaveBeenCalledTimes(1)
    sessionSpy.mockRestore()
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

  test("serializes direct object and timeseries operations around rollback", async () => {
    const storage = new InMemoryStorage()
    await storage.objects.applyObjectUpsert(
      objectEvent("event_baseline", "room_1", {
        name: "Blue",
      })
    )
    await storage.timeseries.applyTelemetryAppended(
      telemetryEvent("telemetry_baseline", 18, "2026-06-17T10:00:00.000Z")
    )

    const transactionStarted = deferred()
    const releaseTransaction = deferred()
    const transactionResult = storage
      .transaction(async (tx) => {
        await tx.objects.applyObjectUpsert(
          objectEvent("event_uncommitted", "room_1", { name: "Red" })
        )
        await tx.timeseries.applyTelemetryAppended(
          telemetryEvent("telemetry_uncommitted", 19, "2026-06-17T10:01:00.000Z")
        )
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
    const objectWrite = storage.objects
      .applyObjectUpsert(objectEvent("event_external", "room_2", { name: "Green" }))
      .then((row) => {
        objectWriteSettled = true
        return row
      })

    let timeseriesWriteSettled = false
    const timeseriesWrite = storage.timeseries
      .applyTelemetryAppended(telemetryEvent("telemetry_external", 20, "2026-06-17T10:02:00.000Z"))
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

    expect((await objectRead)?.properties).toEqual({ name: "Blue" })
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
    ).toEqual({ name: "Blue" })
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
        await tx.syncRuns.start(syncRunInput("sync_uncommitted"))
        await tx.webhookRuns.start(webhookRunInput("webhook_uncommitted"))
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
    const syncWrite = storage.syncRuns.start(syncRunInput("sync_external")).then((record) => {
      settled.syncWrite = true
      return record
    })
    const webhookWrite = storage.webhookRuns
      .start(webhookRunInput("webhook_external"))
      .then((record) => {
        settled.webhookWrite = true
        return record
      })

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

function telemetryEvent(id: string, value: number, at: string): StoredTelemetryAppendedEvent {
  return {
    id,
    cursor: id,
    schemaVersion: 1,
    projectId: "my-app",
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: "Room:room_1:temperature",
    payload: {
      objectTypeId: "Room",
      objectId: "room_1",
      propertyId: "temperature",
      value,
      at,
    },
    occurredAt: at,
  }
}

function agentThreadInput(id: string) {
  return {
    id,
    projectId: "my-app",
    agentId: "support",
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
