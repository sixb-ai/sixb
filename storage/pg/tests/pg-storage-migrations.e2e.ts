import { describe, expect, test } from "bun:test"
import { migrateStorage } from "@sixb/core"
import { SQL } from "bun"
import {
  POSTGRES_STORAGE_ADAPTER_ID,
  PostgresStorage,
  type PostgresStorage as PostgresStorageType,
  quoteIdent,
} from "../src"
import { createTestStorage } from "./helpers"

describe("Postgres storage migrations", () => {
  test("migrateStorage writes schema-level migration history", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const result = await migrateStorage(storage)

      expect(result.status).toBe("migrated")
      expect(result.reports).toMatchObject([
        {
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          status: "migrated",
          applied: ["001-initial-schema"],
        },
      ])
      expect(await readMigrationRows(schemaName)).toEqual([
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "001-initial-schema",
          status: "applied",
          version: 1,
        },
      ])
    })
  })

  test("migrations preserve existing store rows", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)
      await seedExistingStoreRows(storage)
      await dropMigrationHistory(schemaName)

      const result = await migrateStorage(storage)
      const object = await storage.objects.getByPrimaryId({
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
      const syncRun = await storage.syncRuns.getById({ projectId: "project-a", id: "run-1" })
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

      expect(result.status).toBe("migrated")
      expect(object?.properties).toEqual({ name: "Legacy Room" })
      expect(point?.value).toBe(21.5)
      expect(syncRun?.checkpoint).toEqual({ cursor: "legacy" })
      expect(projectionRun?.status).toBe("succeeded")
      expect(projectionRun?.objectsUpserted).toBe(4)
      expect(projectionRun?.telemetryPointsAppended).toBe(0)
      expect(projectionRun?.telemetryPointsSkipped).toBe(0)
      expect(projectionRun?.telemetryRowsFailed).toBe(0)
      expect(workflowRun?.status).toBe("succeeded")
      expect(workflowRun?.input).toEqual({ transactionId: "txn-1" })
      expect(webhookRun).toMatchObject({
        connectorId: "github",
        webhookId: "events",
        status: "succeeded",
        responseStatus: 202,
      })
      expect(await readWebhookDeliveryStatus(schemaName)).toBe("completed")
    })
  })

  test("migrations install auth storage tables", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)

      await storage.auth.users.create({
        id: "usr_1",
        projectId: "project-a",
        email: "ava@acme.com",
      })

      const user = await storage.auth.users.getByEmail({
        projectId: "project-a",
        email: "ava@acme.com",
      })
      const tableNames = await readTableNames(schemaName)
      const sessionColumns = await readTableColumns(schemaName, "auth_sessions")

      expect(user).toMatchObject({
        id: "usr_1",
        email: "ava@acme.com",
      })
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "auth_users",
          "auth_user_identities",
          "auth_service_accounts",
          "auth_service_account_group_memberships",
          "auth_sessions",
          "auth_access_tokens",
          "auth_invitations",
          "auth_invitation_groups",
          "auth_group_memberships",
          "auth_magic_links",
          "auth_oidc_authorization_attempts",
        ])
      )
      expect(sessionColumns).toContain("audience")
      expect(sessionColumns).toContain("user_agent")
      expect(sessionColumns).toContain("ip_address")
    })
  })

  test("migrations install agent storage tables", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)

      await storage.agents.threads.create({
        id: "thr_1",
        projectId: "project-a",
        agentId: "sales",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:00:00.000Z"),
      })

      const thread = await storage.agents.threads.getById({ projectId: "project-a", id: "thr_1" })
      const tableNames = await readTableNames(schemaName)

      expect(thread).toMatchObject({ id: "thr_1", agentId: "sales", messageCount: 0 })
      expect(tableNames).toEqual(
        expect.arrayContaining(["agent_threads", "agent_runs", "agent_messages"])
      )
    })
  })

  test("dirty migration history blocks storage migrations", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await storage.migrators[0]!.plan()
      await writeStartedMigration(schemaName)

      await expect(migrateStorage(storage)).rejects.toThrow("dirty migration state")
    })
  })

  test("serializes concurrent storage migrations for the same schema", async () => {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error("[SixbPg] DATABASE_URL is required for Postgres migration tests.")
    }

    const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const storages = Array.from(
      { length: 4 },
      () => new PostgresStorage({ connectionString, schemaName, max: 2 })
    )

    try {
      const results = await Promise.all(storages.map((storage) => migrateStorage(storage)))
      const statuses = results.map((result) => result.status).sort()

      expect(statuses).toEqual(["current", "current", "current", "migrated"])
      expect(await readMigrationRows(schemaName)).toEqual([
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "001-initial-schema",
          status: "applied",
          version: 1,
        },
      ])
    } finally {
      await storages[0]?.dropSchema()
      await Promise.all(storages.map((storage) => storage.close()))
    }
  })
})

