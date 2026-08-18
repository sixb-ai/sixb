import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { SqliteStorage } from "../src"
import {
  createSqliteStorageMigrators,
  SQLITE_STORAGE_ADAPTER_ID,
  sqliteStorageMigrations,
  sqliteStoragePath,
} from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"

const tempDirs: string[] = []
const expectedStorageMigrationRows = [
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "001-initial-schema",
    status: "applied",
    version: 1,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "002-workflow-run-output",
    status: "applied",
    version: 2,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "003-merge-sync-runs",
    status: "applied",
    version: 3,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "004-executions",
    status: "applied",
    version: 4,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "005-workflow-executions",
    status: "applied",
    version: 5,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "006-narrow-ontology-source-root-index",
    status: "applied",
    version: 6,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "007-split-overrides",
    status: "applied",
    version: 7,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "008-action-executions",
    status: "applied",
    version: 8,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "009-agent-executions",
    status: "applied",
    version: 9,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "010-ai-usage-accounting-foundation",
    status: "applied",
    version: 10,
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
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    const result = await migrateStorage(storage)

    closeStorage(storage)

    expect(result.status).toBe("migrated")
    expect(readMigrationRows(sqliteStoragePath(tempDir))).toEqual(expectedStorageMigrationRows)
  })

  test("repeated migration planning is idempotent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-idempotent-migrations-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    try {
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "current" })
    } finally {
      storage.close()
    }
  })

  test("merge sync migration preserves existing runs and admits merge mode", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)
      sqliteStorageMigrations.steps[1]?.up(db)
      db.query(`
        INSERT INTO sync_runs (
          project_id, id, sync_id, dataset_id, mode, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "project-a",
        "run-append",
        "sync-orders",
        "raw.orders",
        "append",
        "succeeded",
        "2026-08-07T12:00:00.000Z"
      )

      expect(() =>
        db
          .query(`
          INSERT INTO sync_runs (
            project_id, id, sync_id, dataset_id, mode, status, started_at
          ) VALUES (?, ?, ?, ?, 'merge', 'running', ?)
        `)
          .run(
            "project-a",
            "run-before-migration",
            "sync-invoices",
            "raw.invoices",
            "2026-08-07T12:01:00.000Z"
          )
      ).toThrow()

      sqliteStorageMigrations.steps[2]?.up(db)

      expect(
        db
          .query("SELECT mode FROM sync_runs WHERE project_id = ? AND id = ?")
          .get("project-a", "run-append")
      ).toEqual({ mode: "append" })
      expect(() =>
        db
          .query(`
          INSERT INTO sync_runs (
            project_id, id, sync_id, dataset_id, mode, status, started_at
          ) VALUES (?, ?, ?, ?, 'merge', 'running', ?)
        `)
          .run(
            "project-a",
            "run-merge",
            "sync-invoices",
            "raw.invoices",
            "2026-08-07T12:02:00.000Z"
          )
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  test("splits legacy overrides and derives unambiguous link slot authority", () => {
    const db = new Database(":memory:")
    try {
      const splitOverridesIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "007-split-overrides"
      )
      const splitOverridesMigration = sqliteStorageMigrations.steps[splitOverridesIndex]
      if (!splitOverridesMigration) {
        throw new Error("SQLite split-overrides migration is missing.")
      }
      for (const migration of sqliteStorageMigrations.steps.slice(0, splitOverridesIndex)) {
        migration.up(db)
      }

      db.query(
        `INSERT INTO ontology_overrides (
           project_id, entity_kind, entity_key, entity_sort_key,
           object_type_id, primary_id, value, last_commit_id, updated_at
         ) VALUES ('project', 'object', json(?), ?, 'Device', 'document', json(?),
           'commit:object', '2026-01-01T00:00:00.000Z')`
      ).run(
        JSON.stringify(["Device", "document"]),
        JSON.stringify(["Device", "document"]),
        JSON.stringify({ kind: "create", properties: { name: "Document" } })
      )

      insertLegacyLinkOverride(db, {
        sourceId: "document",
        linkId: "parent",
        targetId: "rockland",
        value: { kind: "upsert", properties: { rank: 1 } },
        updatedAt: "2026-01-02T00:00:00.000Z",
      })
      insertLegacyLinkOverride(db, {
        sourceId: "document",
        linkId: "parent",
        targetId: "haverstraw",
        value: { kind: "delete" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      insertLegacyLinkOverride(db, {
        sourceId: "cleared",
        linkId: "parent",
        targetId: "old-parent",
        value: { kind: "delete" },
        updatedAt: "2026-01-03T00:00:00.000Z",
      })
      insertLegacyLinkOverride(db, {
        sourceId: "ambiguous",
        linkId: "parent",
        targetId: "first",
        value: { kind: "upsert" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      insertLegacyLinkOverride(db, {
        sourceId: "ambiguous",
        linkId: "parent",
        targetId: "second",
        value: { kind: "upsert" },
        updatedAt: "2026-01-02T00:00:00.000Z",
      })

      splitOverridesMigration.up(db)

      const rows = db
        .query(
          `SELECT source_primary_id, value FROM ontology_link_overrides
           WHERE identity_kind = 'slot'
           ORDER BY source_primary_id`
        )
        .all() as { readonly source_primary_id: string; readonly value: string }[]
      expect(rows.map((row) => [row.source_primary_id, JSON.parse(row.value)])).toEqual([
        ["ambiguous", { kind: "legacy-conflict" }],
        ["cleared", { kind: "clear", target: { objectTypeId: "Device", primaryId: "old-parent" } }],
        [
          "document",
          {
            kind: "set",
            target: { objectTypeId: "Device", primaryId: "rockland" },
            properties: { rank: 1 },
          },
        ],
      ])
      expect(
        db
          .query(
            `SELECT value FROM ontology_object_overrides
             WHERE project_id = 'project' AND object_type_id = 'Device' AND primary_id = 'document'`
          )
          .get()
      ).toEqual({ value: JSON.stringify({ kind: "create", properties: { name: "Document" } }) })
      expect(
        db
          .query(
            `SELECT COUNT(*) AS count FROM ontology_link_overrides
             WHERE identity_kind = 'edge'`
          )
          .get()
      ).toEqual({ count: 5 })
      expect(readMemoryTableNames(db)).not.toContain("ontology_overrides")
      expect(
        new SqliteMaterializationStateReader(db, "project").linkState({
          source: { objectTypeId: "Device", primaryId: "ambiguous" },
          linkId: "parent",
          target: { objectTypeId: "Device", primaryId: "first" },
        }).slotOverride?.value
      ).toEqual({ kind: "legacy-conflict" })
    } finally {
      db.close()
    }
  })

  test("enforces edge and slot identity independently of the selected target", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)
      const insert = db.query(
        `INSERT INTO ontology_link_overrides (
           project_id, identity_kind, identity_key,
           source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
           value, last_commit_id, updated_at
         ) VALUES ('project', ?, json(?), 'Device', ?, 'parent', 'Device', ?,
           json(?), 'commit', '2026-01-01T00:00:00.000Z')`
      )

      expect(() =>
        insert.run(
          "edge",
          JSON.stringify(["Device", "document", "parent", "Device", "rockland"]),
          "document",
          "rockland",
          JSON.stringify({ kind: "upsert" })
        )
      ).not.toThrow()
      expect(() =>
        insert.run(
          "slot",
          JSON.stringify(["Device", "document", "parent"]),
          "document",
          "rockland",
          JSON.stringify({
            kind: "set",
            target: { objectTypeId: "Device", primaryId: "rockland" },
          })
        )
      ).not.toThrow()

      // A slot key excludes the target, so selecting another target conflicts with the same row.
      expect(() =>
        insert.run(
          "slot",
          JSON.stringify(["Device", "document", "parent"]),
          "document",
          "haverstraw",
          JSON.stringify({
            kind: "set",
            target: { objectTypeId: "Device", primaryId: "haverstraw" },
          })
        )
      ).toThrow()
      expect(() =>
        insert.run(
          "slot",
          JSON.stringify(["Device", "document", "parent", "Device", "rockland"]),
          "document",
          "rockland",
          JSON.stringify({
            kind: "set",
            target: { objectTypeId: "Device", primaryId: "rockland" },
          })
        )
      ).toThrow()
      expect(() =>
        insert.run(
          "slot",
          JSON.stringify(["Device", "another-document", "parent"]),
          "another-document",
          "rockland",
          JSON.stringify({
            kind: "set",
            target: { objectTypeId: "Device", primaryId: "haverstraw" },
          })
        )
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test("recorded old checksums are rejected before schema mutation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-checksum-"))
    tempDirs.push(tempDir)
    const path = sqliteStoragePath(tempDir)

    const first = new SqliteStorage({ path: tempDir })
    await migrateStorage(first)
    closeStorage(first)

    const db = new Database(path)
    db.query(
      "UPDATE sixb_migrations SET checksum = 'old-checksum' WHERE adapter_id = ? AND version = 1"
    ).run(SQLITE_STORAGE_ADAPTER_ID)
    db.close()

    const reopened = new SqliteStorage({ path: tempDir })
    await expect(migrateStorage(reopened)).rejects.toThrow("checksum")
    closeStorage(reopened)

    expect(readTableNames(path)).toContain("ontology_outbox")
    expect(readMigrationRows(path)[0]?.checksum_length).toBe("old-checksum".length)
  })

  test("fresh schema installs the exact ontology table set and provenance columns", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)
      const ontologyTables = readMemoryTableNames(db).filter((name) => name.startsWith("ontology_"))
      expect(ontologyTables).toEqual([
        "ontology_commits",
        "ontology_link_overrides",
        "ontology_object_overrides",
        "ontology_outbox",
        "ontology_source_rows",
        "ontology_sources",
      ])
      expect(readMemoryTableColumns(db, "objects")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "links")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "timeseries")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "objects")).not.toContain("source_event_id")
      expect(readMemoryTableColumns(db, "links")).not.toContain("source_event_id")
      expect(readMemoryTableColumns(db, "timeseries")).not.toContain("source_event_id")
      expect(readMemoryTableNames(db)).not.toContain("applied_events_objects")
      expect(readMemoryColumn(db, "objects", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "links", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "timeseries", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryTableColumns(db, "projection_runs")).toEqual(
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
    } finally {
      db.close()
    }
  })

  test("backfills canonical workflow outputs by node index", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)
      db.run(`
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

      sqliteStorageMigrations.steps[1]?.up(db)

      const rows = db.query("SELECT id, output FROM workflow_runs ORDER BY id").all() as Array<{
        readonly id: string
        readonly output: string | null
      }>
      expect(
        rows.map((row) => ({ id: row.id, output: row.output && JSON.parse(row.output) }))
      ).toEqual([
        { id: "action-run", output: { seed: "kept" } },
        { id: "data-run", output: { winner: 10 } },
        { id: "failed-run", output: null },
      ])
    } finally {
      db.close()
    }
  })

  test("requires explicit project handling for legacy workflow runs", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps.slice(0, 4)) {
        migration.up(db)
      }
      db.query(`
        INSERT INTO workflow_runs (
          project_id, id, workflow_id, status, input, started_at
        ) VALUES (?, ?, ?, 'queued', '{}', ?)
      `).run("project-a", "legacy-run", "legacy-workflow", "2026-01-01T00:00:00.000Z")

      expect(() => sqliteStorageMigrations.steps[4]?.up(db)).toThrow()
      expect(readMemoryTableColumns(db, "workflow_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("makes the workflow execution link required and unique on an empty schema", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) {
        migration.up(db)
      }

      const columns = readMemoryTableColumns(db, "workflow_runs")
      expect(columns).toContain("execution_id")
      expect(columns).not.toContain("source")
      expect(columns).not.toContain("requested_by_principal_type")
      expect(columns).not.toContain("requested_by_principal_id")
      expect(readMemoryColumn(db, "workflow_runs", "execution_id")?.notnull).toBe(1)

      db.query(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, authority_kind, authority_primitive_kind,
          authority_primitive_id, created_at
        ) VALUES (?, ?, 'workflow', ?, 'schedule', ?, ?, 'trustedPrimitive', 'workflow', ?, ?)
      `).run(
        "project-a",
        "workflow-execution",
        "workflow-run",
        "schedule-event",
        "workflow-correlation",
        "reconcile-transaction",
        "2026-01-01T00:00:00.000Z"
      )
      db.query(`
        INSERT INTO workflow_runs (
          project_id, id, execution_id, workflow_id, status, input, started_at
        ) VALUES (?, ?, ?, ?, 'queued', '{}', ?)
      `).run(
        "project-a",
        "workflow-run",
        "workflow-execution",
        "reconcile-transaction",
        "2026-01-01T00:00:00.000Z"
      )

      expect(() =>
        db
          .query(`
          INSERT INTO workflow_runs (
            project_id, id, execution_id, workflow_id, status, input, started_at
          ) VALUES (?, ?, ?, ?, 'queued', '{}', ?)
        `)
          .run(
            "project-a",
            "second-workflow-run",
            "workflow-execution",
            "reconcile-transaction",
            "2026-01-01T00:00:00.000Z"
          )
      ).toThrow("UNIQUE constraint failed")
    } finally {
      db.close()
    }
  })

  test("rejects legacy Action runs instead of inventing their execution authority", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps.slice(0, 6)) migration.up(db)
      db.query(`
        INSERT INTO action_runs (
          project_id, id, action_id, subject_kind, status, phase, queued_at, params,
          idempotency_key
        ) VALUES (?, ?, ?, 'none', 'queued', 'request', ?, '{}', ?)
      `).run(
        "project-a",
        "legacy-action-run",
        "legacy-action",
        "2026-01-01T00:00:00.000Z",
        "action:project-a:legacy-action-run"
      )

      const actionExecutionsMigration = sqliteStorageMigrations.steps.find(
        (migration) => migration.id === "008-action-executions"
      )
      if (!actionExecutionsMigration) {
        throw new Error("SQLite action-executions migration is missing.")
      }
      expect(() => actionExecutionsMigration.up(db)).toThrow()
      expect(readMemoryTableColumns(db, "action_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("makes the Action execution link required and unique on an empty schema", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

      expect(readMemoryColumn(db, "action_runs", "execution_id")?.notnull).toBe(1)
      db.query(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, authority_kind, authority_primitive_kind,
          authority_primitive_id, created_at
        ) VALUES (?, ?, 'action', ?, 'event', ?, ?, 'trustedPrimitive', 'action', ?, ?)
      `).run(
        "project-a",
        "action-execution",
        "action-run",
        "action-event",
        "action-correlation",
        "send-quote",
        "2026-01-01T00:00:00.000Z"
      )
      db.query(`
        INSERT INTO action_runs (
          project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
          params, idempotency_key
        ) VALUES (?, ?, ?, ?, 'none', 'queued', 'request', ?, '{}', ?)
      `).run(
        "project-a",
        "action-run",
        "action-execution",
        "send-quote",
        "2026-01-01T00:00:00.000Z",
        "action:project-a:action-run"
      )

      expect(() =>
        db
          .query(`
            INSERT INTO action_runs (
              project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
              params, idempotency_key
            ) VALUES (?, ?, ?, ?, 'none', 'queued', 'request', ?, '{}', ?)
          `)
          .run(
            "project-a",
            "second-action-run",
            "action-execution",
            "send-quote",
            "2026-01-01T00:00:00.000Z",
            "action:project-a:second-action-run"
          )
      ).toThrow("UNIQUE")
    } finally {
      db.close()
    }
  })

  test("rejects legacy Agent runs instead of inventing their execution authority", () => {
    const db = new Database(":memory:")
    try {
      const agentExecutionsIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "009-agent-executions"
      )
      const agentExecutionsMigration = sqliteStorageMigrations.steps[agentExecutionsIndex]
      if (!agentExecutionsMigration) {
        throw new Error("SQLite agent-executions migration is missing.")
      }
      for (const migration of sqliteStorageMigrations.steps.slice(0, agentExecutionsIndex)) {
        migration.up(db)
      }
      db.query(`
        INSERT INTO agent_runs (
          project_id, id, thread_id, agent_id, trigger_message_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?)
      `).run(
        "project-a",
        "legacy-agent-run",
        "legacy-thread",
        "legacy-agent",
        "legacy-message",
        "2026-01-01T00:00:00.000Z"
      )

      expect(() => agentExecutionsMigration.up(db)).toThrow()
      expect(readMemoryTableColumns(db, "agent_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("makes Agent execution links required and unique on an empty schema", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

      expect(readMemoryColumn(db, "agent_runs", "execution_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "workflow_agent_node_runs", "execution_id")?.notnull).toBe(1)
      expect(readMemoryTableColumns(db, "agent_runs")).not.toContain("requested_by_principal_type")
      expect(readMemoryTableColumns(db, "agent_runs")).not.toContain("execution_principal_type")
      expect(readMemoryTableColumns(db, "workflow_agent_node_runs")).not.toContain(
        "execution_principal_type"
      )
      expect(readMemoryUniqueIndexes(db, "agent_runs")).toContainEqual([
        "project_id",
        "execution_id",
      ])
      expect(readMemoryUniqueIndexes(db, "workflow_agent_node_runs")).toContainEqual([
        "project_id",
        "execution_id",
      ])
    } finally {
      db.close()
    }
  })

  test("migrations install auth storage tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-auth-migrations-"))
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
    expect(tables).toContain("auth_service_accounts")
    expect(tables).toContain("auth_service_account_group_memberships")
    expect(tables).toContain("auth_sessions")
    expect(tables).toContain("auth_access_tokens")
    expect(tables).toContain("auth_invitations")
    expect(tables).toContain("auth_invitation_groups")
    expect(tables).toContain("auth_group_memberships")
    expect(tables).toContain("auth_magic_links")
    expect(tables).toContain("auth_oidc_authorization_attempts")
    expect(sessionColumns).toContain("audience")
    expect(sessionColumns).toContain("absolute_expires_at")
    expect(sessionColumns).toContain("user_agent")
    expect(sessionColumns).toContain("ip_address")
  })

  test("migrations install agent attribution and AI usage storage tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-agent-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    await storage.agents.threads.create({
      id: "thr_1",
      projectId: "project-a",
      agentId: "sales",
      ownerPrincipal: { type: "user", id: "usr_1" },
      createdAt: new Date("2026-06-23T10:00:00.000Z"),
    })
    await expect(
      storage.agents.threads.getById({ projectId: "project-a", id: "thr_1" })
    ).resolves.toMatchObject({ id: "thr_1", agentId: "sales", messageCount: 0 })

    closeStorage(storage)

    const path = sqliteStoragePath(tempDir)
    const tables = readTableNames(path)
    expect(tables).toContain("agent_threads")
    expect(tables).toContain("agent_runs")
    expect(tables).toContain("agent_messages")
    expect(tables).toContain("ai_model_call_usage")
    expect(tables).toContain("ai_model_call_usage_groups")
    expect(readTableColumns(path, "ai_model_call_usage")).toContain("execution_id")
    expect(readTableColumns(path, "ai_model_call_usage")).not.toContain("execution_kind")
    expect(readTableColumns(path, "ai_model_call_usage")).not.toContain("requester_principal_id")
    expect(readTableForeignKeys(path, "ai_model_call_usage")).toContainEqual({
      from: "execution_id",
      onDelete: "RESTRICT",
      table: "executions",
      to: "id",
    })
    expect(readTableColumns(path, "agent_runs")).toContain("requester_group_ids")
    expect(readTableColumns(path, "workflow_runs")).toContain("requester_group_ids")
    expect(readTableColumns(path, "agent_runs")).toContain("usage_input_tokens")
    expect(readTableColumns(path, "workflow_agent_node_runs")).toContain("usage")
  })

  test("untracked existing schema collides and rolls back without conversion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-legacy-"))
    tempDirs.push(tempDir)

    const path = sqliteStoragePath(tempDir)
    const legacy = new Database(path)
    legacy.run("CREATE TABLE objects (legacy_marker TEXT NOT NULL)")
    legacy.run("INSERT INTO objects (legacy_marker) VALUES ('preserve-me')")
    legacy.close()

    const storage = new SqliteStorage({ path: tempDir })
    await expect(migrateStorage(storage)).rejects.toThrow("table objects already exists")
    closeStorage(storage)

    const unchanged = new Database(path, { readonly: true })
    expect(unchanged.query("SELECT legacy_marker FROM objects").get()).toEqual({
      legacy_marker: "preserve-me",
    })
    expect(readTableNames(path)).not.toContain("ontology_commits")
    expect(readMigrationRows(path)).toEqual([])
    unchanged.close()
  })

  test("dirty SQLite migration history blocks storage migrations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-dirty-"))
    tempDirs.push(tempDir)

    writeStartedMigration(sqliteStoragePath(tempDir))

    const storage = new SqliteStorage({ path: tempDir })

    await expect(migrateStorage(storage)).rejects.toThrow("started and never finished")

    closeStorage(storage)
  })

  test("narrows the source-root index without changing its lookup prefix", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)
      expect(readMemoryIndexColumns(db, "idx_ontology_source_rows_root")).toEqual([
        "project_id",
        "source_id",
        "materialization_id",
        "root_sort_key",
        "staging_ordinal",
        "entity_sort_key",
      ])

      sqliteStorageMigrations.steps[5]?.up(db)
      expect(readMemoryIndexColumns(db, "idx_ontology_source_rows_root")).toEqual([
        "project_id",
        "source_id",
        "materialization_id",
        "root_sort_key",
      ])
    } finally {
      db.close()
    }
  })

  test("the timeseries primary key enforces the (series, at) natural key", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)

      const insert = db.query(`
        INSERT INTO timeseries (
          project_id, object_type_id, object_id, property_id,
          value, unit, at, last_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insert.run("p", "Room", "r1", "temp", "70.5", null, "2026-06-01T12:00:00.000Z", "commit-1")

      // A second row at the same (series, at) is rejected by the natural-key
      // PRIMARY KEY, even with a different commit — appends must upsert.
      expect(() =>
        insert.run("p", "Room", "r1", "temp", "71", null, "2026-06-01T12:00:00.000Z", "commit-2")
      ).toThrow()
    } finally {
      db.close()
    }
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
        FROM sixb_migrations
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

function readTableForeignKeys(
  path: string,
  tableName: string
): readonly {
  readonly from: string
  readonly onDelete: string
  readonly table: string
  readonly to: string
}[] {
  const db = new Database(path, { readonly: true })

  try {
    const rows = db.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
      readonly from: string
      readonly on_delete: string
      readonly table: string
      readonly to: string
    }>
    return rows.map(({ from, on_delete, table, to }) => ({
      from,
      onDelete: on_delete,
      table,
      to,
    }))
  } finally {
    db.close()
  }
}

function readMemoryTableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      readonly name: string
    }[]
  ).map((row) => row.name)
}

function readMemoryTableColumns(db: Database, tableName: string): string[] {
  return (db.query(`PRAGMA table_info(${tableName})`).all() as { readonly name: string }[]).map(
    (row) => row.name
  )
}

function readMemoryIndexColumns(db: Database, indexName: string): string[] {
  return (db.query(`PRAGMA index_info(${indexName})`).all() as { readonly name: string }[]).map(
    (row) => row.name
  )
}

function readMemoryUniqueIndexes(db: Database, tableName: string): string[][] {
  const indexes = db.query(`PRAGMA index_list(${tableName})`).all() as Array<{
    readonly name: string
    readonly unique: number
  }>
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => readMemoryIndexColumns(db, index.name))
}

function readMemoryColumn(
  db: Database,
  tableName: string,
  columnName: string
): { readonly name: string; readonly notnull: number } | undefined {
  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    readonly name: string
    readonly notnull: number
  }>
  return columns.find((column) => column.name === columnName)
}

function writeStartedMigration(path: string): void {
  const db = new Database(path)

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS sixb_migrations (
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
      INSERT INTO sixb_migrations (
        adapter_id, version, id, checksum, status, started_at, finished_at
      ) VALUES (?, 1, '001-initial-schema', NULL, 'started', ?, NULL)
    `).run(SQLITE_STORAGE_ADAPTER_ID, "2026-04-19T00:00:00.000Z")
  } finally {
    db.close()
  }
}

