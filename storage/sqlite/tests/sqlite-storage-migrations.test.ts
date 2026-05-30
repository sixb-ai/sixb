import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@pario/core"
import { SqliteStorage } from "../src"
import {
  migrateSqliteStorage,
  SQLITE_STORAGE_ADAPTER_ID,
  sqliteStoragePath,
} from "../src/migrations"

const tempDirs: string[] = []
const expectedStorageMigrationRows = [
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "001-initial-schema",
    status: "applied",
    version: 1,
  },
]

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()

    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe("SQLite storage migrations", () => {
  test("migrateStorage writes storage-level migration history", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-sqlite-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    const result = await migrateStorage(storage)

    closeStorage(storage)

    expect(result.status).toBe("migrated")
    expect(readMigrationRows(sqliteStoragePath(tempDir))).toEqual(expectedStorageMigrationRows)
  })

  test("migrations install auth storage tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-sqlite-auth-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    await storage.auth.users.create({
      id: "usr_1",
      projectId: "project-a",
      email: "ava@acme.com",
      createdAt: new Date("2026-05-14T10:00:00.000Z"),
    })
    await expect(
      storage.auth.users.getByEmail({
        projectId: "project-a",
        email: "ava@acme.com",
      })
    ).resolves.toMatchObject({
      id: "usr_1",
      email: "ava@acme.com",
    })

    closeStorage(storage)

    const tables = readTableNames(sqliteStoragePath(tempDir))
    const sessionColumns = readTableColumns(sqliteStoragePath(tempDir), "auth_sessions")
    expect(tables).toContain("auth_users")
    expect(tables).toContain("auth_user_identities")
    expect(tables).toContain("auth_sessions")
    expect(tables).toContain("auth_invitations")
    expect(tables).toContain("auth_invitation_groups")
    expect(tables).toContain("auth_group_memberships")
    expect(tables).toContain("auth_magic_links")
    expect(tables).toContain("auth_oidc_authorization_attempts")
    expect(sessionColumns).toContain("audience")
  })

  test("migrations preserve existing store rows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-sqlite-legacy-"))
    tempDirs.push(tempDir)

    await seedExistingStoreRows(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    const point = await storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
    })
    const syncRun = await storage.syncRuns.getById({
      projectId: "project-a",
      id: "run-1",
    })
    const projectionRun = await storage.projectionRuns.getById({
      projectId: "project-a",
      id: "proj-run-1",
    })
    const workflowRun = await storage.workflowRuns.getById({
      projectId: "project-a",
      id: "workflow-run-1",
    })
    const webhookRun = await storage.webhookRuns.getById({
      projectId: "project-a",
      id: "webhook-run-1",
    })

    closeStorage(storage)

    const webhookDelivery = readWebhookDeliveryRow(sqliteStoragePath(tempDir), {
      projectId: "project-a",
      connectorId: "github",
      webhookId: "events",
      idempotencyKey: "delivery-1",
    })

    expect(row?.properties).toEqual({ name: "Legacy Room", temperature: 21.5 })
    expect(point?.value).toBe(21.5)
    expect(syncRun?.status).toBe("succeeded")
    expect(syncRun?.checkpoint).toEqual({ cursor: "legacy" })
    expect(projectionRun?.status).toBe("succeeded")
    expect(projectionRun?.objectsUpserted).toBe(4)
    expect(workflowRun?.status).toBe("succeeded")
    expect(workflowRun?.input).toEqual({ transactionId: "txn-1" })
    expect(webhookRun).toMatchObject({
      connectorId: "github",
      webhookId: "events",
      status: "succeeded",
      responseStatus: 202,
    })
    expect(webhookDelivery).toMatchObject({
      status: "completed",
      completedAt: "2026-04-19T12:00:02.000Z",
      receivedAt: "2026-04-19T12:00:00.000Z",
    })
    expect(readMigrationRows(sqliteStoragePath(tempDir))).toEqual(expectedStorageMigrationRows)
  })

  test("dirty SQLite migration history blocks storage migrations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-sqlite-dirty-"))
    tempDirs.push(tempDir)

    writeStartedMigration(sqliteStoragePath(tempDir))

    const storage = new SqliteStorage({ path: tempDir })

    await expect(migrateStorage(storage)).rejects.toThrow("dirty migration state")

    closeStorage(storage)
  })
})

function readMigrationRows(path: string): Array<{
  adapter_id: string
  checksum_length: number
  id: string
  status: string
  version: number
}> {
  const db = new Database(path, { readonly: true })

  try {
    return db
      .query(`
        SELECT adapter_id, version, id, status, length(checksum) AS checksum_length
        FROM pario_migrations
        ORDER BY adapter_id, version
      `)
      .all() as Array<{
      adapter_id: string
      checksum_length: number
      id: string
      status: string
      version: number
    }>
  } finally {
    db.close()
  }
}