async function withStorage(
  migrate: boolean,
  run: (storage: PostgresStorageType, schemaName: string) => Promise<void>
): Promise<void> {
  const { storage, schemaName } = await createTestStorage({ migrate })

  try {
    await run(storage, schemaName)
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
}

async function seedExistingStoreRows(storage: PostgresStorage): Promise<void> {
  await storage.objects.applyObjectUpsert({
    id: "object-event",
    cursor: "1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
    topic: "objects",
    partitionKey: "Room:room:101",
    payload: {
      objectTypeId: "Room",
      primaryId: "room:101",
      properties: { name: "Legacy Room" },
      propertyChanges: {},
    },
    occurredAt: "2026-04-19T12:00:00.000Z",
  })
  await storage.timeseries.applyTelemetryAppended({
    id: "telemetry-event",
    cursor: "2",
    schemaVersion: 1,
    projectId: "project-a",
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: "Room:room:101:temperature",
    payload: {
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "temperature",
      value: 21.5,
      at: "2026-04-19T12:00:01.000Z",
    },
    occurredAt: "2026-04-19T12:00:01.000Z",
  })
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
}

async function readMigrationRows(schemaName: string): Promise<
  Array<{
    adapter_id: string
    checksum_length: number
    id: string
    status: string
    version: number
  }>
> {
  return withSql(async (sql) => {
    const rows = (await sql.unsafe(`
      SELECT adapter_id, version, id, status, length(checksum) AS checksum_length
      FROM ${quoteIdent(schemaName)}.sixb_migrations
      ORDER BY adapter_id, version
    `)) as Array<{
      adapter_id: string
      checksum_length: number | string
      id: string
      status: string
      version: number
    }>

    return rows.map((row) => ({
      ...row,
      checksum_length: Number(row.checksum_length),
    }))
  })
}

async function readWebhookDeliveryStatus(schemaName: string): Promise<string | undefined> {
  return withSql(async (sql) => {
    const [row] = (await sql.unsafe(`
      SELECT status
      FROM ${quoteIdent(schemaName)}.webhook_deliveries
      WHERE project_id = 'project-a'
        AND connector_id = 'github'
        AND webhook_id = 'events'
        AND idempotency_key = 'delivery-1'
    `)) as Array<{ status: string }>

    return row?.status
  })
}

async function readTableNames(schemaName: string): Promise<readonly string[]> {
  return withSql(async (sql) => {
    const rows = (await sql.unsafe(
      `
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = $1
        ORDER BY tablename
      `,
      [schemaName]
    )) as Array<{ tablename: string }>

    return rows.map((row) => row.tablename)
  })
}

async function readTableColumns(schemaName: string, tableName: string): Promise<readonly string[]> {
  return withSql(async (sql) => {
    const rows = (await sql.unsafe(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
        ORDER BY ordinal_position
      `,
      [schemaName, tableName]
    )) as Array<{ column_name: string }>

    return rows.map((row) => row.column_name)
  })
}

async function dropMigrationHistory(schemaName: string): Promise<void> {
  await withSql((sql) =>
    sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.sixb_migrations`)
  )
}

async function writeStartedMigration(schemaName: string): Promise<void> {
  await withSql((sql) =>
    sql.unsafe(
      `
        INSERT INTO ${quoteIdent(schemaName)}.sixb_migrations (
          adapter_id, version, id, checksum, status, started_at, finished_at
        ) VALUES ($1, 1, '001-initial-schema', NULL, 'started', $2, NULL)
      `,
      [POSTGRES_STORAGE_ADAPTER_ID, "2026-04-19T00:00:00.000Z"]
    )
  )
}

async function withSql<T>(run: (sql: SQL) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required.")

  const sql = new SQL({ url: connectionString, max: 1 })
  try {
    return await run(sql)
  } finally {
    await sql.close()
  }
}
