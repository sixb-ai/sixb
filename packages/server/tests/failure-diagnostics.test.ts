import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  migrateStorage,
  SixbHost,
} from "@sixb/core"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { SYNC_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { startTestSyncRun } from "@sixb/core/testing"
import { SqliteStorage } from "@sixb/sqlite"
import { Elysia } from "elysia"
import { GoogleApiError } from "../../../connectors/google/src/errors"
import { registerSyncRoutes } from "../src/routes/syncs"

// With the base error codec restored, the raw database assertion exposes the API
// key and the response lacks httpStatus. This exercises real storage and routing.
test("stores and serves recognized causes without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-safe-failure-"))
  const storage = new SqliteStorage({ path: directory })
  const host = new SixbHost({
    id: "diagnostics",
    ontology: [],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
  })
  try {
    await migrateStorage(storage)
    await startTestSyncRun(storage, {
      projectId: host.id,
      id: "failed-run",
      syncId: "google-meet",
      datasetId: "google.meet.raw",
      mode: "snapshot",
      startedAt: new Date("2026-09-09T12:00:00.000Z"),
    })
    const failure = captureSixbFailure(
      new GoogleApiError(403, { error: { message: "provider-secret" }, token: "body-secret" }),
      {
        allowedCodes: SYNC_RUN_FAILURE_CODES,
        defaultCode: "sync.execution_failed",
        at: new Date("2026-09-09T12:00:01.000Z"),
        details: { runId: "failed-run", apiKey: "stored-secret" },
      }
    )
    await storage.syncRuns.finish({
      projectId: host.id,
      id: "failed-run",
      status: "failed",
      error: failure,
      finishedAt: new Date("2026-09-09T12:00:01.000Z"),
    })

    const db = new Database(join(directory, "storage.sqlite"), { readonly: true })
    try {
      const row = db.query<{ error: string }, []>("SELECT error FROM sync_runs").get()
      expect(row).not.toBeNull()
      expect(row!.error).not.toContain("secret")
      expect(JSON.parse(row!.error)).toEqual(failure)
    } finally {
      db.close()
    }

    const app = new Elysia()
    app.derive(({ request }) => ({
      sixb: bindRequestExecution(host, { request, authorization: { type: "disabled" } }),
    }))
    registerSyncRoutes(app, host)
    const response = await app.handle(new Request("http://localhost/api/sync-runs"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.runs[0].error).toEqual(failure)
    expect(body.runs[0].error.httpStatus).toBe(403)
    expect(JSON.stringify(body)).not.toContain("secret")
  } finally {
    storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})
