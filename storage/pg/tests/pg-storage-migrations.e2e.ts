import { describe, expect, test } from "bun:test"
import { defineObjectType, migrateStorage, OntologyRegistry, prop } from "@sixb/core"
import { defineMigrations } from "@sixb/core/storage"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import { SQL } from "bun"
import { PostgresStorage, type PostgresStorage as PostgresStorageType } from "../src"
import {
  createPostgresMigrator,
  POSTGRES_STORAGE_ADAPTER_ID,
  postgresStorageMigrations,
  quoteIdent,
} from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

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

describe("Postgres storage migrations", () => {
  test("migrateStorage writes schema-level migration history", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const result = await migrateStorage(storage)

      expect(result.status).toBe("migrated")
      expect(result.reports).toMatchObject([
        {
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          status: "migrated",
          applied: [
            "001-initial-schema",
            "002-workflow-run-output",
            "003-merge-sync-runs",
          ],
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
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "002-workflow-run-output",
          status: "applied",
          version: 2,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "003-merge-sync-runs",
          status: "applied",
          version: 3,
        },
      ])
    })
  })

  test("repeated migration planning is idempotent", async () => {
    await withStorage(false, async (storage) => {
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "current" })
    })
  })

  test("merge sync migration preserves existing runs and admits merge mode", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const migrationsBeforeMerge = postgresStorageMigrations.steps.slice(0, 2)
      if (migrationsBeforeMerge.length !== 2) {
        throw new Error("PostgreSQL migrations before merge sync support are missing.")
      }
      const connectionString = process.env.DATABASE_URL
      if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required.")

      const initialSql = createPgClient({ connectionString, schemaName, max: 1 })
      try {
        const beforeMerge = defineMigrations({
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          steps: migrationsBeforeMerge,
        })
        await createPostgresMigrator({
          sql: initialSql,
          schemaName,
          migrations: beforeMerge,
        }).migrate()
        await initialSql.unsafe(
          `
            INSERT INTO ${quoteIdent(schemaName)}.sync_runs (
              project_id, id, sync_id, dataset_id, mode, status, started_at
            ) VALUES ($1, $2, $3, $4, 'append', 'succeeded', $5)
          `,
          ["project-a", "run-append", "sync-orders", "raw.orders", "2026-08-07T12:00:00.000Z"]
        )
      } finally {
        await initialSql.end()
      }

      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })

      await withSql(async (sql) => {
        const rows = await sql.unsafe<{ mode: string }[]>(
          `SELECT mode FROM ${quoteIdent(schemaName)}.sync_runs WHERE project_id = $1 AND id = $2`,
          ["project-a", "run-append"]
        )
        expect(rows).toEqual([{ mode: "append" }])
        await expect(
          sql.unsafe(
            `
              INSERT INTO ${quoteIdent(schemaName)}.sync_runs (
                project_id, id, sync_id, dataset_id, mode, status, started_at
              ) VALUES ($1, $2, $3, $4, 'merge', 'running', $5)
            `,
            ["project-a", "run-merge", "sync-invoices", "raw.invoices", "2026-08-07T12:01:00.000Z"]
          )
        ).resolves.toBeDefined()
      })
    })
  })

  test("recorded old checksums are rejected before schema mutation", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)
      await withSql((sql) =>
        sql.unsafe(
          `UPDATE ${quoteIdent(schemaName)}.sixb_migrations
           SET checksum = 'old-checksum'
           WHERE adapter_id = $1 AND version = 1`,
          [POSTGRES_STORAGE_ADAPTER_ID]
        )
      )

      await expect(migrateStorage(storage)).rejects.toThrow("checksum")
      expect((await readMigrationRows(schemaName))[0]?.checksum_length).toBe("old-checksum".length)
      expect(await readTableNames(schemaName)).toContain("ontology_outbox")
    })
  })

  test("fresh schema installs the exact ontology table set and provenance columns", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)
      expect(
        (await readTableNames(schemaName)).filter((name) => name.startsWith("ontology_"))
      ).toEqual([
        "ontology_commits",
        "ontology_outbox",
        "ontology_overrides",
        "ontology_source_rows",
        "ontology_sources",
      ])
      expect(await readTableColumns(schemaName, "objects")).toContain("last_commit_id")
      expect(await readTableColumns(schemaName, "links")).toContain("last_commit_id")
      expect(await readTableColumns(schemaName, "timeseries")).toContain("last_commit_id")
      expect(await readTableColumns(schemaName, "objects")).not.toContain("source_event_id")
      expect(await readTableColumns(schemaName, "links")).not.toContain("source_event_id")
      expect(await readTableColumns(schemaName, "timeseries")).not.toContain("source_event_id")
      expect(await readTableNames(schemaName)).not.toContain("applied_events_objects")
      await expect(readColumnNullable(schemaName, "objects", "last_commit_id")).resolves.toBe("NO")
      await expect(readColumnNullable(schemaName, "links", "last_commit_id")).resolves.toBe("NO")
      await expect(readColumnNullable(schemaName, "timeseries", "last_commit_id")).resolves.toBe(
        "NO"
      )
      expect(await readTableColumns(schemaName, "timeseries_latest")).toEqual(
        expect.arrayContaining([
          "object_type_id",
          "object_id",
          "property_id",
          "at",
          "last_commit_id",
        ])
      )
      expect(await readTableColumns(schemaName, "projection_runs")).toEqual(
        expect.arrayContaining([
          "attempt",
          "execution_token",
          "materialization_protocol",
          "dataset_version_created_at",
          "fixed_batch_size",
          "next_batch_ordinal",
          "next_row_offset",
          "input_exhausted",
        ])
      )
    })
  })

  test("backfills canonical workflow outputs by node index", async () => {
    const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await withSql(async (sql) => {
      const schema = quoteIdent(schemaName)
      const context = {
        exec: async (sqlText: string) => {
          await sql.unsafe(sqlText)
        },
      }

      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`)
        await sql.unsafe(`SET search_path TO ${schema}`)
        await postgresStorageMigrations.steps[0]?.up(context)
        await sql.unsafe(`
          INSERT INTO workflow_runs (
            project_id, id, workflow_id, status, input, started_at
          ) VALUES
            ('project-a', 'data-run', 'data-workflow', 'succeeded', '{"seed":true}', '2026-01-01T00:00:00.000Z'),
            ('project-a', 'action-run', 'action-workflow', 'succeeded', '{"seed":"kept"}', '2026-01-01T00:00:00.000Z'),
            ('project-a', 'failed-run', 'data-workflow', 'failed', '{"seed":false}', '2026-01-01T00:00:00.000Z');

          INSERT INTO workflow_node_runs (
            project_id, id, workflow_run_id, workflow_id, node_index, node_type,
            node_id, node_key, status, input, started_at, output
          ) VALUES
            ('project-a', 'data-run:node:2', 'data-run', 'data-workflow', 2, 'step',
             'early', 'early', 'succeeded', '{}', '2026-01-01T00:00:00.000Z', '{"winner":2}'),
            ('project-a', 'data-run:node:10', 'data-run', 'data-workflow', 10, 'step',
             'final-data', 'finalData', 'succeeded', '{}', '2026-01-01T00:00:00.000Z', '{"winner":10}'),
            ('project-a', 'data-run:node:11', 'data-run', 'data-workflow', 11, 'action',
             'notify', 'notify', 'succeeded', '{}', '2026-01-01T00:00:00.000Z', '{"actionRunId":"act-1"}'),
            ('project-a', 'action-run:node:0', 'action-run', 'action-workflow', 0, 'action',
             'notify', 'notify', 'succeeded', '{}', '2026-01-01T00:00:00.000Z', '{"actionRunId":"act-2"}');
        `)

        await postgresStorageMigrations.steps[1]?.up(context)

        const rows = await sql.unsafe<{ id: string; output: unknown }[]>(
          "SELECT id, output FROM workflow_runs ORDER BY id"
        )
        expect(rows).toEqual([
          { id: "action-run", output: { seed: "kept" } },
          { id: "data-run", output: { winner: 10 } },
          { id: "failed-run", output: null },
        ])
      } finally {
        await sql.unsafe("RESET search_path")
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      }
    })
  })

  test("untracked existing schema collides and rolls back without conversion", async () => {
    await withStorage(false, async (storage, schemaName) => {
      await migrateStorage(storage)
      await seedExistingStoreRows(storage)
      await dropMigrationHistory(schemaName)

      await expect(migrateStorage(storage)).rejects.toThrow("already exists")
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "project-a",
          objectTypeId: "Room",
          primaryId: "room:101",
        })
      ).toMatchObject({ properties: { name: "Legacy Room" } })
      expect(await readMigrationRows(schemaName)).toEqual([])
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
      expect(sessionColumns).toContain("absolute_expires_at")
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
      // Migrate first, then plant a started row above the applied ones: a dirty history
      // has to block a schema that is otherwise current, which is the case an operator
      // actually meets after a migration was interrupted.
      await migrateStorage(storage)
      await writeStartedMigration(schemaName)

      await expect(migrateStorage(storage)).rejects.toThrow("started and never finished")
    })
  })

  // The teeth of C1.6. `plan()` calls ensure() first, so probing the schema with it runs
  // CREATE SCHEMA / CREATE TABLE. An unauthenticated GET /ready and every `sixb api`
  // boot reach this path, and a least-privilege role has no DDL grant to spend on a
  // health check. (status() also skips the advisory lock plan() takes, which is why N
  // replicas no longer serialize on their first probe — not asserted here because the
  // lock key is private, and a test that guesses it could not fail.)
  test("status() reports an unmigrated schema without creating it", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const [migrator] = storage.migrators
      const status = await migrator?.status()

      expect(status).toMatchObject({
        adapterId: POSTGRES_STORAGE_ADAPTER_ID,
        state: "uninitialized",
        appliedVersion: 0,
      })
      expect(status?.reason).toBeTruthy()
      // No DDL ran: the schema itself never came into existence.
      expect(await schemaExists(schemaName)).toBe(false)
    })
  })

  test("status() reports current after a migration", async () => {
    await withStorage(true, async (storage) => {
      const [migrator] = storage.migrators

      expect(await migrator?.status()).toMatchObject({
        adapterId: POSTGRES_STORAGE_ADAPTER_ID,
        state: "current",
        appliedVersion: 3,
      })
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
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "002-workflow-run-output",
          status: "applied",
          version: 2,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "003-merge-sync-runs",
          status: "applied",
          version: 3,
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
  await createMaterializerTestFixture({ projectId: "project-a", ontology, storage }).seed({
    objects: [
      {
        ref: { objectTypeId: "Room", primaryId: "room:101" },
        properties: { id: "room:101", name: "Legacy Room" },
      },
    ],
    telemetry: [
      {
        series: {
          object: { objectTypeId: "Room", primaryId: "room:101" },
          propertyId: "temperature",
        },
        value: 21.5,
        at: "2026-04-19T12:00:01.000Z",
      },
    ],
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
  const projectionRun = await storage.projectionRuns.startOrReclaim({
    id: "proj-run-1",
    projectId: "project-a",
    identity: {
      projectionId: "room-proj",
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: {
        datasetId: "raw.orders",
        versionId: "ver_1",
        createdAt: "2026-04-19T12:00:00.000Z",
      },
      ontologyRevision: "ontology-1",
      projectionRevision: "projection-1",
      ownershipHash: "ownership-1",
    },
    target: { objectTypeId: "Room" },
    startedAt: new Date("2026-04-19T12:00:00.000Z"),
  })
  await storage.projectionRuns.finish({
    id: "proj-run-1",
    projectId: "project-a",
    identity: projectionRun.run.identity,
    executionToken: projectionRun.execution.executionToken,
    protocol: "replacement",
    status: "succeeded",
    finishedAt: new Date("2026-04-19T12:00:01.000Z"),
    progress: { sourceRowsRead: 4 },
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
    output: { transactionId: "txn-1" },
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

async function readColumnNullable(
  schemaName: string,
  tableName: string,
  columnName: string
): Promise<"YES" | "NO"> {
  return withSql(async (sql) => {
    const [row] = (await sql.unsafe(
      `
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
      `,
      [schemaName, tableName, columnName]
    )) as Array<{ is_nullable: "YES" | "NO" }>
    if (!row) throw new Error(`Column ${tableName}.${columnName} was not found.`)
    return row.is_nullable
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
        ) VALUES ($1, 9999, '9999-interrupted', NULL, 'started', $2, NULL)
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

async function schemaExists(schemaName: string): Promise<boolean> {
  return withSql(async (sql) => {
    const rows = (await sql.unsafe(`SELECT to_regnamespace($1) AS oid`, [schemaName])) as Array<{
      oid: string | null
    }>
    return Boolean(rows[0]?.oid)
  })
}
