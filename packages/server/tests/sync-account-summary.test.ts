import { describe, expect, test } from "bun:test"
import type { SyncAccount } from "@sixb/core"
import type { SyncRunRecord, SyncRunStatus } from "@sixb/core/storage"
import { summarizeSyncAccounts } from "../src/routes/syncs"

const run = (
  syncId: string,
  status: SyncRunStatus,
  finishedAt?: string,
  code: "connector.authorization_required" | "sync.execution_failed" = "sync.execution_failed"
): SyncRunRecord => ({
  id: `run-${syncId}-${status}-${finishedAt ?? "open"}`,
  projectId: "project",
  executionId: "execution",
  syncId,
  connectionId: "connection",
  datasetId: syncId,
  mode: "merge",
  status,
  attempt: 1,
  queuedAt: new Date("2026-10-07T08:00:00.000Z"),
  ...(finishedAt === undefined ? {} : { finishedAt: new Date(finishedAt) }),
  ...(status === "failed"
    ? { error: { code, message: "Failed.", retryable: false, at: "2026-10-07T08:00:00.000Z" } }
    : {}),
})

const account = (id: string, latestRuns: readonly SyncRunRecord[]): SyncAccount => ({
  connection: {
    id,
    connectorId: "outlook",
    owner: { type: "user", id: `usr_${id}` },
    slot: "default",
    account: { id, label: `${id}@example.com` },
  },
  latestRuns,
})

describe("a sync's account summary", () => {
  // Removal proof: count `failed` runs as failing whatever their code, or let a calendar run count
  // for inbox; the counts below change.
  test("counts each account once, by its latest run of this sync", () => {
    const accounts = [
      account("ada", [
        run("inbox", "succeeded", "2026-10-07T09:00:00.000Z"),
        run("calendar", "failed", "2026-10-07T09:30:00.000Z"),
      ]),
      account("grace", [run("inbox", "succeeded", "2026-10-07T10:00:00.000Z")]),
      account("linus", [
        run("inbox", "failed", "2026-10-07T11:00:00.000Z", "connector.authorization_required"),
      ]),
      account("margaret", [run("inbox", "failed", "2026-10-07T11:30:00.000Z")]),
      account("ken", [run("inbox", "running")]),
      account("barbara", [run("inbox", "cancelled", "2026-10-07T12:00:00.000Z")]),
      account("dennis", []),
    ]

    expect(summarizeSyncAccounts("inbox", accounts)).toEqual({
      total: 7,
      running: 1,
      needsReconnecting: 1,
      failing: 1,
      synced: 2,
      lastSyncedAt: "2026-10-07T10:00:00.000Z",
    })
  })

  test("has no last sync before an account succeeds", () => {
    expect(summarizeSyncAccounts("inbox", [account("ada", [run("inbox", "queued")])])).toEqual({
      total: 1,
      running: 1,
      needsReconnecting: 0,
      failing: 0,
      synced: 0,
    })
  })
})
