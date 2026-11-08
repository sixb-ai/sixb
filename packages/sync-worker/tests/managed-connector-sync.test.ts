import { describe, expect, spyOn, test } from "bun:test"
import { defineSync } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import {
  createFixture,
  rows,
  run,
  social,
  socialRows,
  source,
} from "./managed-connector-sync.fixture"

describe("managed connector Sync fan-out", () => {
  test("skips an account that needs reconnecting and keeps its checkpoint", async () => {
    // Removal proof: rethrow in readManagedSource's connect catch; the second run fails.
    let runNumber = 1
    const sync = defineSync("sync-social-skip", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((_client, context) => {
        context.setCheckpoint({ cursor: String(runNumber) })
        return { id: `${context.connection.id}:${runNumber}` }
      })
      .intoDataset(socialRows)
    let needsReconnect = false
    const ben: SyncConnectorSource = {
      ...source("connection-b", "account-b", "default"),
      async connect() {
        if (needsReconnect) {
          throw createSixbError("connector.authorization_required", "Reconnect Ben's account.")
        }
        return { accountId: "account-b" }
      },
    }
    const fixture = createFixture(sync, () => [source("connection-a", "account-a", "default"), ben])
    await run(fixture, sync.id, "run-skip-1")

    runNumber = 2
    needsReconnect = true
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect((await run(fixture, sync.id, "run-skip-2")).rowsRead).toBe(1)
      expect(warn.mock.calls.flat().join(" ")).toContain("skipped connection 'connection-b'")
    } finally {
      warn.mockRestore()
    }

    const second = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-skip-2",
    })
    expect(second?.checkpoint).toMatchObject({
      value: {
        entries: [
          { connectionId: "connection-a", checkpoint: { cursor: "2" } },
          { connectionId: "connection-b", checkpoint: { cursor: "1" } },
        ],
      },
    })
    expect((await rows(fixture.lakeStorage)).map(({ id }) => id).sort()).toEqual([
      "connection-a:1",
      "connection-a:2",
      "connection-b:1",
    ])
  })

  test("a snapshot sync still fails when an account needs reconnecting", async () => {
    const sync = defineSync("sync-social-snapshot-skip")
      .from(social)
      .read((client) => ({ id: client.accountId }))
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "default"),
      {
        ...source("connection-b", "account-b", "default"),
        async connect() {
          throw createSixbError("connector.authorization_required", "Reconnect Ben's account.")
        },
      },
    ])
    const failed = await run(fixture, sync.id, "run-snapshot-skip").catch((error) => error)
    expect(String(failed)).toContain("Reconnect Ben's account.")
  })

  test("reads every connection into one snapshot and clears it when none remain", async () => {
    const seen: string[] = []
    const sync = defineSync("sync-social-accounts")
      .from(social)
      .read((client, context) => {
        seen.push(context.connection.id)
        return {
          id: `${context.connection.id}:row`,
          accountId: client.accountId,
        }
      })
      .intoDataset(socialRows)
    let sources = [
      source("connection-b", "account-b", "brand-b"),
      source("connection-a", "account-a", "brand-a"),
    ]
    const fixture = createFixture(sync, () => sources)

    const result = await run(fixture, sync.id, "run-managed")
    expect(result.rowsRead).toBe(2)
    expect(seen).toEqual(["connection-a", "connection-b"])
    expect(await rows(fixture.lakeStorage)).toEqual([
      { id: "connection-a:row", accountId: "account-a" },
      { id: "connection-b:row", accountId: "account-b" },
    ])

    sources = []
    const empty = await run(fixture, sync.id, "run-managed-empty")
    expect(empty.rowsRead).toBe(0)
    expect(await rows(fixture.lakeStorage)).toEqual([])
  })

  test("isolates checkpoints and resets only a replaced account", async () => {
    const seen: {
      connectionId: string
      accountId: string
      checkpoint: string | undefined
    }[] = []
    const nextCursor = new Map<string, string>()
    const sync = defineSync("sync-social-checkpoints", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((client, context) => {
        seen.push({
          connectionId: context.connection.id,
          accountId: client.accountId,
          checkpoint: context.checkpoint?.cursor,
        })
        const cursor = nextCursor.get(context.connection.id)
        if (!cursor) throw new Error("Missing test cursor.")
        context.setCheckpoint({ cursor })
        return { id: `${context.connection.id}:${cursor}` }
      })
      .intoDataset(socialRows)
    let sources: readonly SyncConnectorSource[] = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    const fixture = createFixture(sync, () => sources)

    nextCursor.set("connection-a", "a-1")
    nextCursor.set("connection-b", "b-1")
    await run(fixture, sync.id, "run-checkpoints-1")
    const firstRun = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-checkpoints-1",
    })
    expect(firstRun?.checkpoint).toMatchObject({
      kind: "sync_checkpoint",
      version: 1,
      connectorId: social.id,
      strategy: "connections",
      value: {
        entries: [
          { connectionId: "connection-a", accountId: "account-a", checkpoint: { cursor: "a-1" } },
          { connectionId: "connection-b", accountId: "account-b", checkpoint: { cursor: "b-1" } },
        ],
      },
    })

    sources = [source("connection-a", "account-a", "brand-a")]
    nextCursor.set("connection-a", "a-2")
    await run(fixture, sync.id, "run-checkpoints-2")

    sources = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    nextCursor.set("connection-a", "a-3")
    nextCursor.set("connection-b", "b-2")
    await run(fixture, sync.id, "run-checkpoints-3")

    sources = [
      source("connection-a", "account-c", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    nextCursor.set("connection-a", "c-1")
    nextCursor.set("connection-b", "b-3")
    await run(fixture, sync.id, "run-checkpoints-4")

    expect(seen).toEqual([
      { connectionId: "connection-a", accountId: "account-a", checkpoint: undefined },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: undefined },
      { connectionId: "connection-a", accountId: "account-a", checkpoint: "a-1" },
      { connectionId: "connection-a", accountId: "account-a", checkpoint: "a-2" },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: "b-1" },
      { connectionId: "connection-a", accountId: "account-c", checkpoint: undefined },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: "b-2" },
    ])
  })

  test("preserves the previous dataset and checkpoints when one source fails", async () => {
    let generation = "initial"
    let failConnectionB = false
    const sync = defineSync("sync-social-atomic")
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((client, context) => {
        if (failConnectionB && context.connection.id === "connection-b") {
          throw new Error("provider unavailable")
        }
        context.setCheckpoint({ cursor: `${client.accountId}:${generation}` })
        return {
          id: `${context.connection.id}:${generation}`,
          accountId: client.accountId,
        }
      })
      .intoDataset(socialRows)
    const sources = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    const fixture = createFixture(sync, () => sources)

    await run(fixture, sync.id, "run-atomic-1")
    const initialRows = await rows(fixture.lakeStorage)
    const firstRun = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-atomic-1",
    })

    generation = "next"
    failConnectionB = true
    await expect(run(fixture, sync.id, "run-atomic-2")).rejects.toThrow("provider unavailable")

    expect(await rows(fixture.lakeStorage)).toEqual(initialRows)
    const failedRun = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-atomic-2",
    })
    expect(failedRun).toMatchObject({
      status: "failed",
      checkpoint: undefined,
      error: {
        code: "sync.execution_failed",
        details: {
          connectionId: "connection-b",
          accountId: "account-b",
        },
      },
    })
    expect(firstRun?.checkpoint).toBeDefined()
  })
})
