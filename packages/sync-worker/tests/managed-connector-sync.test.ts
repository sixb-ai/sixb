import { describe, expect, spyOn, test } from "bun:test"
import { defineSync } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import {
  createFixture,
  rows,
  run,
  seedSuccessfulCheckpoint,
  social,
  socialRows,
  source,
} from "./managed-connector-sync.fixture"

const ada = { type: "user", id: "usr_ada" } as const
const grace = { type: "user", id: "usr_grace" } as const

describe("a sync of an OAuth connector runs once per connection", () => {
  test("a run reads only its own connection", async () => {
    const seen: string[] = []
    const sync = defineSync("sync-social-accounts", { mode: "append" })
      .from(social)
      .read((client, context) => {
        seen.push(context.connection.id)
        return { id: `${context.connection.id}:row`, accountId: client.accountId }
      })
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "default", ada),
      source("connection-b", "account-b", "default", grace),
    ])

    const result = await run(fixture, sync.id, "run-a", { connectionId: "connection-a" })

    expect(result.rowsRead).toBe(1)
    expect(seen).toEqual(["connection-a"])
    expect(await rows(fixture.lakeStorage)).toEqual([
      { id: "connection-a:row", accountId: "account-a" },
    ])
  })

  test("one connection's failure leaves every other connection's rows and checkpoint", async () => {
    const sync = defineSync("sync-social-isolated", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((_client, context) => {
        if (context.connection.id === "connection-b") throw new Error("provider unavailable")
        context.setCheckpoint({ cursor: "a-1" })
        return { id: `${context.connection.id}:row` }
      })
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "default", ada),
      source("connection-b", "account-b", "default", grace),
    ])

    await run(fixture, sync.id, "run-a", { connectionId: "connection-a" })
    const failed = await run(fixture, sync.id, "run-b", { connectionId: "connection-b" }).catch(
      (error) => error
    )

    expect(String(failed)).toContain("provider unavailable")
    expect(await rows(fixture.lakeStorage)).toEqual([{ id: "connection-a:row" }])
    expect(
      await fixture.runtime.syncRunsStorage.getById({ projectId: fixture.runtime.id, id: "run-b" })
    ).toMatchObject({
      status: "failed",
      connectionId: "connection-b",
      error: {
        code: "sync.execution_failed",
        details: { connectionId: "connection-b", accountId: "account-b" },
      },
    })
    expect(
      await fixture.runtime.syncRunsStorage.getById({ projectId: fixture.runtime.id, id: "run-a" })
    ).toMatchObject({
      status: "succeeded",
      checkpoint: { value: { checkpoint: { cursor: "a-1" } } },
    })
  })

  test("a connection that needs reconnecting fails its run and resumes from its checkpoint", async () => {
    // Removal proof: read the sync's latest checkpoint instead of the connection's; the run after
    // reconnecting starts over.
    let runNumber = 1
    const checkpoints: (string | undefined)[] = []
    const sync = defineSync("sync-social-reconnect", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((_client, context) => {
        checkpoints.push(context.checkpoint?.cursor)
        context.setCheckpoint({ cursor: String(runNumber) })
        return { id: `${context.connection.id}:${runNumber}` }
      })
      .intoDataset(socialRows)
    let needsReconnect = false
    const graceSource: SyncConnectorSource = {
      ...source("connection-b", "account-b", "default", grace),
      async connect() {
        if (needsReconnect) {
          throw createSixbError("connector.authorization_required", "Reconnect Grace's account.")
        }
        return { accountId: "account-b" }
      },
    }
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "default", ada),
      graceSource,
    ])
    await run(fixture, sync.id, "run-b-1", { connectionId: "connection-b" })

    runNumber = 2
    needsReconnect = true
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await run(fixture, sync.id, "run-b-2", { connectionId: "connection-b" }).catch(() => {})
      expect(warn.mock.calls.flat().join(" ")).toContain("needs reconnecting")
    } finally {
      warn.mockRestore()
    }
    expect(
      await fixture.runtime.syncRunsStorage.getById({
        projectId: fixture.runtime.id,
        id: "run-b-2",
      })
    ).toMatchObject({
      status: "failed",
      error: {
        code: "connector.authorization_required",
        details: { connectionId: "connection-b", ownerType: "user" },
      },
    })
    await run(fixture, sync.id, "run-a-2", { connectionId: "connection-a" })

    runNumber = 3
    needsReconnect = false
    await run(fixture, sync.id, "run-b-3", { connectionId: "connection-b" })

    expect(checkpoints).toEqual([undefined, undefined, "1"])
  })

  test("each connection keeps its own checkpoint, and a replaced account starts over", async () => {
    const seen: { connectionId: string; accountId: string; checkpoint: string | undefined }[] = []
    const sync = defineSync("sync-social-checkpoints", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((client, context) => {
        seen.push({
          connectionId: context.connection.id,
          accountId: client.accountId,
          checkpoint: context.checkpoint?.cursor,
        })
        const cursor = `${client.accountId}:${seen.length}`
        context.setCheckpoint({ cursor })
        return { id: cursor }
      })
      .intoDataset(socialRows)
    let accountA = "account-a"
    const fixture = createFixture(sync, () => [
      source("connection-a", accountA, "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ])

    await run(fixture, sync.id, "run-1", { connectionId: "connection-a" })
    await run(fixture, sync.id, "run-2", { connectionId: "connection-b" })
    await run(fixture, sync.id, "run-3", { connectionId: "connection-a" })
    accountA = "account-c"
    await run(fixture, sync.id, "run-4", { connectionId: "connection-a" })

    expect(seen).toEqual([
      { connectionId: "connection-a", accountId: "account-a", checkpoint: undefined },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: undefined },
      { connectionId: "connection-a", accountId: "account-a", checkpoint: "account-a:1" },
      { connectionId: "connection-a", accountId: "account-c", checkpoint: undefined },
    ])
    expect(
      await fixture.runtime.syncRunsStorage.getById({ projectId: fixture.runtime.id, id: "run-3" })
    ).toMatchObject({
      checkpoint: {
        kind: "sync_checkpoint",
        version: 1,
        connectorId: social.id,
        strategy: "connection",
        value: { accountId: "account-a", checkpoint: { cursor: "account-a:3" } },
      },
    })
  })

  test("a connection's first run starts from the run that read every connection", async () => {
    // Removal proof: drop the fallback in readPreviousCheckpoint; Ada's first run starts over.
    const seen: (string | undefined)[] = []
    const sync = defineSync("sync-social-carry-over", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((_client, context) => {
        seen.push(context.checkpoint?.cursor)
        return []
      })
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "default", ada),
      source("connection-n", "account-n", "default", grace),
    ])
    await seedSuccessfulCheckpoint(fixture, sync.id, "run-before", {
      kind: "sync_checkpoint",
      version: 1,
      connectorId: social.id,
      strategy: "connections",
      value: {
        entries: [
          { connectionId: "connection-a", accountId: "account-a", checkpoint: { cursor: "a-9" } },
        ],
      },
    })

    await run(fixture, sync.id, "run-a", { connectionId: "connection-a" })
    await run(fixture, sync.id, "run-n", { connectionId: "connection-n" })

    expect(seen).toEqual(["a-9", undefined])
    expect(
      await fixture.runtime.syncRunsStorage.getById({ projectId: fixture.runtime.id, id: "run-a" })
    ).toMatchObject({
      checkpoint: { strategy: "connection", value: { checkpoint: { cursor: "a-9" } } },
    })
  })

  test.each([
    ["is no longer connected", "connection-gone", "is no longer connected"],
    ["was queued before syncs ran once per connection", undefined, "queued before"],
  ] as const)("a run whose connection %s ends cancelled without reading", async (_case, connectionId, message) => {
    let reads = 0
    const sync = defineSync("sync-social-gone", { mode: "append" })
      .from(social)
      .read(() => {
        reads += 1
        return []
      })
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [source("connection-a", "account-a", "default")])

    const ended = await run(fixture, sync.id, "run-gone", {
      ...(connectionId === undefined ? {} : { connectionId }),
    }).catch((error) => error)

    expect(String(ended)).toContain(message)
    expect(reads).toBe(0)
    expect(
      await fixture.runtime.syncRunsStorage.getById({
        projectId: fixture.runtime.id,
        id: "run-gone",
      })
    ).toMatchObject({ status: "cancelled", error: { code: "runtime.cancelled" } })
  })
})
