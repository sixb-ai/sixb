import { expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { SYNC_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { startTestSyncRun } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { GoogleApiError } from "../../../connectors/google/src/errors"
import { registerSyncRoutes } from "../src/routes/syncs"

// With the base error codec restored, the served failure exposes the API key and lacks
// httpStatus. SQLite's round trip of a failure is storage/sqlite's sync-run storage test.
test("stores and serves recognized causes without credentials", async () => {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "diagnostics",
    ontology: [],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
  })
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
})