function readTableNames(path: string): readonly string[] {
  const db = new Database(path, { readonly: true })

  try {
    const rows = db
      .query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `)
      .all() as Array<{ readonly name: string }>

    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

function readTableColumns(path: string, tableName: string): readonly string[] {
  const db = new Database(path, { readonly: true })

  try {
    const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      readonly name: string
    }>

    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

function readWebhookDeliveryRow(
  path: string,
  key: {
    projectId: string
    connectorId: string
    webhookId: string
    idempotencyKey: string
  }
): {
  status: string
  receivedAt: string
  completedAt: string | null
  failedAt: string | null
  error: string | null
} | null {
  const db = new Database(path, { readonly: true })

  try {
    return db
      .query(`
        SELECT
          status,
          received_at AS receivedAt,
          completed_at AS completedAt,
          failed_at AS failedAt,
          error
        FROM webhook_deliveries
        WHERE project_id = ?
          AND connector_id = ?
          AND webhook_id = ?
          AND idempotency_key = ?
      `)
      .get(key.projectId, key.connectorId, key.webhookId, key.idempotencyKey) as {
      status: string
      receivedAt: string
      completedAt: string | null
      failedAt: string | null
      error: string | null
    } | null
  } finally {
    db.close()
  }
}

function writeStartedMigration(path: string): void {
  const db = new Database(path)

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS pario_migrations (
        adapter_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        id TEXT NOT NULL,
        checksum TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (adapter_id, version)
      );
    `)

    db.query(`
      INSERT INTO pario_migrations (
        adapter_id, version, id, checksum, status, started_at, finished_at
      ) VALUES (?, 1, '001-initial-schema', NULL, 'started', ?, NULL)
    `).run(SQLITE_STORAGE_ADAPTER_ID, "2026-04-19T00:00:00.000Z")
  } finally {
    db.close()
  }
}

async function seedExistingStoreRows(basePath: string): Promise<void> {
  await migrateSqliteStorage(basePath)

  const storage = new SqliteStorage({ path: basePath })
  try {
    await storage.objects.applyObjectUpserted({
      id: "legacy-object-event",
      cursor: "1",
      schemaVersion: 1,
      projectId: "project-a",
      type: "object.upserted",
      topic: "objects",
      partitionKey: "Room:room:101",
      payload: {
        objectTypeId: "Room",
        primaryId: "room:101",
        properties: { name: "Legacy Room" },
      },
      occurredAt: "2026-04-06T12:00:00.000Z",
    })

    const telemetryEvent = {
      id: "legacy-telemetry-event",
      cursor: "2",
      schemaVersion: 1 as const,
      projectId: "project-a",
      type: "telemetry.appended" as const,
      topic: "telemetry" as const,
      partitionKey: "Room:room:101:temperature",
      payload: {
        objectTypeId: "Room",
        objectId: "room:101",
        propertyId: "temperature",
        value: 21.5,
        at: "2026-04-19T12:00:00.500Z",
      },
      occurredAt: "2026-04-19T12:00:00.500Z",
    }
    await storage.objects.applyTelemetryAppended(telemetryEvent)
    await storage.timeseries.applyTelemetryAppended(telemetryEvent)

    await storage.syncRuns.start({
      id: "run-1",
      projectId: "project-a",
      syncId: "sync-orders",
      datasetId: "raw.orders",
      mode: "snapshot",
      startedAt: new Date("2026-04-19T12:00:00.000Z"),
    })

    await storage.syncRuns.finish({
      id: "run-1",
      projectId: "project-a",
      status: "succeeded",
      finishedAt: new Date("2026-04-19T12:00:01.000Z"),
      rowsRead: 10,
      output: {
        datasetId: "raw.orders",
        versionId: "ver_1",
      },
      checkpoint: { cursor: "legacy" },
    })

    await storage.projectionRuns.start({
      id: "proj-run-1",
      projectId: "project-a",
      projectionId: "room-proj",
      projectionKind: "object",
      datasetId: "raw.orders",
      datasetVersionId: "ver_1",
      startedAt: new Date("2026-04-19T12:00:00.000Z"),
    })

    await storage.projectionRuns.finish({
      id: "proj-run-1",
      projectId: "project-a",
      status: "succeeded",
      finishedAt: new Date("2026-04-19T12:00:01.000Z"),
      rowsProcessed: 4,
      objectsUpserted: 4,
    })

    await storage.workflowRuns.start({
      id: "workflow-run-1",
      projectId: "project-a",
      workflowId: "reconcile-transaction",
      input: {
        transactionId: "txn-1",
      },
      startedAt: new Date("2026-04-19T12:00:00.000Z"),
    })

    await storage.workflowRuns.finish({
      id: "workflow-run-1",
      projectId: "project-a",
      status: "succeeded",
      finishedAt: new Date("2026-04-19T12:00:01.000Z"),
    })

    await storage.webhookDeliveries.claim({
      projectId: "project-a",
      connectorId: "github",
      webhookId: "events",
      idempotencyKey: "delivery-1",
      receivedAt: "2026-04-19T12:00:00.000Z",
    })

    await storage.webhookDeliveries.complete({
      projectId: "project-a",
      connectorId: "github",
      webhookId: "events",
      idempotencyKey: "delivery-1",
      completedAt: "2026-04-19T12:00:02.000Z",
    })

    await storage.webhookRuns.start({
      id: "webhook-run-1",
      projectId: "project-a",
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      startedAt: new Date("2026-04-19T12:00:00.000Z"),
    })

    await storage.webhookRuns.finish({
      id: "webhook-run-1",
      projectId: "project-a",
      status: "succeeded",
      finishedAt: new Date("2026-04-19T12:00:02.000Z"),
      responseStatus: 202,
      requestBodyBytes: 12,
      idempotencyKey: "delivery-1",
      deliveryClaimResult: "claimed",
    })
  } finally {
    closeStorage(storage)
  }

  dropMigrationHistory(sqliteStoragePath(basePath))
}

function closeStorage(storage: SqliteStorage): void {
  storage.objects.close()
  storage.auth.close()
  storage.actionRuns.close()
  storage.pipelineRuns.close()
  storage.projectionRuns.close()
  storage.workflowRuns.close()
  storage.workflowInterventions.close()
  storage.syncRuns.close()
  storage.timeseries.close()
  storage.webhookDeliveries.close()
  storage.webhookRuns.close()
  storage.rules.close()
}

function dropMigrationHistory(path: string): void {
  const db = new Database(path)

  try {
    db.run("DROP TABLE IF EXISTS pario_migrations")
  } finally {
    db.close()
  }
}
