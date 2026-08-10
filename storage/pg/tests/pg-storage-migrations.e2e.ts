import { describe, expect, test } from "bun:test"
import { defineObjectType, migrateStorage, OntologyRegistry, prop } from "@sixb/core"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import { defineMigrations, ONTOLOGY_OUTBOX_FAILURE_CODES } from "@sixb/core/storage"
import { createMaterializerTestFixture, createTestWorkflowExecution } from "@sixb/core/testing"
import { SQL } from "bun"
import { PostgresStorage, type PostgresStorage as PostgresStorageType } from "../src"
import {
  createPostgresMigrator,
  POSTGRES_STORAGE_ADAPTER_ID,
  postgresStorageMigrations,
  quoteIdent,
} from "../src/migrations"
import { jsonParameter } from "../src/ontology-storage/shared"
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
            "004-executions",
            "005-workflow-executions",
            "006-narrow-ontology-source-root-index",
            "007-split-overrides",
            "008-action-executions",
            "009-agent-executions",
            "010-ai-usage-accounting-foundation",
            "011-sync-failure-record",
            "012-pipeline-failure-record",
            "013-workflow-failure-record",
            "014-agent-failure-record",
            "015-projection-failure-record",
            "016-webhook-run-failure-record",
            "017-action-failure-record",
            "018-ontology-outbox-failure-record",
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
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "004-executions",
          status: "applied",
          version: 4,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "005-workflow-executions",
          status: "applied",
          version: 5,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "006-narrow-ontology-source-root-index",
          status: "applied",
          version: 6,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "007-split-overrides",
          status: "applied",
          version: 7,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "008-action-executions",
          status: "applied",
          version: 8,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "009-agent-executions",
          status: "applied",
          version: 9,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "010-ai-usage-accounting-foundation",
          status: "applied",
          version: 10,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "011-sync-failure-record",
          status: "applied",
          version: 11,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "012-pipeline-failure-record",
          status: "applied",
          version: 12,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "013-workflow-failure-record",
          status: "applied",
          version: 13,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "014-agent-failure-record",
          status: "applied",
          version: 14,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "015-projection-failure-record",
          status: "applied",
          version: 15,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "016-webhook-run-failure-record",
          status: "applied",
          version: 16,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "017-action-failure-record",
          status: "applied",
          version: 17,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "018-ontology-outbox-failure-record",
          status: "applied",
          version: 18,
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

      // Keep the upgrade and its verification on postgres.js. Replacing the verification with
      // two sequential Bun SQL queries at max: 1 reproduces a five-second test timeout, then
      // leaves the test process alive because the second query is never dispatched.
      const sql = createPgClient({ connectionString, schemaName, max: 1 })
      try {
        const beforeMerge = defineMigrations({
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          steps: migrationsBeforeMerge,
        })
        await createPostgresMigrator({
          sql,
          schemaName,
          migrations: beforeMerge,
        }).migrate()
        await sql.unsafe(
          `
            INSERT INTO ${quoteIdent(schemaName)}.sync_runs (
              project_id, id, sync_id, dataset_id, mode, status, started_at
            ) VALUES ($1, $2, $3, $4, 'append', 'succeeded', $5)
          `,
          ["project-a", "run-append", "sync-orders", "raw.orders", "2026-08-07T12:00:00.000Z"]
        )

        await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
        await sql.unsafe(
          `
            INSERT INTO ${quoteIdent(schemaName)}.sync_runs (
              project_id, id, sync_id, dataset_id, mode, status, started_at
            ) VALUES ($1, $2, $3, $4, 'merge', 'running', $5)
          `,
          ["project-a", "run-merge", "sync-invoices", "raw.invoices", "2026-08-07T12:01:00.000Z"]
        )

        const rows = await sql.unsafe<{ id: string; mode: string }[]>(
          `SELECT id, mode FROM ${quoteIdent(schemaName)}.sync_runs ORDER BY id`
        )
        expect([...rows]).toEqual([
          { id: "run-append", mode: "append" },
          { id: "run-merge", mode: "merge" },
        ])
      } finally {
        await sql.end()
      }
    })
  })

  test("splits legacy overrides and derives unambiguous link slot authority", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const connectionString = process.env.DATABASE_URL
      if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required.")
      const sql = createPgClient({ connectionString, schemaName, max: 1 })
      try {
        const splitOverridesIndex = postgresStorageMigrations.steps.findIndex(
          (migration) => migration.id === "007-split-overrides"
        )
        const splitOverridesMigration = postgresStorageMigrations.steps[splitOverridesIndex]
        if (!splitOverridesMigration) {
          throw new Error("PostgreSQL split-overrides migration is missing.")
        }
        const beforeScopeAuthority = defineMigrations({
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          steps: postgresStorageMigrations.steps.slice(0, splitOverridesIndex),
        })
        await createPostgresMigrator({
          sql,
          schemaName,
          migrations: beforeScopeAuthority,
        }).migrate()
        const insertLegacyLinkOverride = async (input: {
          readonly sourceId: string
          readonly targetId: string
          readonly value: unknown
          readonly updatedAt: string
        }) => {
          const entityKey = JSON.stringify([
            "Device",
            input.sourceId,
            "parent",
            "Device",
            input.targetId,
          ])
          await sql.unsafe(
            `INSERT INTO ${quoteIdent(schemaName)}.ontology_overrides (
               project_id, entity_kind, entity_key, entity_sort_key,
               source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
               value, last_commit_id, updated_at
             ) VALUES (
               'project', 'link', $1::jsonb, $1::text,
               'Device', $2, 'parent', 'Device', $3,
               $4::jsonb, $5, $6::timestamptz
             )`,
            [
              entityKey,
              input.sourceId,
              input.targetId,
              jsonParameter(sql, input.value),
              `commit:${input.sourceId}:${input.targetId}`,
              input.updatedAt,
            ]
          )
        }
        await insertLegacyLinkOverride({
          sourceId: "document",
          targetId: "rockland",
          value: { kind: "upsert", properties: { rank: 1 } },
          updatedAt: "2026-01-02T00:00:00.000Z",
        })
        await insertLegacyLinkOverride({
          sourceId: "document",
          targetId: "haverstraw",
          value: { kind: "delete" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        await insertLegacyLinkOverride({
          sourceId: "ambiguous",
          targetId: "first",
          value: { kind: "upsert" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        await insertLegacyLinkOverride({
          sourceId: "ambiguous",
          targetId: "second",
          value: { kind: "upsert" },
          updatedAt: "2026-01-02T00:00:00.000Z",
        })

        const migration = await migrateStorage(storage)
        expect(migration).toMatchObject({ status: "migrated" })
        const rows = await sql.unsafe<{ source_primary_id: string; value: unknown }[]>(
          `SELECT source_primary_id, value
           FROM ${quoteIdent(schemaName)}.ontology_link_overrides
           WHERE identity_kind = 'slot'
           ORDER BY source_primary_id`
        )
        expect([...rows]).toEqual([
          { source_primary_id: "ambiguous", value: { kind: "legacy-conflict" } },
          {
            source_primary_id: "document",
            value: {
              kind: "set",
              target: { objectTypeId: "Device", primaryId: "rockland" },
              properties: { rank: 1 },
            },
          },
        ])
      } finally {
        await sql.end()
      }
    })
  })

  test("ontology outbox failure migration replaces legacy diagnostics with a safe failure", async () => {
    await withStorage(false, async (storage, schemaName) => {
      const failureMigrationIndex = postgresStorageMigrations.steps.findIndex(
        (migration) => migration.id === "018-ontology-outbox-failure-record"
      )
      if (failureMigrationIndex !== 17) {
        throw new Error("PostgreSQL ontology outbox failure migration is missing.")
      }
      const connectionString = process.env.DATABASE_URL
      if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required.")

      const sql = createPgClient({ connectionString, schemaName, max: 1 })
      try {
        const beforeFailureRecord = defineMigrations({
          adapterId: POSTGRES_STORAGE_ADAPTER_ID,
          steps: postgresStorageMigrations.steps.slice(0, failureMigrationIndex),
        })
        await createPostgresMigrator({
          sql,
          schemaName,
          migrations: beforeFailureRecord,
        }).migrate()
        await sql.unsafe(`
          INSERT INTO ${quoteIdent(schemaName)}.ontology_outbox (
            project_id, id, commit_id, commit_ordinal, envelope, available_at,
            attempts, published_at, last_error, created_at
          ) VALUES
            (
              'project-a', 'event-failed', 'commit-failed', 0,
              '{"type":"object.created"}'::jsonb, '2026-08-10T12:01:00.000Z',
              2, NULL, 'Error: broker unavailable', '2026-08-10T12:00:00.000Z'
            ),
            (
              'project-a', 'event-stopped', 'commit-stopped', 0,
              '{"type":"object.updated"}'::jsonb, '2026-08-10T12:02:00.000Z',
              1, NULL, 'Outbox dispatcher stopped before publication completed.',
              '2026-08-10T12:00:00.000Z'
            )
        `)

        await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })

        const rows = await sql.unsafe<
          Array<{ readonly id: string; readonly last_failure: unknown | null }>
        >(`SELECT id, last_failure FROM ${quoteIdent(schemaName)}.ontology_outbox ORDER BY id`)
        expect(parseSixbFailure(rows[0]?.last_failure, ONTOLOGY_OUTBOX_FAILURE_CODES)).toEqual({
          code: "event.delivery_failed",
          message: "Event delivery failed.",
          retryable: true,
          at: "2026-08-10T12:01:00.000Z",
          details: {
            attempts: 2,
            eventIds: ["event-failed"],
            eventTypes: ["object.created"],
            migratedFromLegacyLastError: true,
            timestampSource: "availableAt",
          },
        })
        expect(rows[1]).toEqual({ id: "event-stopped", last_failure: null })
        expect(await readTableColumns(schemaName, "ontology_outbox")).toContain("last_failure")
        expect(await readTableColumns(schemaName, "ontology_outbox")).not.toContain("last_error")
      } finally {
        await sql.end()
      }
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
        "ontology_link_overrides",
        "ontology_object_overrides",
        "ontology_outbox",
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
          "error",
        ])
      )
      expect(await readTableColumns(schemaName, "workflow_runs")).toEqual(
        expect.arrayContaining(["execution_id"])
      )
      expect(await readTableColumns(schemaName, "workflow_runs")).not.toEqual(
        expect.arrayContaining([
          "source",
          "requested_by_principal_type",
          "requested_by_principal_id",
        ])
      )
      await expect(readColumnNullable(schemaName, "workflow_runs", "execution_id")).resolves.toBe(
        "NO"
      )
      expect(await readTableColumns(schemaName, "action_runs")).toContain("execution_id")
      await expect(readColumnNullable(schemaName, "action_runs", "execution_id")).resolves.toBe(
        "NO"
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

  test("requires explicit project handling for legacy workflow runs", async () => {
    const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await withSql(async (sql) => {
      const schema = quoteIdent(schemaName)
      const context = { exec: (sqlText: string) => sql.unsafe(sqlText).then(() => undefined) }

      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`)
        await sql.unsafe(`SET search_path TO ${schema}`)
        for (const migration of postgresStorageMigrations.steps.slice(0, 4)) {
          await migration.up(context)
        }
        await sql.unsafe(`
          INSERT INTO workflow_runs (
            project_id, id, workflow_id, status, input, started_at
          ) VALUES (
            'project-a', 'legacy-run', 'legacy-workflow', 'queued', '{}',
            '2026-01-01T00:00:00.000Z'
          )
        `)

        await expect(postgresStorageMigrations.steps[4]?.up(context)).rejects.toThrow()
        expect(await readTableColumns(schemaName, "workflow_runs")).not.toContain("execution_id")
      } finally {
        await sql.unsafe("RESET search_path")
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      }
    })
  })

  test("rejects legacy Action runs instead of inventing their execution authority", async () => {
    const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await withSql(async (sql) => {
      const schema = quoteIdent(schemaName)
      const context = { exec: (sqlText: string) => sql.unsafe(sqlText).then(() => undefined) }

      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`)
        await sql.unsafe(`SET search_path TO ${schema}`)
        for (const migration of postgresStorageMigrations.steps.slice(0, 6)) {
          await migration.up(context)
        }
        await sql.unsafe(`
          INSERT INTO action_runs (
            project_id, id, action_id, subject_kind, status, phase, queued_at, params,
            idempotency_key
          ) VALUES (
            'project-a', 'legacy-action-run', 'legacy-action', 'none', 'queued', 'request',
            '2026-01-01T00:00:00.000Z', '{}', 'action:project-a:legacy-action-run'
          )
        `)

        const actionExecutionsMigration = postgresStorageMigrations.steps.find(
          (migration) => migration.id === "008-action-executions"
        )
        if (!actionExecutionsMigration) {
          throw new Error("PostgreSQL action-executions migration is missing.")
        }
        await expect(actionExecutionsMigration.up(context)).rejects.toThrow()
        expect(await readTableColumns(schemaName, "action_runs")).not.toContain("execution_id")
      } finally {
        await sql.unsafe("RESET search_path")
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      }
    })
  })

  test("rejects legacy Agent runs instead of inventing their execution authority", async () => {
    const schemaName = `sixb_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await withSql(async (sql) => {
      const schema = quoteIdent(schemaName)
      const context = { exec: (sqlText: string) => sql.unsafe(sqlText).then(() => undefined) }

      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`)
        await sql.unsafe(`SET search_path TO ${schema}`)
        const agentExecutionsIndex = postgresStorageMigrations.steps.findIndex(
          (migration) => migration.id === "009-agent-executions"
        )
        const agentExecutionsMigration = postgresStorageMigrations.steps[agentExecutionsIndex]
        if (!agentExecutionsMigration) {
          throw new Error("PostgreSQL agent-executions migration is missing.")
        }
        for (const migration of postgresStorageMigrations.steps.slice(0, agentExecutionsIndex)) {
          await migration.up(context)
        }
        await sql.unsafe(`
          INSERT INTO agent_runs (
            project_id, id, thread_id, agent_id, trigger_message_id, status, created_at
          ) VALUES (
            'project-a', 'legacy-agent-run', 'legacy-thread', 'legacy-agent',
            'legacy-message', 'queued', '2026-01-01T00:00:00.000Z'
          )
        `)

        await expect(agentExecutionsMigration.up(context)).rejects.toThrow()
        expect(await readTableColumns(schemaName, "agent_runs")).not.toContain("execution_id")
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

  test("migrations install agent attribution and AI usage storage tables", async () => {
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
        expect.arrayContaining([
          "agent_threads",
          "agent_runs",
          "agent_messages",
          "ai_model_call_usage",
          "ai_model_call_usage_groups",
        ])
      )
      expect(await readTableColumns(schemaName, "ai_model_call_usage")).toContain("execution_id")
      expect(await readTableColumns(schemaName, "ai_model_call_usage")).not.toContain(
        "execution_kind"
      )
      expect(await readTableColumns(schemaName, "ai_model_call_usage")).not.toContain(
        "requester_principal_id"
      )
      expect(await readTableForeignKeys(schemaName, "ai_model_call_usage")).toContainEqual({
        column_name: "execution_id",
        delete_action: "r",
        foreign_column_name: "id",
        foreign_table_name: "executions",
      })
      expect(await readTableColumns(schemaName, "agent_runs")).toEqual(
        expect.arrayContaining(["requester_group_ids", "usage_input_tokens"])
      )
      expect(await readTableColumns(schemaName, "workflow_runs")).toContain("requester_group_ids")
      expect(await readTableColumns(schemaName, "workflow_agent_node_runs")).toContain("usage")
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
      const expectedVersion = postgresStorageMigrations.latestVersion

      expect(await migrator?.status()).toMatchObject({
        adapterId: POSTGRES_STORAGE_ADAPTER_ID,
        state: "current",
        latestVersion: expectedVersion,
        appliedVersion: expectedVersion,
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
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "004-executions",
          status: "applied",
          version: 4,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "005-workflow-executions",
          status: "applied",
          version: 5,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "006-narrow-ontology-source-root-index",
          status: "applied",
          version: 6,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "007-split-overrides",
          status: "applied",
          version: 7,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "008-action-executions",
          status: "applied",
          version: 8,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "009-agent-executions",
          status: "applied",
          version: 9,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "010-ai-usage-accounting-foundation",
          status: "applied",
          version: 10,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "011-sync-failure-record",
          status: "applied",
          version: 11,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "012-pipeline-failure-record",
          status: "applied",
          version: 12,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "013-workflow-failure-record",
          status: "applied",
          version: 13,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "014-agent-failure-record",
          status: "applied",
          version: 14,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "015-projection-failure-record",
          status: "applied",
          version: 15,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "016-webhook-run-failure-record",
          status: "applied",
          version: 16,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "017-action-failure-record",
          status: "applied",
          version: 17,
        },
        {
          adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
          checksum_length: 64,
          id: "018-ontology-outbox-failure-record",
          status: "applied",
          version: 18,
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
  const workflowExecutionId = await createTestWorkflowExecution(storage.executions, {
    projectId: "project-a",
    workflowId: "reconcile-transaction",
    runId: "workflow-run-1",
  })
  await storage.workflowRuns.queue({
    id: "workflow-run-1",
    projectId: "project-a",
    executionId: workflowExecutionId,
    workflowId: "reconcile-transaction",
    input: {
      transactionId: "txn-1",
    },
    requesterGroupIds: [],
    queuedAt: new Date("2026-04-19T11:59:59.000Z"),
  })
  await storage.workflowRuns.start({
    id: "workflow-run-1",
    projectId: "project-a",
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

async function readTableForeignKeys(
  schemaName: string,
  tableName: string
): Promise<
  readonly {
    readonly column_name: string
    readonly delete_action: string
    readonly foreign_column_name: string
    readonly foreign_table_name: string
  }[]
> {
  return withSql(async (sql) => {
    return (await sql.unsafe(
      `
        SELECT
          source_column.attname AS column_name,
          target_table.relname AS foreign_table_name,
          target_column.attname AS foreign_column_name,
          c.confdeltype::text AS delete_action
        FROM pg_constraint AS c
        JOIN pg_class AS source_table ON source_table.oid = c.conrelid
        JOIN pg_namespace AS source_schema ON source_schema.oid = source_table.relnamespace
        JOIN pg_class AS target_table ON target_table.oid = c.confrelid
        JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS source_key(attnum, position)
          ON TRUE
        JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS target_key(attnum, position)
          ON target_key.position = source_key.position
        JOIN pg_attribute AS source_column
          ON source_column.attrelid = source_table.oid
          AND source_column.attnum = source_key.attnum
        JOIN pg_attribute AS target_column
          ON target_column.attrelid = target_table.oid
          AND target_column.attnum = target_key.attnum
        WHERE c.contype = 'f'
          AND source_schema.nspname = $1
          AND source_table.relname = $2
        ORDER BY c.conname, source_key.position
      `,
      [schemaName, tableName]
    )) as Array<{
      readonly column_name: string
      readonly delete_action: string
      readonly foreign_column_name: string
      readonly foreign_table_name: string
    }>
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
