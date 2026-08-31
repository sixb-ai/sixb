import { describe, expect, test } from "bun:test"
import { change, col, defineConnector, defineDataset, defineSync, type JsonValue } from "@sixb/core"
import { blobIdFromDigest } from "@sixb/core/blob-storage"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import type { SyncRunRecord } from "@sixb/core/storage"
import {
  createFixture,
  run,
  seedSuccessfulCheckpoint,
  social,
  socialRows,
  source,
  waitFor,
} from "./managed-connector-sync.fixture"

const socialFiles = defineDataset("raw.social.files", {
  schema: [col("id", "string"), col("attachment", "fileRef", { nullable: true })],
})

const socialMerge = defineDataset("raw.social.merge", {
  schema: [col("id", "string")],
  primaryKey: "id",
})

const missingBlobDigest = `sha256:${"0".repeat(64)}` as const

const staticSocial = defineConnector("social", {
  type: "static-social",
  connect() {
    return {}
  },
})

describe("managed connector Sync safety", () => {
  test("fails closed when the durable checkpoint belongs to another source contract", async () => {
    const sync = defineSync("sync-checkpoint-identity", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read(() => [])
      .intoDataset(socialRows)
    const cases: readonly {
      readonly name: string
      readonly reason: string
      readonly checkpoint: JsonValue
    }[] = [
      {
        name: "legacy checkpoint",
        reason: "checkpoint_format",
        checkpoint: { cursor: "100" },
      },
      {
        name: "unsupported envelope version",
        reason: "checkpoint_version",
        checkpoint: {
          kind: "sync_checkpoint",
          version: 2,
          connectorId: social.id,
          strategy: "connections",
          value: { entries: [] },
        },
      },
      {
        name: "different connector",
        reason: "checkpoint_connector",
        checkpoint: {
          kind: "sync_checkpoint",
          version: 1,
          connectorId: "another-connector",
          strategy: "connections",
          value: { entries: [] },
        },
      },
      {
        name: "different strategy",
        reason: "checkpoint_strategy",
        checkpoint: {
          kind: "sync_checkpoint",
          version: 1,
          connectorId: social.id,
          strategy: "single",
          value: { cursor: "100" },
        },
      },
    ]

    for (const [index, candidate] of cases.entries()) {
      const fixture = createFixture(sync, () => [source("connection-a", "account-a", "brand-a")])
      await seedSuccessfulCheckpoint(
        fixture,
        sync.id,
        `run-checkpoint-seed-${index}`,
        candidate.checkpoint
      )
      const runId = `run-checkpoint-incompatible-${index}`

      await expect(run(fixture, sync.id, runId)).rejects.toThrow("checkpoint incompatible")
      const failed = await fixture.runtime.syncRunsStorage.getById({
        projectId: fixture.runtime.id,
        id: runId,
      })
      expect(failed).toMatchObject({
        status: "failed",
        error: {
          code: "sync.execution_failed",
          details: {
            syncId: sync.id,
            connectorId: social.id,
            reason: candidate.reason,
          },
        },
      })
    }
  })

  test("also rejects a connection checkpoint after the source becomes static", async () => {
    const sync = defineSync("sync-static-checkpoint-identity", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(staticSocial)
      .read(() => [])
      .intoDataset(socialRows)
    const staticSource: SyncConnectorSource = {
      async connect() {
        return {}
      },
    }
    const fixture = createFixture(sync, () => [staticSource])
    await seedSuccessfulCheckpoint(fixture, sync.id, "run-static-seed", {
      kind: "sync_checkpoint",
      version: 1,
      connectorId: staticSocial.id,
      strategy: "connections",
      value: { entries: [] },
    })

    await expect(run(fixture, sync.id, "run-static-incompatible")).rejects.toThrow(
      "checkpoint incompatible"
    )
    const failed = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-static-incompatible",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "sync.execution_failed",
        details: {
          connectorId: staticSocial.id,
          reason: "checkpoint_strategy",
        },
      },
    })
  })

  test("keeps connection provenance on dataset validation failures", async () => {
    const sync = defineSync("sync-validation-provenance")
      .from(social)
      .read((_client, { connection }) => ({
        id: connection.id === "connection-b" ? 42 : connection.id,
      }))
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ])

    await expect(run(fixture, sync.id, "run-invalid-row")).rejects.toThrow("invalid row")
    const failed = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-invalid-row",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "sync.execution_failed",
        details: {
          connectionId: "connection-b",
          accountId: "account-b",
          itemIndex: 2,
        },
      },
    })
  })

  test("keeps connection provenance on missing blob failures", async () => {
    const sync = defineSync("sync-file-provenance")
      .from(social)
      .read((_client, { connection }) => ({
        id: connection.id,
        ...(connection.id === "connection-b"
          ? {
              attachment: {
                blobId: blobIdFromDigest(missingBlobDigest),
                digest: missingBlobDigest,
                sizeBytes: 1,
              },
            }
          : {}),
      }))
      .intoDataset(socialFiles)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ])

    await expect(run(fixture, sync.id, "run-missing-blob")).rejects.toThrow(
      "referencing unknown blob"
    )
    const failed = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-missing-blob",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "sync.execution_failed",
        details: {
          connectionId: "connection-b",
          accountId: "account-b",
          itemIndex: 2,
        },
      },
    })
  })

  test("keeps connection provenance on merge validation failures", async () => {
    const sync = defineSync("sync-merge-provenance", { mode: "merge" })
      .from(social)
      .read((_client, { connection }) =>
        change.upsert({ id: connection.id === "connection-b" ? 42 : connection.id })
      )
      .intoDataset(socialMerge)
    const fixture = createFixture(sync, () => [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ])

    await expect(run(fixture, sync.id, "run-invalid-merge")).rejects.toThrow("invalid merge change")
    const failed = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-invalid-merge",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "sync.execution_failed",
        details: {
          connectionId: "connection-b",
          accountId: "account-b",
          itemIndex: 2,
        },
      },
    })
  })

  test("cancels while a connector source is still connecting", async () => {
    let sourceSignal: AbortSignal | undefined
    const pendingSource: SyncConnectorSource = {
      ...source("connection-a", "account-a", "brand-a"),
      connect(signal) {
        sourceSignal = signal
        return new Promise(() => {})
      },
    }
    const sync = defineSync("sync-cancel-connect")
      .from(social)
      .read(() => [])
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [pendingSource])
    const controller = new AbortController()
    const running = run(fixture, sync.id, "run-cancel-connect", controller.signal)

    await waitFor(() => sourceSignal !== undefined)
    controller.abort(new DOMException("cancelled while connecting", "AbortError"))
    await expectCancelled(fixture, "run-cancel-connect", running)
    expect(sourceSignal?.aborted).toBe(true)
  })

  test("cancels while awaiting the read handler", async () => {
    let handlerStarted = false
    const sync = defineSync("sync-cancel-handler")
      .from(social)
      .read(() => {
        handlerStarted = true
        return new Promise<never>(() => {})
      })
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [source("connection-a", "account-a", "brand-a")])
    const controller = new AbortController()
    const running = run(fixture, sync.id, "run-cancel-handler", controller.signal)

    await waitFor(() => handlerStarted)
    controller.abort(new DOMException("cancelled while reading", "AbortError"))
    await expectCancelled(fixture, "run-cancel-handler", running)
  })

  test("cancels while awaiting the next async source value", async () => {
    let nextStarted = false
    let iteratorClosed = false
    const sync = defineSync("sync-cancel-iterator")
      .from(social)
      .read(
        (): AsyncIterable<unknown> => ({
          [Symbol.asyncIterator]() {
            return {
              next() {
                nextStarted = true
                return new Promise(() => {})
              },
              return() {
                iteratorClosed = true
                return Promise.resolve({ done: true, value: undefined })
              },
            }
          },
        })
      )
      .intoDataset(socialRows)
    const fixture = createFixture(sync, () => [source("connection-a", "account-a", "brand-a")])
    const controller = new AbortController()
    const running = run(fixture, sync.id, "run-cancel-iterator", controller.signal)

    await waitFor(() => nextStarted)
    controller.abort(new DOMException("cancelled while iterating", "AbortError"))
    await expectCancelled(fixture, "run-cancel-iterator", running)
    await waitFor(() => iteratorClosed)
  })
})

async function expectCancelled(
  fixture: ReturnType<typeof createFixture>,
  runId: string,
  running: Promise<unknown>
): Promise<void> {
  let rejection: unknown
  try {
    await running
  } catch (error) {
    rejection = error
  }
  expect(rejection).toBeInstanceOf(Error)
  expect((rejection as Error).name).toBe("AbortError")

  const record: SyncRunRecord | null = await fixture.runtime.syncRunsStorage.getById({
    projectId: fixture.runtime.id,
    id: runId,
  })
  expect(record).toMatchObject({
    status: "cancelled",
    error: { code: "runtime.cancelled" },
  })
}