function closeStorage(storage: SqliteStorage): void {
  storage.close()
}

function insertLegacyLinkOverride(
  db: Database,
  input: {
    readonly sourceId: string
    readonly linkId: string
    readonly targetId: string
    readonly value: unknown
    readonly updatedAt: string
  }
): void {
  const entityKey = JSON.stringify([
    "Device",
    input.sourceId,
    input.linkId,
    "Device",
    input.targetId,
  ])
  db.query(
    `INSERT INTO ontology_overrides (
       project_id, entity_kind, entity_key, entity_sort_key,
       source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
       value, last_commit_id, updated_at
     ) VALUES ('project', 'link', json(?), ?, 'Device', ?, ?, 'Device', ?, json(?), ?, ?)`
  ).run(
    entityKey,
    entityKey,
    input.sourceId,
    input.linkId,
    input.targetId,
    JSON.stringify(input.value),
    `commit:${input.sourceId}:${input.targetId}`,
    input.updatedAt
  )
}

describe("SQLite migration status is read-only", () => {
  // The teeth of C1.6. `plan()` cannot be used as a probe on SQLite: withSqliteDatabase
  // mkdirs the parent and `new Database(path)` creates the file, so asking "is the schema
  // current?" used to answer by bringing a database into existence. An unauthenticated
  // GET /ready reached this path.
  test("reports an absent database without creating one", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-status-absent-"))
    tempDirs.push(tempDir)
    const nested = join(tempDir, "does", "not", "exist")
    const path = sqliteStoragePath(nested)

    const [migrator] = createSqliteStorageMigrators(nested)
    const status = await migrator?.status()

    expect(status).toMatchObject({ state: "uninitialized", appliedVersion: 0 })
    expect(status?.reason).toBeTruthy()
    // Nothing was brought into existence: not the file, not its parent directories.
    expect(existsSync(path)).toBe(false)
    expect(existsSync(nested)).toBe(false)
  })

  test("reports current after a migration, and touches nothing doing it", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-status-current-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)
    closeStorage(storage)

    const path = sqliteStoragePath(tempDir)
    const before = statSync(path).mtimeMs

    const [migrator] = createSqliteStorageMigrators(tempDir)
    const expectedVersion = sqliteStorageMigrations.latestVersion
    expect(await migrator?.status()).toMatchObject({
      adapterId: SQLITE_STORAGE_ADAPTER_ID,
      state: "current",
      latestVersion: expectedVersion,
      appliedVersion: expectedVersion,
    })

    expect(statSync(path).mtimeMs).toBe(before)
  })

  test("reports pending when history exists but a migration is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-status-pending-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)
    closeStorage(storage)

    const path = sqliteStoragePath(tempDir)
    const db = new Database(path)
    db.query("DELETE FROM sixb_migrations WHERE adapter_id = ?").run(SQLITE_STORAGE_ADAPTER_ID)
    db.close()

    const [migrator] = createSqliteStorageMigrators(tempDir)
    expect(await migrator?.status()).toMatchObject({ state: "uninitialized" })
  })
})
