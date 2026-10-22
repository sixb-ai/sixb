import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryStorage, migrateStorage } from "@sixb/core"
import { parseActionRunFailure } from "@sixb/core/internal/action-run-storage"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  materializationEvent,
  type OntologyMaterializationEventAttribution,
  type OntologyMaterializationEventCommit,
  type OntologyMaterializationEventDraft,
} from "@sixb/core/internal/materialization"
import { canonicalJson } from "@sixb/core/internal/ontology-storage-provider"
import {
  AGENT_RUN_FAILURE_CODES,
  ONTOLOGY_OUTBOX_FAILURE_CODES,
  PIPELINE_RUN_FAILURE_CODES,
  PROJECTION_RUN_FAILURE_CODES,
  SYNC_RUN_FAILURE_CODES,
  WEBHOOK_RUN_FAILURE_CODES,
  WORKFLOW_RUN_FAILURE_CODES,
} from "@sixb/core/storage"
import { legacySourceFixture } from "../../tests/legacy-source-fixture"
import { SqliteStorage } from "../src"
import { SqliteActionRunStorage } from "../src/action-run-storage"
import {
  createSqliteStorageMigrators,
  migrateSqliteStorage,
  SQLITE_STORAGE_ADAPTER_ID,
  sqliteStorageMigrations,
  sqliteStoragePath,
} from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import { SqliteOntologyOutboxStorage } from "../src/ontology-storage/outbox"

const tempDirs: string[] = []

test("adds sandbox state after the shipped params migration without changing existing bindings", () => {
  // Regression proof: fold sandbox_state into 041 or remove 045; this upgrade cannot complete.
  const db = new Database(":memory:")
  try {
    db.exec("CREATE TABLE agent_threads (id TEXT PRIMARY KEY)")
    migration("041-agent-thread-workspaces").up(db)
    db.query("INSERT INTO agent_threads (id, sandbox_params) VALUES (?, ?)").run(
      "thread",
      JSON.stringify({ clientId: "acme" })
    )
    expect(
      db
        .query("PRAGMA table_info(agent_threads)")
        .all()
        .map((row) => (row as { name: string }).name)
    ).not.toContain("sandbox_state")
    migration("045-agent-thread-sandbox-state").up(db)
    expect(db.query("SELECT sandbox_params, sandbox_state FROM agent_threads").get()).toEqual({
      sandbox_params: '{"clientId":"acme"}',
      sandbox_state: null,
    })
  } finally {
    db.close()
  }
})
test("rewrites legacy intervention actors to the canonical principal shape", () => {
  // Regression proof: remove 046; the legacy { principalType, principalId } values survive.
  const db = replayedDatabase("046-workflow-intervention-principals")
  try {
    const insert = db.query(`
      INSERT INTO workflow_interventions (
        project_id, id, workflow_id, workflow_run_id, node_run_id, node_index, node_id,
        node_key, intervention_id, input, default_response, status, requested_at,
        submitted_by, cancelled_by
      ) VALUES ('project-a', ?, 'wf', 'run', 'node-run', 0, 'node', 'node', 'review', '{}', '{}',
        ?, '2026-01-01T00:00:00.000Z', ?, ?)
    `)
    insert.run(
      "submitted",
      "submitted",
      JSON.stringify({ principalType: "user", principalId: "usr_1" }),
      null
    )
    insert.run(
      "cancelled",
      "cancelled",
      null,
      JSON.stringify({ principalType: "system", principalId: "workflow-timeout" })
    )
    insert.run("current", "submitted", JSON.stringify({ type: "serviceAccount", id: "sa_1" }), null)
    insert.run("pending", "pending", null, null)

    migration("046-workflow-intervention-principals").up(db)

    const rows = db
      .query("SELECT id, submitted_by, cancelled_by FROM workflow_interventions ORDER BY id")
      .all() as Array<{ id: string; submitted_by: string | null; cancelled_by: string | null }>
    expect(
      rows.map((row) => ({
        id: row.id,
        submittedBy: row.submitted_by && JSON.parse(row.submitted_by),
        cancelledBy: row.cancelled_by && JSON.parse(row.cancelled_by),
      }))
    ).toEqual([
      {
        id: "cancelled",
        submittedBy: null,
        cancelledBy: { type: "system", id: "workflow-timeout" },
      },
      { id: "current", submittedBy: { type: "serviceAccount", id: "sa_1" }, cancelledBy: null },
      { id: "pending", submittedBy: null, cancelledBy: null },
      { id: "submitted", submittedBy: { type: "user", id: "usr_1" }, cancelledBy: null },
    ])
  } finally {
    db.close()
  }
})

const LEGACY_WEBHOOK_DELIVERY_FAILURE_CODES = ["webhook.delivery_failed"] as const
/** Every shipped migration, in order. A database records these ids, so they never change. */
const shippedMigrationIds = [
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
  "019-webhook-delivery-failure-record",
  "020-drop-run-usage-projections",
  "021-sync-pipeline-executions",
  "022-projection-executions",
  "023-webhook-executions",
  "024-ontology-commit-executions",
  "025-connector-connections",
  "026-ai-cost-accounting",
  "027-agent-context-checkpoints",
  "028-object-override-edit-times",
  "029-model-accounting",
  "030-ai-usage-limits",
  "031-subagent-runs",
  "032-conversation-run-spec",
  "033-retire-agent-definitions",
  "034-device-authorizations",
  "035-share-grants",
  "036-share-sessions",
  "037-execution-requester-groups",
  "038-projection-source-roots",
  "039-connector-optional-pkce",
  "040-outbox-publication-order",
  "041-agent-thread-workspaces",
  "042-vector-profiles",
  "043-vector-indexing",
  "044-vector-batching",
  "045-agent-thread-sandbox-state",
  "046-workflow-intervention-principals",
  "047-ontology-commit-attribution",
  "048-file-upload-sessions",
  "049-native-sessions",
  "050-directory-group-memberships",
  "051-projection-run-supersession",
  "052-compact-source-storage",
  "053-replacement-plans",
  "054-slim-ontology-outbox",
  "055-commit-touches",
  "056-audio-transcription",
  "057-reranking-model-kind",
  "058-file-download-grants",
  "059-drained-source-versions",
  "060-terminal-action-runs",
  "061-drop-auth-audience",
  "062-artifacts",
  "063-drop-output-diagnostics",
  "064-activity",
  "065-activity-timeline",
  "066-activity-interactions",
  "067-artifact-kinds",
  "068-artifact-state",
  "069-agent-thread-participants",
  "070-forked-context-checkpoints",
  "071-artifact-threads",
]

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()

    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

function migration(id: string) {
  const step = sqliteStorageMigrations.steps.find((candidate) => candidate.id === id)
  if (!step) throw new Error(`Unknown migration '${id}'.`)
  return step
}

const replayedPrefixes = new Map<number, Uint8Array>()

/**
 * A new in-memory database holding every migration before `id`, or all of them, as replaying them
 * leaves it. A full replay costs a few hundred milliseconds, so each replay saves a copy every
 * eight steps and where it stops, and the next one starts from the nearest saved copy. Every
 * caller gets its own database.
 */
function replayedDatabase(id?: string): Database {
  const steps = sqliteStorageMigrations.steps
  const end = id === undefined ? steps.length : steps.indexOf(migration(id))
  const start = Math.max(0, ...[...replayedPrefixes.keys()].filter((index) => index <= end))
  const cached = replayedPrefixes.get(start)
  const db = cached ? Database.deserialize(cached) : new Database(":memory:")
  for (let index = start; index < end; index++) {
    steps[index]!.up(db)
    if ((index + 1) % 8 === 0 || index + 1 === end) replayedPrefixes.set(index + 1, db.serialize())
  }
  return db
}

let migratedTemplate: Promise<Uint8Array> | undefined

/** A new storage directory holding a copy of one database the migration runner brought up to date. */
async function migratedDirectory(): Promise<string> {
  migratedTemplate ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrated-"))
    tempDirs.push(directory)
    // The runner alone leaves the file in rollback-journal mode, so the copy needs no WAL files.
    await migrateSqliteStorage(directory)
    const db = new Database(sqliteStoragePath(directory), { readonly: true })
    try {
      return db.serialize()
    } finally {
      db.close()
    }
  })()
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrated-"))
  tempDirs.push(directory)
  await writeFile(sqliteStoragePath(directory), await migratedTemplate)
  return directory
}

describe("SQLite storage migrations", () => {
  test("moves historical snapshots to executions and preserves empty child snapshots", async () => {
    // Removal proof: omit 037's recursive backfill; the snapshots below become empty.
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE executions (project_id TEXT, id TEXT, parent_execution_id TEXT);
        CREATE TABLE workflow_runs (project_id TEXT, execution_id TEXT, requester_group_ids TEXT);
        CREATE TABLE agent_runs (project_id TEXT, execution_id TEXT, requester_group_ids TEXT);
        INSERT INTO executions VALUES ('p', 'root', NULL), ('p', 'workflow', 'root'),
          ('p', 'task', 'workflow'), ('p', 'agent', 'root'), ('p', 'child', 'agent'),
          ('p', 'empty', 'agent'), ('other', 'workflow', NULL);
        INSERT INTO workflow_runs VALUES ('p', 'workflow', '["finance"]');
        INSERT INTO agent_runs VALUES ('p', 'agent', '["support"]'), ('p', 'empty', '[]');
      `)
      await migration("037-execution-requester-groups").up(db)
      expect(
        db
          .query(
            "SELECT project_id, id, requester_group_ids FROM executions ORDER BY project_id, id"
          )
          .all()
      ).toEqual([
        { project_id: "other", id: "workflow", requester_group_ids: "[]" },
        { project_id: "p", id: "agent", requester_group_ids: '["support"]' },
        { project_id: "p", id: "child", requester_group_ids: '["support"]' },
        { project_id: "p", id: "empty", requester_group_ids: "[]" },
        { project_id: "p", id: "root", requester_group_ids: "[]" },
        { project_id: "p", id: "task", requester_group_ids: '["finance"]' },
        { project_id: "p", id: "workflow", requester_group_ids: '["finance"]' },
      ])
    } finally {
      db.close()
    }
  })

  test("keeps recorded model kinds and admits reranking", async () => {
    // Removal proof: omit 057's UPDATE; the transcription kind below is lost in the swap.
    const db = replayedDatabase("057-reranking-model-kind")
    try {
      const insertUsage = (id: string, modelKind: string | null) =>
        db.run(
          `INSERT INTO ai_model_call_usage (
            project_id, id, execution_id, attempt, call_id, provider_id, requested_model_id,
            response_id, reporting_status, occurred_at, recorded_at, model_kind
          ) VALUES ('p', ?, 'execution', 1, ?, 'provider', 'model', ?, 'unavailable',
            '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z', ?)`,
          [id, id, id, modelKind]
        )
      insertUsage("transcription", "transcription")
      insertUsage("unclassified", null)
      expect(() => insertUsage("early-reranking", "reranking")).toThrow()

      await migration("057-reranking-model-kind").up(db)
      insertUsage("reranking", "reranking")
      expect(() => insertUsage("unknown", "unknown")).toThrow()
      expect(db.query("SELECT id, model_kind FROM ai_model_call_usage ORDER BY id").all()).toEqual([
        { id: "reranking", model_kind: "reranking" },
        { id: "transcription", model_kind: "transcription" },
        { id: "unclassified", model_kind: null },
      ])
    } finally {
      db.close()
    }
  })

  test("counts the roots each superseded version still holds", async () => {
    // Removal proof: omit 059's UPDATE; the drained version below keeps its staged count.
    const db = replayedDatabase("059-drained-source-versions")
    try {
      db.exec(`
        INSERT INTO ontology_sources (version_id, project_id, source_id, materialization_id,
          projection_run_id, projection_kind, protocol, status, execution_token, dataset_id,
          dataset_version_id, dataset_version_created_at, projection_revision, ownership_hash,
          ontology_revision, root_count, assertion_count, created_at, ready_at, activated_at,
          terminal_at, last_commit_id, updated_at)
        SELECT version, 'p', 's', 'm' || version, 'r' || version, 'object', 'replacement', status,
          NULL, 'd', 'v', '2026-01-01', 'r', 'h', 'o', 2, 2, '2026-01-01', '2026-01-01',
          '2026-01-01', terminal_at, 'c', '2026-01-02'
        FROM (SELECT 1 AS version, 'superseded' AS status, '2026-01-02' AS terminal_at
          UNION ALL SELECT 2, 'superseded', '2026-01-02' UNION ALL SELECT 3, 'active', NULL);
        INSERT INTO ontology_source_roots (version_id, project_id, root_key, staging_ordinal)
        VALUES (2, 'p', 'b', 1), (3, 'p', 'a', 0), (3, 'p', 'b', 1);
      `)

      await migration("059-drained-source-versions").up(db)
      expect(db.query("SELECT version_id, status, root_count FROM ontology_sources").all()).toEqual(
        [
          { version_id: 1, status: "superseded", root_count: 0 },
          { version_id: 2, status: "superseded", root_count: 1 },
          { version_id: 3, status: "active", root_count: 2 },
        ]
      )
    } finally {
      db.close()
    }
  })

  // Red proof: remove the INSERT ... SELECT backfill from migration 038.
  test("source-root upgrade preserves active, terminal and unfinished snapshots", () => {
    const db = replayedDatabase("038-projection-source-roots")
    try {
      db.exec("PRAGMA foreign_keys = ON")
      db.exec(legacySourceFixture())
      migration("038-projection-source-roots").up(db)
      expect(
        db
          .query(`SELECT materialization_id, active, retired_at IS NOT NULL AS retired
        FROM ontology_source_roots ORDER BY materialization_id`)
          .all()
      ).toEqual([
        { materialization_id: "abandoned", active: 0, retired: 1 },
        { materialization_id: "active", active: 1, retired: 0 },
        { materialization_id: "ready", active: 0, retired: 0 },
        { materialization_id: "staging", active: 0, retired: 0 },
        { materialization_id: "superseded", active: 0, retired: 1 },
      ])
      expect(
        db
          .query(`SELECT count(*) AS count FROM ontology_source_rows AS rows
        JOIN ontology_source_roots AS roots USING (project_id,source_id,materialization_id,root_sort_key)
        WHERE roots.active = 1`)
          .get()
      ).toEqual({ count: 2 })
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(() =>
        db.exec(
          "UPDATE ontology_source_roots SET active=1,retired_at=NULL WHERE materialization_id='superseded'"
        )
      ).toThrow("UNIQUE")
      expect(() => db.exec("UPDATE ontology_sources SET base_commit_id='partial'")).toThrow("CHECK")
    } finally {
      db.close()
    }
  })

  describe("052 compact source storage", () => {
    /** The legacy snapshots, upgraded through every migration before 052. */
    function databaseAt051(): Database {
      const db = replayedDatabase("038-projection-source-roots")
      db.exec(legacySourceFixture())
      const steps = sqliteStorageMigrations.steps
      const from = steps.indexOf(migration("038-projection-source-roots"))
      const to = steps.indexOf(migration("052-compact-source-storage"))
      for (const step of steps.slice(from, to)) step.up(db)
      return db
    }

    /** Every migration from 052 on, in one transaction, as the runner commits or rolls back 052. */
    function migrateFrom052(db: Database): void {
      const steps = sqliteStorageMigrations.steps
      const from = steps.indexOf(migration("052-compact-source-storage"))
      db.transaction(() => {
        for (const step of steps.slice(from)) step.up(db)
      })()
    }

    // Red proofs: drop the CASE fallback to `versions.updated_at` in migration 052 and the superseded
    // root becomes live again; drop the payload rewrite and the stored assertion keeps its ref copy.
    test("keeps every version, root, row and live root", () => {
      const db = databaseAt051()
      try {
        // A published root neither active nor retired must not come back to life.
        db.exec(`UPDATE ontology_source_roots SET retired_at = NULL
          WHERE materialization_id = 'superseded'`)
        migrateFrom052(db)

        const key = '["object","Device","a"]'
        expect(
          db
            .query(`SELECT versions.materialization_id, roots.root_key,
              roots.retired_at IS NOT NULL AS retired,
              roots.retired_at IS NULL AND roots.deleted = 0
                AND versions.status IN ('active', 'superseded') AS live
            FROM ontology_source_roots AS roots
            JOIN ontology_sources AS versions USING (version_id)
            ORDER BY versions.materialization_id`)
            .all()
        ).toEqual([
          { materialization_id: "abandoned", root_key: key, retired: 1, live: 0 },
          { materialization_id: "active", root_key: key, retired: 0, live: 1 },
          { materialization_id: "ready", root_key: key, retired: 0, live: 0 },
          { materialization_id: "staging", root_key: key, retired: 0, live: 0 },
          { materialization_id: "superseded", root_key: key, retired: 1, live: 0 },
        ])
        expect(db.query("SELECT count(*) AS count FROM ontology_sources").get()).toEqual({
          count: 5,
        })
        expect(db.query("SELECT count(*) AS count FROM ontology_source_rows").get()).toEqual({
          count: 10,
        })
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])

        const [state] = new SqliteMaterializationStateReader(db, "p").objectStates([
          { objectTypeId: "Device", primaryId: "a" },
        ])
        expect(state?.source).toEqual({
          source: { projectionId: "source" },
          materializationId: "active",
          root: { kind: "object", ref: { objectTypeId: "Device", primaryId: "a" } },
          assertion: {
            kind: "object",
            ref: { objectTypeId: "Device", primaryId: "a" },
            properties: { id: "a", name: "active" },
          },
          stagingOrdinal: 0,
        })
        expect(
          db
            .query("SELECT DISTINCT payload FROM ontology_source_rows WHERE entity_kind = 'link'")
            .all()
        ).toEqual([{ payload: null }])
        expect(() =>
          db.exec(`INSERT INTO ontology_source_roots (version_id, project_id, root_key, staging_ordinal)
            SELECT version_id, 'p', '${key}', 1 FROM ontology_sources
            WHERE materialization_id = 'active'`)
        ).toThrow("UNIQUE")
      } finally {
        db.close()
      }
    })

    // Red proof: drop the count check around migration 052 and it commits without the orphan row.
    test("fails rather than drop a row without a root", () => {
      const db = databaseAt051()
      try {
        db.exec(`DELETE FROM ontology_source_roots WHERE materialization_id = 'staging'`)

        expect(() => migrateFrom052(db)).toThrow(
          "Source versions, roots or rows were lost while compacting source storage."
        )
        expect(
          db
            .query("SELECT count(*) AS count FROM ontology_source_rows WHERE root_sort_key <> ''")
            .get()
        ).toEqual({ count: 10 })
      } finally {
        db.close()
      }
    })
  })

  test("keeps projection runs and admits superseded runs and retrying failures", async () => {
    // Removal proof: keep `AND error IS NULL` on 051's running branch; the running run's error
    // below is then rejected.
    const db = replayedDatabase("051-projection-run-supersession")
    try {
      const failure = JSON.stringify({
        code: "projection.execution_failed",
        message: "Projection execution failed.",
        retryable: false,
        at: "2026-09-01T12:00:00.000Z",
      })
      const insertRun = (id: string, status: string, versionId: string, error: string | null) => {
        db.run(
          `INSERT INTO executions (
            project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
            authority_kind, authority_primitive_kind, authority_primitive_id, created_at
          ) VALUES ('p', ?, 'projection', 'rooms', 'datasetVersion', ?, ?, 'trustedPrimitive',
            'projection', 'rooms', '2026-09-01T12:00:00.000Z')`,
          [`execution-${id}`, versionId, `execution-${id}`]
        )
        db.run(
          `INSERT INTO projection_runs (
            project_id, id, execution_id, projection_id, projection_kind,
            materialization_protocol, dataset_id, dataset_version_id, dataset_version_created_at,
            ontology_revision, projection_revision, ownership_hash, object_type_id, status,
            queued_at, started_at, finished_at, attempt, execution_token, error
          ) VALUES ('p', ?, ?, 'rooms', 'object', 'replacement', 'rooms', ?,
            '2026-09-01T12:00:00.000Z', 'ontology', 'projection', 'ownership', 'Room', ?,
            '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z', ?, 1, ?, ?)`,
          [
            id,
            `execution-${id}`,
            versionId,
            status,
            status === "running" ? null : "2026-09-01T12:01:00.000Z",
            status === "running" ? "token" : null,
            error,
          ]
        )
      }
      insertRun("failed-run", "failed", "version-1", failure)
      insertRun("running-run", "running", "version-2", null)

      await migration("051-projection-run-supersession").up(db)
      insertRun("superseded-run", "superseded", "version-3", null)
      db.run("UPDATE projection_runs SET error = ? WHERE id = 'running-run'", [failure])

      expect(db.query("SELECT id, status, error FROM projection_runs ORDER BY id").all()).toEqual([
        { id: "failed-run", status: "failed", error: failure },
        { id: "running-run", status: "running", error: failure },
        { id: "superseded-run", status: "superseded", error: null },
      ])
      expect(() => insertRun("superseded-with-error", "superseded", "version-4", failure)).toThrow(
        "CHECK constraint failed"
      )
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projection_runs' AND name LIKE 'idx_%'"
          )
          .get()
      ).toEqual({ count: 6 })
    } finally {
      db.close()
    }
  })

  // Removal proof: drop the INSERT from 067 and the artifact, its version, and its grant are gone;
  // drop the RENAME and nothing references `artifacts` any more.
  test("rebuilds artifacts for the page and canvas kinds, keeping their versions and grants", async () => {
    const db = new Database(":memory:")
    try {
      const steps = sqliteStorageMigrations.steps
      const index = steps.findIndex((step) => step.id === "067-artifact-kinds")
      for (const step of steps.slice(0, index)) await step.up(db)
      const at = "2026-01-01T00:00:00.000Z"
      db.run(
        `INSERT INTO artifacts VALUES ('p', 'art_deck000001', 'slides', 'Deck', 'user', 'u', 1, 2, ?, ?)`,
        [at, at]
      )
      db.run(
        `INSERT INTO artifact_versions (
          project_id, artifact_id, version, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, created_at
        ) VALUES ('p', 'art_deck000001', 1, 'Deck', 'index.html', '[]', '{"kind":"slides"}', '[]',
          'user', 'u', ?)`,
        [at]
      )
      db.run(`INSERT INTO artifact_frame_grants VALUES ('p', ?, 'art_deck000001', 1, '[]', ?, ?)`, [
        "a".repeat(64),
        at,
        "2026-01-01T01:00:00.000Z",
      ])
      for (const step of steps.slice(index, index + 1)) await step.up(db)

      expect(db.query("SELECT id, kind, next_version FROM artifacts").all()).toEqual([
        { id: "art_deck000001", kind: "slides", next_version: 2 },
      ])
      for (const kind of ["page", "canvas"]) {
        db.run(`INSERT INTO artifacts VALUES ('p', ?, ?, 'New', 'user', 'u', 1, 2, ?, ?)`, [
          `art_${kind}`,
          kind,
          at,
          at,
        ])
      }
      expect(() =>
        db.run(
          `INSERT INTO artifacts VALUES ('p', 'art_x', 'video', 'X', 'user', 'u', 1, 2, ?, ?)`,
          [at, at]
        )
      ).toThrow()
      // The versions and grants still belong to the rebuilt table: deleting the deck takes them.
      db.run("PRAGMA foreign_keys = ON")
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      db.run("DELETE FROM artifacts WHERE id = 'art_deck000001'")
      expect(db.query("SELECT COUNT(*) AS n FROM artifact_versions").get()).toEqual({ n: 0 })
      expect(db.query("SELECT COUNT(*) AS n FROM artifact_frame_grants").get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  // Removal proofs: drop the `json_set` on `$.details.phase` from 060, and the enqueue failure below
  // keeps phase 'enqueue', which `parseActionRunFailure` rejects. Drop the join on
  // `ontology_commits`, and the runs whose edits committed are recorded as failed.
  test("keeps every Action run readable as a terminal record", async () => {
    const db = replayedDatabase("060-terminal-action-runs")
    try {
      const failure = (code: string, retryable: boolean, phase: string) =>
        JSON.stringify({
          code,
          message: "Stored failure.",
          retryable,
          at: "2026-01-01T00:00:02.000Z",
          details: { actionId: "send-quote", runId: "ignored", phase },
        })
      const insertRun = (
        id: string,
        status: string,
        phase: string | null,
        startedAt: string | null,
        finishedAt: string | null,
        error: string | null
      ) => {
        db.run(
          `INSERT INTO action_runs (
            project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
            started_at, finished_at, params, idempotency_key, error
          ) VALUES ('p', ?, ?, 'send-quote', 'none', ?, ?, '2026-01-01T00:00:00.000Z', ?, ?,
            '{"amount":1}', ?, ?)`,
          [id, `execution-${id}`, status, phase, startedAt, finishedAt, `action:p:${id}`, error]
        )
      }
      const started = "2026-01-01T00:00:01.000Z"
      const finished = "2026-01-01T00:00:02.000Z"
      insertRun("queued", "queued", "request", null, null, null)
      insertRun("running", "running", "edits", started, null, null)
      insertRun(
        "cancelled",
        "cancelled",
        "cancelled",
        started,
        finished,
        failure("runtime.cancelled", false, "cancelled")
      )
      insertRun(
        "enqueue-failed",
        "failed",
        "enqueue",
        null,
        finished,
        failure("queue.enqueue_failed", true, "enqueue")
      )
      insertRun("unexplained", "failed", "commit", started, finished, null)
      insertRun("succeeded", "succeeded", "commit", started, finished, null)
      // Runs a crash left running after their edits committed.
      const committedAt = "2026-01-01T00:00:03.000Z"
      const insertCommit = (runId: string) =>
        db.run(
          `INSERT INTO ontology_commits (
            project_id, id, idempotency_key, request_hash, execution_id, origin_kind,
            origin_run_id, origin, ontology_revision, intent, result, committed_at
          ) VALUES ('p', ?, ?, 'hash', ?, 'action', ?, '{}', 'revision', '{}', '{}', ?)`,
          [`commit-${runId}`, `action:${runId}:edits`, `execution-${runId}`, runId, committedAt]
        )
      for (const [id, phase] of [
        ["committed", "commit"],
        ["committed-in-effects", "effects"],
      ] as const) {
        insertRun(id, "running", phase, started, null, null)
        insertCommit(id)
      }

      await migration("060-terminal-action-runs").up(db)
      // Read back through the provider: its read path never consults executions.
      const actionRuns = new SqliteActionRunStorage({
        connection: { db, ownsConnection: false },
        executions: new InMemoryStorage().executions,
      })
      const runs = new Map(
        (await actionRuns.list({ projectId: "p", limit: 10 })).runs.map((run) => [run.id, run])
      )

      expect(runs.get("queued")).toMatchObject({
        status: "failed",
        phase: "validation",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        error: {
          code: "internal.unexpected",
          message: "Abandoned: Actions now run synchronously; this run never finished.",
          details: { actionId: "send-quote", runId: "queued", phase: "validation" },
        },
      })
      expect(runs.get("running")).toMatchObject({
        status: "failed",
        phase: "edits",
        startedAt: new Date(started),
        error: { code: "internal.unexpected", details: { phase: "edits" } },
      })
      expect(runs.get("running")?.finishedAt.getTime()).toBeGreaterThan(Date.parse(started))
      expect(runs.get("cancelled")).toMatchObject({
        status: "failed",
        phase: "validation",
        finishedAt: new Date(finished),
        error: { code: "runtime.cancelled", details: { phase: "validation" } },
      })
      expect(runs.get("enqueue-failed")).toMatchObject({
        status: "failed",
        phase: "validation",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        error: { code: "internal.unexpected", retryable: false, message: "Stored failure." },
      })
      expect(runs.get("unexplained")).toMatchObject({
        status: "failed",
        phase: "commit",
        error: {
          code: "internal.unexpected",
          message: "This run failed before Sixb recorded why.",
          at: finished,
          details: { phase: "commit" },
        },
      })
      expect(runs.get("succeeded")).toMatchObject({ status: "succeeded", phase: "commit" })
      expect(runs.get("committed")).toMatchObject({
        status: "succeeded",
        phase: "commit",
        finishedAt: new Date(committedAt),
      })
      expect(runs.get("committed")?.error).toBeUndefined()
      expect(runs.get("committed")?.effects).toBeUndefined()
      expect(runs.get("committed-in-effects")).toMatchObject({
        status: "succeeded",
        phase: "effects",
        finishedAt: new Date(committedAt),
        effects: {
          status: "failed",
          error: {
            code: "internal.unexpected",
            message: "Abandoned: Actions now run synchronously; these effects never finished.",
            details: { actionId: "send-quote", runId: "committed-in-effects", phase: "effects" },
          },
        },
      })
      expect(readMemoryTableColumns(db, "action_runs")).not.toContain("queued_at")
      expect(() => insertRun("late-queued", "queued", "request", started, finished, null)).toThrow()
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND tbl_name = 'action_runs' AND name LIKE 'idx_%'"
          )
          .get()
      ).toEqual({ count: 4 })
    } finally {
      db.close()
    }
  })

  // Removal proof: drop the UPDATE from 061 and the Atlas browser session stays active, listed
  // among the person's sessions though no cookie can reach it.
  test("ends Atlas's browser sessions and keeps the app's and native ones", async () => {
    const db = replayedDatabase("061-drop-auth-audience")
    try {
      const insertSession = (id: string, audience: string, refreshTokenHash: string | null) =>
        db.run(
          `INSERT INTO auth_sessions (
            project_id, id, user_id, strategy_id, audience, token_hash, created_at, expires_at,
            refresh_token_hash
          ) VALUES ('p', ?, 'usr_1', 'magic-link', ?, ?, '2026-01-01T00:00:00.000Z',
            '2099-01-01T00:00:00.000Z', ?)`,
          [id, audience, `hash-${id}`, refreshTokenHash]
        )
      insertSession("atlas", "atlas", null)
      insertSession("app", "app", null)
      insertSession("native", "atlas", "refresh-hash")

      await migration("061-drop-auth-audience").up(db)

      const rows = db.query("SELECT id, revoked_at FROM auth_sessions ORDER BY id").all() as {
        id: string
        revoked_at: string | null
      }[]
      expect(rows.map((row) => [row.id, row.revoked_at !== null])).toEqual([
        ["app", false],
        ["atlas", true],
        ["native", false],
      ])
      const columns = db.query("PRAGMA table_info(auth_sessions)").all() as { name: string }[]
      expect(columns.map((column) => column.name)).not.toContain("audience")
    } finally {
      db.close()
    }
  })

  test("keeps group memberships when it widens their source check to 'directory'", async () => {
    // Removal proof: drop 050's INSERT … SELECT; the manual membership below disappears.
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE auth_group_memberships (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('invitation', 'manual', 'agent')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id, group_id)
        );
        CREATE INDEX idx_auth_group_memberships_group
          ON auth_group_memberships(project_id, group_id);
        INSERT INTO auth_group_memberships
          VALUES ('p', 'usr_1', 'security-admins', 'manual', '2026-05-14T10:00:00.000Z');
      `)
      await migration("050-directory-group-memberships").up(db)
      db.run(
        "INSERT INTO auth_group_memberships VALUES ('p', 'usr_1', 'field-ops', 'directory', '2026-05-14T10:01:00.000Z')"
      )

      expect(
        db.query("SELECT group_id, source FROM auth_group_memberships ORDER BY group_id").all()
      ).toEqual([
        { group_id: "field-ops", source: "directory" },
        { group_id: "security-admins", source: "manual" },
      ])
      expect(() =>
        db.run(
          "INSERT INTO auth_group_memberships VALUES ('p', 'usr_1', 'x', 'unknown', '2026-05-14T10:02:00.000Z')"
        )
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test("attributes existing commits and pending events from their executions", async () => {
    // Removal proof: drop 047's commit UPDATE; every executor stays the '{}' placeholder.
    const db = new Database(":memory:")
    try {
      db.exec(`
        CREATE TABLE executions (
          project_id TEXT, id TEXT, executor_kind TEXT, executor_id TEXT,
          requested_by_user_id TEXT, requested_by_service_account_id TEXT,
          authority_primitive_id TEXT, authority_kernel_operation TEXT
        );
        CREATE TABLE ontology_commits (
          project_id TEXT, id TEXT, execution_id TEXT,
          actor TEXT CHECK (actor IS NULL OR json_valid(actor))
        );
        CREATE TABLE ontology_outbox (project_id TEXT, commit_id TEXT, envelope TEXT);
        INSERT INTO executions VALUES
          ('p', 'request', 'request', 'req-1', 'alice', NULL, NULL, NULL),
          ('p', 'service', 'request', 'req-2', NULL, 'svc-import', NULL, NULL),
          ('p', 'action', 'action', 'run-1', 'alice', NULL, 'approve', NULL),
          ('p', 'agent', 'agent', 'agent-run', 'alice', NULL, NULL, NULL),
          ('p', 'scheduled', 'workflow', 'wf-run', NULL, NULL, 'nightly', NULL),
          ('p', 'recover', 'kernel', 'recovery-1', NULL, NULL, NULL, 'ontology.recover'),
          ('p', 'index', 'kernel', 'indexing-1', NULL, NULL, NULL, 'ontology.indexVectors');
        INSERT INTO ontology_commits
          SELECT project_id, 'c-' || id, id,
            CASE WHEN id = 'request' THEN '{"id":"alice","type":"user"}' END
          FROM executions;
        INSERT INTO ontology_outbox VALUES
          ('p', 'c-request', '{"id":"e1","actor":{"id":"alice","type":"user"}}'),
          ('p', 'c-scheduled', '{"id":"e2"}');
      `)
      await migration("047-ontology-commit-attribution").up(db)

      expect(readMemoryTableColumns(db, "ontology_commits")).not.toContain("actor")
      const commits = db
        .query("SELECT id, requested_by, executor FROM ontology_commits ORDER BY id")
        .all() as { id: string; requested_by: string | null; executor: string }[]
      expect(
        commits.map((row) => ({
          id: row.id,
          requestedBy: row.requested_by === null ? null : JSON.parse(row.requested_by),
          executor: JSON.parse(row.executor),
        }))
      ).toEqual([
        {
          id: "c-action",
          requestedBy: { type: "user", id: "alice" },
          executor: { type: "primitive", kind: "action", id: "approve", runId: "run-1" },
        },
        {
          id: "c-agent",
          requestedBy: { type: "user", id: "alice" },
          executor: { type: "agent", runId: "agent-run" },
        },
        {
          id: "c-index",
          requestedBy: null,
          executor: {
            type: "kernel",
            operation: { type: "ontology.indexVectors", indexingId: "indexing-1" },
          },
        },
        {
          id: "c-recover",
          requestedBy: null,
          executor: {
            type: "kernel",
            operation: { type: "ontology.recover", recoveryId: "recovery-1" },
          },
        },
        {
          id: "c-request",
          requestedBy: { type: "user", id: "alice" },
          executor: { type: "request", requestId: "req-1" },
        },
        {
          id: "c-scheduled",
          requestedBy: null,
          executor: { type: "primitive", kind: "workflow", id: "nightly", runId: "wf-run" },
        },
        {
          id: "c-service",
          requestedBy: { type: "serviceAccount", id: "svc-import" },
          executor: { type: "request", requestId: "req-2" },
        },
      ])

      const envelopes = db
        .query("SELECT commit_id, envelope FROM ontology_outbox ORDER BY commit_id")
        .all() as { commit_id: string; envelope: string }[]
      expect(envelopes.map((row) => JSON.parse(row.envelope))).toEqual([
        {
          id: "e1",
          requestedBy: { type: "user", id: "alice" },
          executor: { type: "request", requestId: "req-1" },
        },
        {
          id: "e2",
          executor: { type: "primitive", kind: "workflow", id: "nightly", runId: "wf-run" },
        },
      ])
    } finally {
      db.close()
    }
  })

  describe("054 slim ontology outbox", () => {
    const commit: OntologyMaterializationEventCommit = {
      projectId: "p",
      id: "c-1",
      committedAt: "2026-10-01T08:00:00.000Z",
      origin: { kind: "runtime", requestId: "req-1" },
    }
    /** What the execution below says, and what 053 copied onto the commit. */
    const attribution: OntologyMaterializationEventAttribution = {
      correlationId: "correlation-1",
      requestedBy: { type: "user", id: "alice" },
      executor: { type: "request", requestId: "req-1" },
    }
    const drafts: readonly OntologyMaterializationEventDraft[] = [
      {
        type: "object.created",
        payload: { objectTypeId: "Device", primaryId: "d-1", properties: { b: 2, a: [1] } },
      },
      {
        type: "object.updated",
        payload: {
          objectTypeId: "Device",
          primaryId: "d-1",
          properties: { a: true },
          propertyChanges: { a: { operation: "updated", before: [1], after: true } },
        },
      },
      {
        type: "link.created",
        payload: {
          sourceTypeId: "Device",
          sourceId: "d-1",
          linkId: "owner",
          targetTypeId: "User",
          targetId: "u-1",
        },
      },
      {
        type: "telemetry.appended",
        payload: {
          objectTypeId: "Device",
          objectId: "d-1",
          propertyId: "temperature",
          value: 21.5,
          at: "2026-10-01T07:59:00.000Z",
        },
      },
    ]
    const envelopes = drafts.map((draft, ordinal) =>
      materializationEvent(
        draft,
        { id: `e-${ordinal}`, commitOrdinal: ordinal },
        commit,
        attribution
      )
    )

    /** A database at 053 holding `commit` and its events as 053 stored them. */
    function databaseAt053(stored = envelopes): Database {
      const db = replayedDatabase("054-slim-ontology-outbox")
      db.run(
        `INSERT INTO executions (
           project_id, id, executor_kind, executor_id, source_kind, source_id,
           requested_by_user_id, correlation_id, authority_kind, authority_user_id, created_at
         ) VALUES ('p', 'x-1', 'request', 'req-1', 'http', 'req-1', 'alice', 'correlation-1',
           'principal', 'alice', '2026-10-01T08:00:00.000Z')`
      )
      db.run(
        `INSERT INTO ontology_commits (
           project_id, id, idempotency_key, request_hash, execution_id, origin_kind, origin,
           requested_by, executor, ontology_revision, intent, result, committed_at
         ) VALUES ('p', 'c-1', 'runtime:c-1', 'hash', 'x-1', 'runtime', json(?), json(?), json(?),
           'revision', json('{}'), json('{}'), '2026-10-01T08:00:00.000Z')`,
        [
          canonicalJson(commit.origin),
          canonicalJson(attribution.requestedBy),
          canonicalJson(attribution.executor),
        ]
      )
      for (const envelope of stored) {
        db.run(
          `INSERT INTO ontology_outbox (
             project_id, id, commit_id, commit_ordinal, envelope, available_at, created_at
           ) VALUES ('p', ?, 'c-1', ?, json(?), ?, ?)`,
          [
            envelope.id,
            envelope.commitOrdinal,
            canonicalJson(envelope),
            commit.committedAt,
            commit.committedAt,
          ]
        )
      }
      return db
    }

    // Removal proof: keep `propertyChanges` in a created draft, or drop a context field from the
    // rebuild; the claimed events no longer equal what 053 stored.
    test("keeps every pending event exactly as consumers would have received it", async () => {
      const db = databaseAt053()
      try {
        await migration("054-slim-ontology-outbox").up(db)

        expect(readMemoryTableColumns(db, "ontology_outbox")).not.toContain("envelope")
        expect(db.query("SELECT event FROM ontology_outbox ORDER BY commit_ordinal").all()).toEqual(
          drafts.map((draft) => ({ event: canonicalJson(draft) }))
        )
        const commitColumns = readMemoryTableColumns(db, "ontology_commits")
        expect(commitColumns).not.toContain("requested_by")
        expect(commitColumns).not.toContain("executor")
        const outbox = new SqliteOntologyOutboxStorage(db, async (run) => run())
        const claimed = await outbox.claim({
          projectId: "p",
          now: "2026-10-01T09:00:00.000Z",
          limit: 10,
          leaseId: "lease",
          leaseExpiresAt: "2026-10-01T09:01:00.000Z",
        })
        expect(claimed.map((row) => row.envelope)).toStrictEqual(envelopes)
      } finally {
        db.close()
      }
    })

    // Removal proof: skip the check in 054's step; the tampered event is converted and would
    // reach consumers with its execution's correlation id instead of its own.
    test("refuses to convert an event that would not rebuild from its commit", async () => {
      const [first, ...rest] = envelopes
      const db = databaseAt053([{ ...first!, correlationId: "elsewhere" }, ...rest])
      try {
        await expect(
          Promise.resolve().then(() => migration("054-slim-ontology-outbox").up(db))
        ).rejects.toThrow("1 outbox events would not rebuild from their commit")
        expect(readMemoryTableColumns(db, "ontology_outbox")).toContain("envelope")
      } finally {
        db.close()
      }
    })
  })

  test("upgrades model accounting in one step without losing historical evidence or constraints", () => {
    // Regression proof: omit 029's reason conversion or native ID columns, or change shipped 026.
    const db = new Database(":memory:")
    try {
      db.run(`PRAGMA foreign_keys = ON;
        CREATE TABLE ai_model_call_usage (
          project_id TEXT, id TEXT, provider_id TEXT, requested_model_id TEXT, occurred_at TEXT,
          PRIMARY KEY (project_id, id)
        );
        INSERT INTO ai_model_call_usage VALUES ('project', 'usage', 'mock', 'model', '2026-08-01');`)
      migration("026-ai-cost-accounting").up(db)
      db.run(`INSERT INTO ai_model_call_valuations (
        project_id, usage_record_id, status, provider_id, model_id, reason, details, rated_at
      ) VALUES ('project', 'usage', 'unpriceable', 'mock', 'model', 'missingCatalogEntry',
        '{"pricingContext":{}}', '2026-08-01');`)
      for (const sourceId of ["provider-reported", "model-rate-card", "unknown-old-source"]) {
        db.run(
          "INSERT INTO ai_model_call_usage VALUES ('project', ?, 'mock', 'model', '2026-08-01')",
          [sourceId]
        )
        const details = JSON.stringify({
          pricingContext: {},
          priceSource: {
            sourceId,
            sourceEntryId: "model",
            sourceVersion: "v1",
            observedAt: "2026-08-01T00:00:00.000Z",
          },
          components: [
            {
              meter: "tokens.input.total",
              quantity: "10",
              rateAmountNanosPerMillion: "1000000000",
              chargeAmountNanos: "10000",
            },
          ],
        })
        db.run(
          `INSERT INTO ai_model_call_valuations (project_id, usage_record_id, status,
          provider_id, model_id, currency, amount_nanos, details, rated_at)
          VALUES ('project', ?, 'rated', 'mock', 'model', 'USD', 10000, ?, '2026-08-01')`,
          [sourceId, details]
        )
      }
      db.run(
        `UPDATE ai_model_call_valuations SET details = '{"pricingContext":{},"priceSource":{"sourceId":"provider-reported","sourceEntryId":"missing-report","sourceVersion":"v1","observedAt":"2026-08-01T00:00:00.000Z"}}' WHERE usage_record_id = 'usage'`
      )
      const before = db
        .query(
          "SELECT usage_record_id, details FROM ai_model_call_valuations ORDER BY usage_record_id"
        )
        .all()
      migration("029-model-accounting").up(db)
      expect(
        db
          .query("SELECT reason FROM ai_model_call_valuations WHERE usage_record_id = 'usage'")
          .get()
      ).toEqual({ reason: "missingRateCard" })
      expect(
        db
          .query(
            "SELECT usage_record_id, details FROM ai_model_call_valuations ORDER BY usage_record_id"
          )
          .all()
      ).toEqual(before)
      expect(() =>
        db.run(
          "UPDATE ai_model_call_valuations SET reason = 'missingCatalogEntry' WHERE usage_record_id = 'usage'"
        )
      ).toThrow()
      expect(() => db.run("DELETE FROM ai_model_call_usage")).toThrow()
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE name = 'idx_ai_model_call_valuations_summary'"
          )
          .get()
      ).not.toBeNull()
      expect(db.query("SELECT COUNT(*) AS count FROM ai_model_call_valuations").get()).toEqual({
        count: 4,
      })
      expect(
        db
          .query(
            "SELECT COUNT(*) AS count FROM ai_model_call_usage WHERE requested_reasoning IS NULL"
          )
          .get()
      ).toEqual({ count: 4 })
      expect(
        db
          .query("SELECT COUNT(*) AS count FROM ai_model_call_usage WHERE provider_ids IS NULL")
          .get()
      ).toEqual({ count: 4 })
    } finally {
      db.close()
    }
  })
  test("migrateStorage writes storage-level migration history once", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrations-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    try {
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "current" })
    } finally {
      storage.close()
    }

    expect(readMigrationRows(sqliteStoragePath(tempDir))).toEqual(
      shippedMigrationIds.map((id, index) => ({
        adapter_id: SQLITE_STORAGE_ADAPTER_ID,
        checksum_length: 64,
        id,
        status: "applied",
        version: index + 1,
      }))
    )
  })

  test("preserves every existing execution, Agent authority included, when adding delegated authority", () => {
    // Regression proof: restore 036's old service-account-only Agent CHECK; the migration fails.
    const db = replayedDatabase("036-share-sessions")
    try {
      // This fixture isolates CHECK/data preservation; foreign-key validity is covered by the
      // execution storage contract. SQLite's in-memory connection leaves foreign keys disabled.
      db.run(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, authority_kind, created_at
        ) VALUES (
          'project-a', 'request-parent', 'request', 'request-1', 'http', 'request-1',
          'correlation-1', 'disabled', '2026-08-01T12:00:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, parent_execution_id, authority_kind, authority_primitive_kind,
          authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'action-child', 'action', 'run-1', 'execution', 'request-parent',
          'correlation-1', 'request-parent', 'trustedPrimitive', 'action', 'approve',
          '2026-08-01T12:00:01.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, parent_execution_id, authority_kind,
          authority_user_id, authority_session_id, created_at
        ) VALUES
          ('project-a', 'agent-disabled', 'agent', 'run-disabled', 'execution', 'parent',
           'correlation', 'parent', 'disabled', NULL, NULL, '2026-09-09T00:00:00.000Z'),
          ('project-a', 'agent-user', 'agent', 'run-user', 'execution', 'parent',
           'correlation', 'parent', 'principal', 'user-1', 'session-1', '2026-09-09T00:00:00.000Z');
      `)
      const before = db
        .prepare<Record<string, unknown>, []>("SELECT * FROM executions ORDER BY id")
        .all()

      migration("036-share-sessions").up(db)

      expect(db.prepare("SELECT * FROM executions ORDER BY id").all()).toEqual(
        before.map((row) => ({
          ...row,
          authority_delegation_kind: null,
          authority_delegation_id: null,
          authority_delegation_session_id: null,
        }))
      )
      expect(readMemoryForeignKeyTables(db, "executions")).toContain("executions")
      expect(readMemoryForeignKeyTables(db, "executions")).not.toContain("executions_v2")
    } finally {
      db.close()
    }
  })

  test("rejects delegated executions without a delegation kind", () => {
    const db = replayedDatabase()
    try {
      db.run(`
        INSERT INTO share_grants (
          project_id, id, definition_id, target_object_type_id, target_primary_id,
          issued_by_type, issued_by_id, authority_version, authority_snapshot,
          authority_digest, token_hash, destination_path, created_at, expires_at
        ) VALUES (
          'project-a', 'grant-1', 'share-report', 'Report', 'report-1',
          'user', 'user-1', 1, '{"version":1,"access":{"grants":[]}}',
          '${"a".repeat(64)}', '${"b".repeat(64)}', '/reports/report-1',
          '2026-08-01T12:00:00.000Z', '2026-08-02T12:00:00.000Z'
        );
        INSERT INTO share_sessions (
          project_id, id, grant_id, token_hash, created_at, expires_at, absolute_expires_at
        ) VALUES (
          'project-a', 'session-1', 'grant-1', '${"c".repeat(64)}',
          '2026-08-01T12:00:00.000Z', '2026-08-01T12:15:00.000Z',
          '2026-08-02T12:00:00.000Z'
        );
      `)

      expect(() =>
        db.run(`
          INSERT INTO executions (
            project_id, id, executor_kind, executor_id, source_kind, source_id,
            correlation_id, authority_kind, authority_delegation_id,
            authority_delegation_session_id, created_at
          ) VALUES (
            'project-a', 'invalid-delegated', 'request', 'request-1', 'http', 'request-1',
            'correlation-1', 'delegated', 'grant-1', 'session-1',
            '2026-08-01T12:01:00.000Z'
          )
        `)
      ).toThrow("CHECK constraint failed")
    } finally {
      db.close()
    }
  })

  test("adds empty per-property edit times to legacy object overrides", () => {
    const db = replayedDatabase("028-object-override-edit-times")
    try {
      db.query(`
        INSERT INTO ontology_object_overrides (
          project_id, object_type_id, primary_id, value, last_commit_id, updated_at
        ) VALUES (?, ?, ?, json(?), ?, ?)
      `).run(
        "project",
        "Issue",
        "issue-1",
        JSON.stringify({ kind: "patch", set: { title: "edited" }, unset: [] }),
        "legacy-commit",
        "2026-01-01T11:00:00.000Z"
      )

      migration("028-object-override-edit-times").up(db)

      expect(
        db
          .query("SELECT edited_at FROM ontology_object_overrides WHERE primary_id = ?")
          .get("issue-1")
      ).toEqual({ edited_at: "{}" })
    } finally {
      db.close()
    }
  })

  test("migrates legacy failed run records from the version 10 schema", () => {
    const db = replayedDatabase("011-sync-failure-record")
    try {
      db.query(`
        INSERT INTO sync_runs (
          project_id, id, sync_id, dataset_id, mode, status, started_at, finished_at,
          error_name, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "project-a",
        "sync-legacy",
        "sync.orders",
        "orders",
        "snapshot",
        "failed",
        "2026-08-10T12:00:00.000Z",
        "2026-08-10T12:01:00.000Z",
        "ProviderError",
        "secret sync diagnostic"
      )

      db.query(`
        INSERT INTO pipeline_runs (
          project_id, id, pipeline_id, status, started_at, finished_at, error_name, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "project-a",
        "pipeline-legacy",
        "orders",
        "failed",
        "2026-08-10T12:00:00.000Z",
        "2026-08-10T12:01:00.000Z",
        "PipelineError",
        "secret pipeline diagnostic"
      )

      db.query(`
        INSERT INTO pipeline_step_runs (
          project_id, id, pipeline_run_id, pipeline_id, step_id, dataset_id, mode, status,
          started_at, finished_at, inputs, error_name, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "project-a",
        "step-legacy",
        "pipeline-legacy",
        "orders",
        "extract",
        "orders",
        "snapshot",
        "failed",
        "2026-08-10T12:00:00.000Z",
        "2026-08-10T12:01:00.000Z",
        "{}",
        "StepError",
        "secret step diagnostic"
      )

      db.run(`
        INSERT INTO auth_service_accounts (
          project_id, id, name, status, created_by_principal_type, created_at, updated_at
        ) VALUES (
          'project-a', 'svc_agent_reviewer', 'Reviewer Agent', 'active', 'system',
          '2026-08-10T11:00:00.000Z', '2026-08-10T11:00:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, authority_primitive_kind, authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'execution-workflow-legacy', 'workflow', 'workflow-legacy', 'event',
          'event-workflow-legacy', 'correlation-workflow-legacy', 'trustedPrimitive', 'workflow',
          'orders', '2026-08-10T12:00:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, authority_primitive_kind, authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'execution-action-legacy', 'action', 'action-legacy', 'event',
          'event-action-legacy', 'correlation-action-legacy', 'trustedPrimitive', 'action',
          'approve', '2026-08-10T12:00:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, created_at
        ) VALUES (
          'project-a', 'execution-agent-parent-legacy', 'request',
          'request-agent-parent-legacy', 'http', 'request-agent-parent-legacy',
          'correlation-agent-legacy', 'disabled', '2026-08-10T11:59:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          parent_execution_id, authority_kind, authority_service_account_id, created_at
        ) VALUES
          (
            'project-a', 'execution-agent-legacy', 'agent', 'agent-legacy', 'execution',
            'execution-agent-parent-legacy', 'correlation-agent-legacy',
            'execution-agent-parent-legacy', 'principal', 'svc_agent_reviewer',
            '2026-08-10T12:00:00.000Z'
          ),
          (
            'project-a', 'execution-workflow-agent-legacy', 'agent', 'node-legacy', 'execution',
            'execution-workflow-legacy', 'correlation-workflow-legacy',
            'execution-workflow-legacy', 'principal', 'svc_agent_reviewer',
            '2026-08-10T12:00:00.000Z'
          );

        INSERT INTO workflow_runs (
          project_id, id, workflow_id, status, input, started_at, finished_at, error, execution_id
        ) VALUES (
          'project-a', 'workflow-legacy', 'orders', 'failed', '{}',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z',
          'secret workflow diagnostic', 'execution-workflow-legacy'
        );

        INSERT INTO workflow_node_runs (
          project_id, id, workflow_run_id, workflow_id, node_index, node_type, node_id, node_key,
          status, input, started_at, finished_at, error
        ) VALUES (
          'project-a', 'node-legacy', 'workflow-legacy', 'orders', 0, 'agent', 'review', 'review',
          'failed', '{}', '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z',
          'secret workflow node diagnostic'
        );

        INSERT INTO workflow_agent_node_runs (
          project_id, node_run_id, execution_id, agent_id, status, prompt, error, created_at,
          completed_at
        ) VALUES (
          'project-a', 'node-legacy', 'execution-workflow-agent-legacy', 'reviewer', 'failed',
          'Review this order', 'secret workflow Agent diagnostic',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z'
        );

        INSERT INTO agent_runs (
          project_id, id, execution_id, thread_id, agent_id, trigger_message_id, status, error,
          created_at, completed_at
        ) VALUES (
          'project-a', 'agent-legacy', 'execution-agent-legacy', 'thread-legacy', 'reviewer',
          'message-legacy', 'failed', 'secret Agent diagnostic',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z'
        );

        INSERT INTO projection_runs (
          project_id, id, projection_id, projection_kind, materialization_protocol, dataset_id,
          dataset_version_id, dataset_version_created_at, ontology_revision, projection_revision,
          ownership_hash, object_type_id, status, started_at, finished_at, attempt, error_message
        ) VALUES (
          'project-a', 'projection-legacy', 'orders', 'object', 'replacement', 'orders', 'version-1',
          '2026-08-10T11:00:00.000Z', 'ontology-1', 'projection-1', 'ownership-1', 'Order',
          'failed', '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z', 1,
          'secret projection diagnostic'
        );

        INSERT INTO webhook_runs (
          project_id, id, connector_id, webhook_id, status, method, route, started_at, finished_at,
          error
        ) VALUES (
          'project-a', 'webhook-legacy', 'github', 'events', 'failed', 'POST', '/hooks/github',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z',
          'secret webhook diagnostic'
        );

        INSERT INTO action_runs (
          project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
          finished_at, params, idempotency_key, writeback_status, writeback_completed_at,
          writeback_error_name, writeback_error_message, writeback_error_phase, effects_status,
          effects_completed_at, effects_error_name, effects_error_message, effects_error_phase,
          error_name, error_message, error_phase
        ) VALUES (
          'project-a', 'action-legacy', 'execution-action-legacy', 'approve', 'none', 'failed',
          'effects', '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z', '{}',
          'action-legacy', 'failed', '2026-08-10T12:00:30.000Z', 'WritebackError',
          'secret writeback diagnostic', 'writeback', 'failed', '2026-08-10T12:00:45.000Z',
          'EffectsError', 'secret effects diagnostic', 'effects', 'ActionError',
          'secret Action diagnostic', 'effects'
        );
      `)

      const executionMigrationIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "021-sync-pipeline-executions"
      )
      for (const step of sqliteStorageMigrations.steps.slice(10, executionMigrationIndex)) {
        step.up(db)
      }

      const row = db
        .query("SELECT error FROM sync_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "sync-legacy") as { readonly error: string }
      const failure = parseSixbFailure(row.error, SYNC_RUN_FAILURE_CODES)

      expect(failure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        at: "2026-08-10T12:01:00.000Z",
        details: {
          syncId: "sync.orders",
          runId: "sync-legacy",
          datasetId: "orders",
          migratedFromLegacyError: true,
        },
      })
      expect(JSON.stringify(failure)).not.toContain("secret sync diagnostic")

      const pipelineRow = db
        .query("SELECT error FROM pipeline_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "pipeline-legacy") as { readonly error: string }
      const pipelineFailure = parseSixbFailure(pipelineRow.error, PIPELINE_RUN_FAILURE_CODES)
      expect(pipelineFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: { pipelineId: "orders", runId: "pipeline-legacy" },
      })
      expect(JSON.stringify(pipelineFailure)).not.toContain("secret pipeline diagnostic")

      const stepRow = db
        .query("SELECT error FROM pipeline_step_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "step-legacy") as { readonly error: string }
      const stepFailure = parseSixbFailure(stepRow.error, PIPELINE_RUN_FAILURE_CODES)
      expect(stepFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: {
          pipelineId: "orders",
          pipelineRunId: "pipeline-legacy",
          stepId: "extract",
          stepRunId: "step-legacy",
        },
      })
      expect(JSON.stringify(stepFailure)).not.toContain("secret step diagnostic")

      const workflowRow = db
        .query("SELECT error FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "workflow-legacy") as { readonly error: string }
      const workflowFailure = parseSixbFailure(workflowRow.error, WORKFLOW_RUN_FAILURE_CODES)
      expect(workflowFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: { workflowId: "orders", workflowRunId: "workflow-legacy" },
      })
      expect(JSON.stringify(workflowFailure)).not.toContain("secret workflow diagnostic")

      const nodeRow = db
        .query("SELECT error FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "node-legacy") as { readonly error: string }
      const nodeFailure = parseSixbFailure(nodeRow.error, WORKFLOW_RUN_FAILURE_CODES)
      expect(nodeFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: {
          workflowId: "orders",
          workflowRunId: "workflow-legacy",
          nodeId: "review",
          nodeRunId: "node-legacy",
        },
      })
      expect(JSON.stringify(nodeFailure)).not.toContain("secret workflow node diagnostic")

      const agentRow = db
        .query("SELECT error FROM agent_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "agent-legacy") as { readonly error: string }
      const agentFailure = parseSixbFailure(agentRow.error, AGENT_RUN_FAILURE_CODES)
      expect(agentFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: {
          agentId: "reviewer",
          runId: "agent-legacy",
          threadId: "thread-legacy",
        },
      })
      expect(JSON.stringify(agentFailure)).not.toContain("secret Agent diagnostic")

      const agentNodeRow = db
        .query(
          "SELECT error FROM workflow_agent_node_runs WHERE project_id = ? AND node_run_id = ?"
        )
        .get("project-a", "node-legacy") as { readonly error: string }
      const agentNodeFailure = parseSixbFailure(agentNodeRow.error, AGENT_RUN_FAILURE_CODES)
      expect(agentNodeFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: {
          agentId: "reviewer",
          workflowId: "orders",
          workflowRunId: "workflow-legacy",
          nodeId: "review",
          nodeRunId: "node-legacy",
        },
      })
      expect(JSON.stringify(agentNodeFailure)).not.toContain("secret workflow Agent diagnostic")

      const projectionRow = db
        .query("SELECT error FROM projection_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "projection-legacy") as { readonly error: string }
      const projectionFailure = parseSixbFailure(projectionRow.error, PROJECTION_RUN_FAILURE_CODES)
      expect(projectionFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        at: "2026-08-10T12:01:00.000Z",
        details: {
          projectionId: "orders",
          runId: "projection-legacy",
          migratedFromLegacyError: true,
        },
      })
      expect(JSON.stringify(projectionFailure)).not.toContain("secret projection diagnostic")

      const webhookRow = db
        .query("SELECT error FROM webhook_runs WHERE project_id = ? AND id = ?")
        .get("project-a", "webhook-legacy") as { readonly error: string }
      const webhookFailure = parseSixbFailure(webhookRow.error, WEBHOOK_RUN_FAILURE_CODES)
      expect(webhookFailure).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        at: "2026-08-10T12:01:00.000Z",
        details: {
          connectorId: "github",
          webhookId: "events",
          runId: "webhook-legacy",
          migratedFromLegacyError: true,
        },
      })
      expect(JSON.stringify(webhookFailure)).not.toContain("secret webhook diagnostic")

      const actionRow = db
        .query("SELECT error, writeback_error, effects_error FROM action_runs WHERE id = ?")
        .get("action-legacy") as {
        readonly error: string
        readonly writeback_error: string
        readonly effects_error: string
      }
      expect(parseActionRunFailure(actionRow.error)).toMatchObject({
        code: "internal.unexpected",
        details: { actionId: "approve", runId: "action-legacy", phase: "effects" },
      })
      expect(parseActionRunFailure(actionRow.writeback_error, "writeback")).toMatchObject({
        details: { actionId: "approve", runId: "action-legacy", phase: "writeback" },
      })
      expect(parseActionRunFailure(actionRow.effects_error, "effects")).toMatchObject({
        details: { actionId: "approve", runId: "action-legacy", phase: "effects" },
      })
      expect(JSON.stringify(actionRow)).not.toContain("secret")
      expect(readMemoryTableColumns(db, "action_runs")).not.toContain("error_phase")
    } finally {
      db.close()
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
    const db = replayedDatabase("007-split-overrides")
    try {
      const splitOverridesMigration = migration("007-split-overrides")
      const splitOverridesIndex = sqliteStorageMigrations.steps.indexOf(splitOverridesMigration)

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
      // The reader queries the current schema: finish the upgrade before reading.
      for (const step of sqliteStorageMigrations.steps.slice(splitOverridesIndex + 1)) {
        step.up(db)
      }
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
    const db = replayedDatabase()
    try {
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

  test("ontology outbox failure migration replaces legacy diagnostics with a safe failure", () => {
    const db = replayedDatabase("018-ontology-outbox-failure-record")
    try {
      const failureMigration = migration("018-ontology-outbox-failure-record")
      db.query(`
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, envelope, available_at,
          attempts, published_at, last_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        "project-a",
        "event-failed",
        "commit-failed",
        0,
        JSON.stringify({ type: "object.created" }),
        "2026-08-10T12:01:00.000Z",
        2,
        "Error: broker unavailable",
        "2026-08-10T12:00:00.000Z"
      )
      db.query(`
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, envelope, available_at,
          attempts, published_at, last_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        "project-a",
        "event-stopped",
        "commit-stopped",
        0,
        JSON.stringify({ type: "object.updated" }),
        "2026-08-10T12:02:00.000Z",
        1,
        "Outbox dispatcher stopped before publication completed.",
        "2026-08-10T12:00:00.000Z"
      )

      failureMigration.up(db)

      expect(readMemoryTableColumns(db, "ontology_outbox")).toContain("last_failure")
      expect(readMemoryTableColumns(db, "ontology_outbox")).not.toContain("last_error")
      const rows = db
        .query("SELECT id, last_failure FROM ontology_outbox ORDER BY id")
        .all() as Array<{ readonly id: string; readonly last_failure: string | null }>
      expect(rows[0]?.id).toBe("event-failed")
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
    } finally {
      db.close()
    }
  })

  test("webhook delivery failure migration replaces legacy diagnostics with a safe failure", () => {
    const db = replayedDatabase("019-webhook-delivery-failure-record")
    try {
      const failureMigration = migration("019-webhook-delivery-failure-record")
      db.query(`
        INSERT INTO webhook_deliveries (
          project_id, connector_id, webhook_id, idempotency_key, status,
          received_at, completed_at, failed_at, error
        ) VALUES (?, ?, ?, ?, 'failed', ?, NULL, ?, ?)
      `).run(
        "project-a",
        "github",
        "events",
        "delivery-failed-at",
        "2026-08-10T12:00:00.000Z",
        "2026-08-10T12:01:00.000Z",
        "Error: handler unavailable"
      )
      db.query(`
        INSERT INTO webhook_deliveries (
          project_id, connector_id, webhook_id, idempotency_key, status,
          received_at, completed_at, failed_at, error
        ) VALUES (?, ?, ?, ?, 'failed', ?, NULL, NULL, ?)
      `).run(
        "project-a",
        "stripe",
        "payments",
        "delivery-received-at",
        "2026-08-10T12:02:00.000Z",
        "Error: legacy row without failure time"
      )

      failureMigration.up(db)

      expect(readMemoryTableColumns(db, "webhook_deliveries")).toContain("failure")
      expect(readMemoryTableColumns(db, "webhook_deliveries")).not.toContain("error")
      const rows = db
        .query("SELECT idempotency_key, failure FROM webhook_deliveries ORDER BY idempotency_key")
        .all() as Array<{ readonly idempotency_key: string; readonly failure: string | null }>
      expect(rows[0]?.idempotency_key).toBe("delivery-failed-at")
      expect(parseSixbFailure(rows[0]?.failure, LEGACY_WEBHOOK_DELIVERY_FAILURE_CODES)).toEqual({
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        at: "2026-08-10T12:01:00.000Z",
        details: {
          connectorId: "github",
          webhookId: "events",
          idempotencyKey: "delivery-failed-at",
          migratedFromLegacyError: true,
          timestampSource: "failedAt",
        },
      })
      expect(parseSixbFailure(rows[1]?.failure, LEGACY_WEBHOOK_DELIVERY_FAILURE_CODES)).toEqual({
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        at: "2026-08-10T12:02:00.000Z",
        details: {
          connectorId: "stripe",
          webhookId: "payments",
          idempotencyKey: "delivery-received-at",
          migratedFromLegacyError: true,
          timestampSource: "receivedAt",
        },
      })
    } finally {
      db.close()
    }
  })

  test("recorded old checksums are rejected before schema mutation", async () => {
    const tempDir = await migratedDirectory()
    const path = sqliteStoragePath(tempDir)
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
    const db = replayedDatabase()
    try {
      const ontologyTables = readMemoryTableNames(db).filter((name) => name.startsWith("ontology_"))
      expect(ontologyTables).toEqual([
        "ontology_commit_touches",
        "ontology_commits",
        "ontology_link_overrides",
        "ontology_object_overrides",
        "ontology_outbox",
        "ontology_replacement_plan_identities",
        "ontology_replacement_plan_work",
        "ontology_replacement_plans",
        "ontology_source_roots",
        "ontology_source_rows",
        "ontology_sources",
      ])
      // A commit references its execution; who asked and what wrote live only there.
      expect(readMemoryTableColumns(db, "ontology_commits")).toContain("execution_id")
      for (const copy of ["actor", "requested_by", "executor", "correlation_id"]) {
        expect(readMemoryTableColumns(db, "ontology_commits")).not.toContain(copy)
      }
      expect(readMemoryColumn(db, "ontology_commits", "execution_id")?.notnull).toBe(1)
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
          "error",
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
    const db = replayedDatabase("005-workflow-executions")
    try {
      db.query(`
        INSERT INTO workflow_runs (
          project_id, id, workflow_id, status, input, started_at
        ) VALUES (?, ?, ?, 'queued', '{}', ?)
      `).run("project-a", "legacy-run", "legacy-workflow", "2026-01-01T00:00:00.000Z")

      expect(() => migration("005-workflow-executions").up(db)).toThrow()
      expect(readMemoryTableColumns(db, "workflow_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("rejects legacy Action runs instead of inventing their execution authority", () => {
    const db = replayedDatabase("008-action-executions")
    try {
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

      expect(() => migration("008-action-executions").up(db)).toThrow()
      expect(readMemoryTableColumns(db, "action_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("rejects legacy Agent runs instead of inventing their execution authority", () => {
    const db = replayedDatabase("009-agent-executions")
    try {
      const agentExecutionsMigration = migration("009-agent-executions")
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

  test("Agent run migrations preserve existing conversations and admit per-turn specs", () => {
    const db = replayedDatabase("031-subagent-runs")
    try {
      const step = migration("031-subagent-runs")
      const migrationIndex = sqliteStorageMigrations.steps.indexOf(step)

      db.run(`
        INSERT INTO auth_service_accounts (
          project_id, id, name, status, created_at, updated_at
        ) VALUES (
          'project-a', 'svc_agent_assistant', 'Assistant', 'active',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, authority_kind, created_at
        ) VALUES (
          'project-a', 'exec-request', 'request', 'request-1', 'http', 'request-1',
          'correlation-1', 'disabled', '2026-01-01T00:00:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          parent_execution_id, correlation_id, authority_kind, authority_service_account_id,
          created_at
        ) VALUES (
          'project-a', 'exec-run-1', 'agent', 'run-1', 'execution', 'exec-request',
          'exec-request', 'correlation-1', 'principal', 'svc_agent_assistant',
          '2026-01-01T00:00:01.000Z'
        )
      `)
      db.run(`
        INSERT INTO agent_runs (
          project_id, id, execution_id, thread_id, agent_id, trigger_message_id,
          requester_group_ids, status, created_at
        ) VALUES (
          'project-a', 'run-1', 'exec-run-1', 'thread-1', 'assistant', 'message-1',
          '["agent-users"]', 'succeeded', '2026-01-01T00:00:02.000Z'
        )
      `)

      step.up(db)

      expect(
        db
          .query(
            "SELECT kind, thread_id, agent_id, trigger_message_id, requester_group_ids FROM agent_runs WHERE id = 'run-1'"
          )
          .get()
      ).toEqual({
        kind: "conversation",
        thread_id: "thread-1",
        agent_id: "assistant",
        trigger_message_id: "message-1",
        requester_group_ids: '["agent-users"]',
      })
      expect(db.query("SELECT executor_id FROM executions WHERE id = 'exec-run-1'").get()).toEqual({
        executor_id: "run-1",
      })

      const conversationSpecMigration = sqliteStorageMigrations.steps[migrationIndex + 1]
      if (conversationSpecMigration?.id !== "032-conversation-run-spec") {
        throw new Error("SQLite conversation-run-spec migration is missing.")
      }
      conversationSpecMigration.up(db)
      expect(db.query("PRAGMA foreign_key_list(agent_runs)").all()).toContainEqual(
        expect.objectContaining({ table: "agent_runs", from: "parent_run_id", to: "id" })
      )
      const spec = JSON.stringify({
        model: { provider: "gateway", modelId: "openai/gpt-5.4-mini" },
        reasoning: "medium",
      })
      db.query("UPDATE agent_runs SET spec = ? WHERE id = 'run-1'").run(spec)
      expect(db.query("SELECT spec FROM agent_runs WHERE id = 'run-1'").get()).toEqual({ spec })

      const retireDefinitionsMigration = sqliteStorageMigrations.steps[migrationIndex + 2]
      if (retireDefinitionsMigration?.id !== "033-retire-agent-definitions") {
        throw new Error("SQLite retire-agent-definitions migration is missing.")
      }
      retireDefinitionsMigration.up(db)
      expect(readMemoryTableColumns(db, "agent_runs")).not.toContain("agent_id")
      expect(
        db.query("SELECT kind, thread_id, trigger_message_id, spec FROM agent_runs").get()
      ).toEqual({
        kind: "conversation",
        thread_id: "thread-1",
        trigger_message_id: "message-1",
        spec,
      })
      expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test("rejects legacy Sync and Pipeline runs instead of inventing execution authority", () => {
    for (const kind of ["sync", "pipeline"] as const) {
      const db = replayedDatabase("021-sync-pipeline-executions")
      try {
        const executionMigration = migration("021-sync-pipeline-executions")
        if (kind === "sync") {
          db.query(`
            INSERT INTO sync_runs (
              project_id, id, sync_id, dataset_id, mode, status, started_at
            ) VALUES (?, ?, ?, ?, 'snapshot', 'running', ?)
          `).run(
            "project-a",
            "legacy-sync-run",
            "sync-orders",
            "raw.orders",
            "2026-01-01T00:00:00.000Z"
          )
        } else {
          db.query(`
            INSERT INTO pipeline_runs (
              project_id, id, pipeline_id, status, started_at
            ) VALUES (?, ?, ?, 'running', ?)
          `).run("project-a", "legacy-pipeline-run", "pipeline-orders", "2026-01-01T00:00:00.000Z")
        }

        expect(() => db.transaction(() => executionMigration.up(db))()).toThrow()
        expect(readMemoryTableColumns(db, "sync_runs")).not.toContain("execution_id")
        expect(readMemoryTableColumns(db, "pipeline_runs")).not.toContain("execution_id")
      } finally {
        db.close()
      }
    }
  })

  test("rejects legacy Projection runs instead of inventing execution authority", () => {
    const db = replayedDatabase("022-projection-executions")
    try {
      const executionMigration = migration("022-projection-executions")
      db.query(`
        INSERT INTO projection_runs (
          project_id, id, projection_id, projection_kind, materialization_protocol,
          dataset_id, dataset_version_id, dataset_version_created_at, ontology_revision,
          projection_revision, ownership_hash, object_type_id, status, started_at, attempt,
          execution_token
        ) VALUES (
          ?, ?, ?, 'object', 'replacement', ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, ?
        )
      `).run(
        "project-a",
        "legacy-projection-run",
        "project-devices",
        "raw.devices",
        "version-1",
        "2026-01-01T00:00:00.000Z",
        "ontology-1",
        "projection-1",
        "ownership-1",
        "Device",
        "2026-01-01T00:00:00.000Z",
        "legacy-token"
      )

      expect(() => db.transaction(() => executionMigration.up(db))()).toThrow()
      expect(readMemoryTableColumns(db, "projection_runs")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("rejects legacy Webhook runs and deliveries instead of inventing authority", () => {
    for (const legacyRecord of ["run", "delivery"] as const) {
      const db = replayedDatabase("023-webhook-executions")
      try {
        const executionMigration = migration("023-webhook-executions")

        if (legacyRecord === "run") {
          db.query(`
            INSERT INTO webhook_runs (
              project_id, id, connector_id, webhook_id, status, method, route, started_at
            ) VALUES (?, ?, ?, ?, 'running', 'POST', ?, ?)
          `).run(
            "project-a",
            "legacy-webhook-run",
            "github",
            "events",
            "/api/webhooks/github/events",
            "2026-01-01T00:00:00.000Z"
          )
        } else {
          db.query(`
            INSERT INTO webhook_deliveries (
              project_id, connector_id, webhook_id, idempotency_key, status, received_at
            ) VALUES (?, ?, ?, ?, 'in_progress', ?)
          `).run("project-a", "github", "events", "delivery-1", "2026-01-01T00:00:00.000Z")
        }

        expect(() => db.transaction(() => executionMigration.up(db))()).toThrow()
        expect(readMemoryTableColumns(db, "webhook_runs")).not.toContain("execution_id")
        expect(readMemoryTableNames(db)).toContain("webhook_deliveries")
      } finally {
        db.close()
      }
    }
  })

  test("rejects legacy ontology commits instead of inventing execution authority", () => {
    const db = replayedDatabase("024-ontology-commit-executions")
    try {
      const step = migration("024-ontology-commit-executions")
      db.query(`
        INSERT INTO ontology_commits (
          project_id, id, idempotency_key, request_hash, origin_kind, origin,
          ontology_revision, intent, result, committed_at
        ) VALUES (?, ?, ?, ?, 'runtime', json(?), ?, json(?), json(?), ?)
      `).run(
        "project-a",
        "legacy-commit",
        "runtime:legacy-commit",
        "legacy-hash",
        JSON.stringify({ kind: "runtime", requestId: "legacy-request" }),
        "ontology-1",
        JSON.stringify({ kind: "edit", mode: "atomic", operationCount: 0 }),
        JSON.stringify({
          kind: "edit",
          commitId: "legacy-commit",
          created: true,
          eventCount: 0,
          committedAt: "2026-01-01T00:00:00.000Z",
          outcomes: [],
          changes: { objects: [], links: [] },
        }),
        "2026-01-01T00:00:00.000Z"
      )

      expect(() => db.transaction(() => step.up(db))()).toThrow("unknown authority")
      expect(readMemoryTableColumns(db, "ontology_commits")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("requires every ontology commit to reference a durable execution", () => {
    const db = replayedDatabase()
    try {
      expect(readMemoryColumn(db, "ontology_commits", "execution_id")?.notnull).toBe(1)
      expect(readMemoryForeignKeyTables(db, "ontology_commits")).toContain("executions")
      expect(readMemoryIndexColumns(db, "idx_ontology_commits_execution")).toEqual([
        "project_id",
        "execution_id",
      ])
    } finally {
      db.close()
    }
  })

  test("stores a headless connector attempt as the run's single protocol child", () => {
    const db = replayedDatabase()
    try {
      expect(readMemoryTableColumns(db, "connector_connection_runs")).not.toContain(
        "authorization_attempt_id"
      )
      expect(readMemoryTableColumns(db, "connector_authorization_attempts")).not.toContain(
        "owner_type"
      )
      expect(readMemoryTableColumns(db, "connector_connections")).not.toContain("owner_type")
      expect(readMemoryUniqueIndexes(db, "connector_authorization_attempts")).toContainEqual([
        "project_id",
        "connector_id",
        "connection_run_id",
      ])
      expect(readMemoryForeignKeyTables(db, "connector_authorization_attempts")).toContain(
        "connector_connection_runs"
      )
      expect(readMemoryUniqueIndexes(db, "connector_connections")).toContainEqual([
        "project_id",
        "connector_id",
        "slot",
      ])
    } finally {
      db.close()
    }
  })

  test("AI cost accounting migration preserves existing Phase 1 usage rows", () => {
    const db = replayedDatabase("026-ai-cost-accounting")
    try {
      const costMigration = migration("026-ai-cost-accounting")
      const costIndex = sqliteStorageMigrations.steps.indexOf(costMigration)

      db.run(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, authority_primitive_kind, authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'execution-1', 'workflow', 'workflow-1', 'event', 'event-1',
          'correlation-1', 'trustedPrimitive', 'workflow', 'workflow-1',
          '2026-08-01T11:59:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO ai_model_call_usage (
          project_id, id, execution_id, attempt, call_id, provider_id, requested_model_id,
          response_id, input_tokens, output_tokens, total_tokens, reporting_status, raw_usage,
          occurred_at, recorded_at
        ) VALUES (
          'project-a', 'usage-1', 'execution-1', 1, 'call-1', 'gateway', 'openai/gpt-5',
          'response-1', 12, 8, 20, 'complete', '{"inputTokens":12,"outputTokens":8}',
          '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:01.000Z'
        )
      `)
      const before = db.query("SELECT * FROM ai_model_call_usage").get()

      const applied = costMigration.up(db)
      if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")

      expect(db.query("SELECT * FROM ai_model_call_usage").get()).toEqual(before)
      expect(readMemoryTableColumns(db, "ai_model_call_valuations")).toEqual(
        expect.arrayContaining(["usage_record_id", "status", "details", "amount_nanos", "rated_at"])
      )
      expect(readMemoryTableColumns(db, "ai_price_schedules")).toEqual([])
      db.run(`
        INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id, currency, amount_nanos,
          reason, details, rated_at
        ) VALUES (
          'project-a', 'usage-1', 'rated', 'vercel', 'openai/gpt-5', 'USD', 20,
          NULL, '{"pricingContext":{},"historical":"preserve"}', '2026-08-01T12:00:01.000Z'
        )
      `)
      const oldCost = db.query("SELECT * FROM ai_model_call_valuations").get()
      expect(() => db.run("UPDATE ai_model_call_valuations SET status = 'reported'")).toThrow()
      for (const step of sqliteStorageMigrations.steps.slice(costIndex + 1)) {
        step.up(db)
      }
      // Later agent migrations must preserve the native accounting rows and constraints.
      expect(db.query("SELECT * FROM ai_model_call_valuations").get()).toEqual(oldCost)
      expect(db.query("SELECT * FROM ai_model_call_usage").get()).toEqual(before)
      expect(() => db.run("UPDATE ai_model_call_valuations SET status = 'reported'")).toThrow()
      expect(() => db.run("UPDATE ai_model_call_valuations SET amount_nanos = NULL")).toThrow()
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      db.close()
    }
  })

  test("drops only obsolete run usage projections from an existing schema", () => {
    // Regression guard: remove migration 020 (or any one DROP COLUMN) and this leaves the old
    // projection column behind; deleting the run rows instead breaks the preservation assertions.
    const db = replayedDatabase("020-drop-run-usage-projections")
    try {
      const cleanup = migration("020-drop-run-usage-projections")
      db.run(`
        INSERT INTO agent_runs (
          project_id, id, execution_id, thread_id, agent_id, trigger_message_id, status,
          usage_input_tokens, usage_output_tokens, usage_total_tokens, created_at
        ) VALUES (
          'project-a', 'run-1', 'execution-run-1', 'thread-1', 'sales', 'message-1', 'succeeded',
          12, 8, 20, '2026-07-01T12:00:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO workflow_agent_node_runs (
          project_id, node_run_id, execution_id, agent_id, status, prompt, usage, created_at
        ) VALUES (
          'project-a', 'node-1', 'execution-node-1', 'sales', 'succeeded', 'Resolve it',
          '{"inputTokens":12,"outputTokens":8}', '2026-07-01T12:00:00.000Z'
        )
      `)

      const applied = cleanup.up(db)
      if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")

      const agentColumns = readMemoryTableColumns(db, "agent_runs")
      const workflowColumns = readMemoryTableColumns(db, "workflow_agent_node_runs")
      expect(agentColumns.some((column) => column.startsWith("usage_"))).toBe(false)
      expect(workflowColumns).not.toContain("usage")
      expect(
        db.query("SELECT id, status, model_id FROM agent_runs WHERE id = 'run-1'").get()
      ).toEqual({ id: "run-1", status: "succeeded", model_id: null })
      expect(
        db
          .query(
            "SELECT node_run_id, status, prompt FROM workflow_agent_node_runs WHERE node_run_id = 'node-1'"
          )
          .get()
      ).toEqual({ node_run_id: "node-1", status: "succeeded", prompt: "Resolve it" })
    } finally {
      db.close()
    }
  })

  test("shares each existing artifact in the threads its versions came from", () => {
    // Removal proof: drop the INSERT from migration 071; the artifact is then shared nowhere.
    const db = replayedDatabase("071-artifact-threads")
    try {
      db.run(`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, created_at, updated_at
        ) VALUES (
          'project-a', 'art_0000000001', 'document', 'Report', 'user', 'usr-1', 3, 4,
          '2026-07-01T12:00:00.000Z', '2026-07-01T12:02:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO artifact_versions (
          project_id, artifact_id, version, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
        ) VALUES (
          'project-a', 'art_0000000001', 1, 'Report', 'document.md', '[]',
          '{"kind":"document","headings":[]}', '[]', 'user', 'usr-1', 'thread-1', 'run-1', '2026-07-01T12:00:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO artifact_versions (
          project_id, artifact_id, version, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
        ) VALUES (
          'project-a', 'art_0000000001', 2, 'Report', 'document.md', '[]',
          '{"kind":"document","headings":[]}', '[]', 'user', 'usr-1', 'thread-1', 'run-2', '2026-07-01T12:01:00.000Z'
        )
      `)
      db.run(`
        INSERT INTO artifact_versions (
          project_id, artifact_id, version, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
        ) VALUES (
          'project-a', 'art_0000000001', 3, 'Report', 'document.md', '[]',
          '{"kind":"document","headings":[]}', '[]', 'user', 'usr-1', NULL, NULL, '2026-07-01T12:02:00.000Z'
        )
      `)

      const applied = migration("071-artifact-threads").up(db)
      if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")

      expect(
        db.query("SELECT artifact_id, thread_id, shared_at FROM artifact_threads").all()
      ).toEqual([
        {
          artifact_id: "art_0000000001",
          thread_id: "thread-1",
          shared_at: "2026-07-01T12:00:00.000Z",
        },
      ])
    } finally {
      db.close()
    }
  })

  test("scopes a run's context checkpoint to its thread and keeps existing checkpoints", () => {
    // Regression guard: remove migration 070; the second thread's copy of `run-1`'s checkpoint
    // violates the old project-wide uniqueness.
    const db = new Database(":memory:")
    try {
      const forkIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "070-forked-context-checkpoints"
      )
      const fork = sqliteStorageMigrations.steps[forkIndex]
      if (!fork) throw new Error("expected forked checkpoint migration")
      for (const migration of sqliteStorageMigrations.steps.slice(0, forkIndex)) {
        const applied = migration.up(db)
        if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")
      }

      const insertCheckpoint = (
        id: string,
        threadId: string,
        previousId: string | null = null,
        runId = "run-1"
      ) =>
        db.run(
          `
          INSERT INTO agent_context_checkpoints (
            project_id, id, thread_id, created_by_run_id, previous_checkpoint_id, reason, summary,
            summary_format_version, summarized_through_seq, observed_head_seq,
            estimated_input_tokens_before, estimated_input_tokens_after, summary_model_id,
            created_at
          ) VALUES (
            'project-a', ?, ?, ?, ?, 'threshold', 'Summary', 1, 2, 3, 100, 10, 'model',
            '2026-07-01T12:00:00.000Z'
          )
        `,
          [id, threadId, runId, previousId]
        )
      insertCheckpoint("checkpoint-1", "thread-1")
      insertCheckpoint("checkpoint-2", "thread-1", "checkpoint-1", "run-2")

      const applied = fork.up(db)
      if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")

      expect(
        db
          .query(
            "SELECT id, thread_id, previous_checkpoint_id FROM agent_context_checkpoints ORDER BY id"
          )
          .all()
      ).toEqual([
        { id: "checkpoint-1", thread_id: "thread-1", previous_checkpoint_id: null },
        { id: "checkpoint-2", thread_id: "thread-1", previous_checkpoint_id: "checkpoint-1" },
      ])

      // The chain still references the rebuilt table, not the copy it was built in.
      expect(db.query("PRAGMA foreign_key_list(agent_context_checkpoints)").all()).toContainEqual(
        expect.objectContaining({
          table: "agent_context_checkpoints",
          from: "previous_checkpoint_id",
        })
      )
      const violations = db.query("PRAGMA foreign_key_check(agent_context_checkpoints)").all() as {
        parent: string
      }[]
      expect(
        violations.filter((violation) => violation.parent === "agent_context_checkpoints")
      ).toEqual([])

      insertCheckpoint("checkpoint-copy", "thread-2")
      expect(() => insertCheckpoint("checkpoint-again", "thread-1")).toThrow("UNIQUE")
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .all("agent_context_checkpoints")
      ).toContainEqual({ name: "idx_agent_context_checkpoints_thread_latest" })
    } finally {
      db.close()
    }
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

  describe("the migrated schema", () => {
    // Removal proof: drop the NOT NULL, the unique index or the reference a row names from the
    // migration that last rebuilt its table, and that row fails.
    test.each<{
      readonly table: string
      readonly required?: readonly string[]
      readonly optional?: readonly string[]
      readonly unique?: readonly (readonly string[])[]
      readonly restricts?: boolean
    }>([
      { table: "workflow_runs" },
      { table: "action_runs" },
      { table: "agent_runs" },
      { table: "workflow_agent_node_runs" },
      { table: "sync_runs", required: ["queued_at"], optional: ["started_at"] },
      { table: "pipeline_runs", required: ["queued_at"], optional: ["started_at"] },
      { table: "projection_runs", required: ["queued_at"], optional: ["started_at"] },
      {
        table: "webhook_runs",
        required: ["request_body_bytes", "request_body_sha256"],
        unique: [["project_id", "connector_id", "webhook_id", "idempotency_key"]],
        restricts: true,
      },
      {
        table: "ai_model_call_usage",
        unique: [["project_id", "execution_id", "attempt", "call_id", "response_id"]],
        restricts: true,
      },
    ])("$table rows each name one durable execution", ({
      table,
      required = [],
      optional = [],
      unique = [["project_id", "execution_id"]],
      restricts = false,
    }) => {
      const db = replayedDatabase()
      try {
        for (const column of ["execution_id", ...required]) {
          expect(readMemoryColumn(db, table, column)?.notnull, column).toBe(1)
        }
        for (const column of optional) {
          expect(readMemoryColumn(db, table, column)?.notnull, column).toBe(0)
        }
        expect(readMemoryUniqueIndexes(db, table)).toEqual(expect.arrayContaining(unique))
        if (restricts) {
          expect(readMemoryForeignKeys(db, table)).toContainEqual({
            from: "execution_id",
            onDelete: "RESTRICT",
            table: "executions",
            to: "id",
          })
        }
      } finally {
        db.close()
      }
    })

    test("keeps each execution's parent reference through every rebuild", () => {
      const db = replayedDatabase()
      try {
        expect(readMemoryForeignKeyTables(db, "executions")).toContain("executions")
        expect(readMemoryForeignKeyTables(db, "executions")).not.toContain("executions_v2")
      } finally {
        db.close()
      }
    })

    test("keeps no retired column or table", () => {
      const db = replayedDatabase()
      try {
        const retired: Record<string, readonly string[]> = {
          workflow_runs: [
            "source",
            "requested_by_principal_type",
            "requested_by_principal_id",
            "requester_group_ids",
          ],
          agent_runs: [
            "agent_id",
            "requested_by_principal_type",
            "execution_principal_type",
            "requester_group_ids",
            "usage_input_tokens",
            "usage_output_tokens",
            "usage_total_tokens",
            "usage_reasoning_tokens",
            "usage_cached_input_tokens",
          ],
          workflow_agent_node_runs: ["agent_id", "execution_principal_type", "usage"],
          agent_threads: ["agent_id"],
          webhook_runs: ["delivery_claim_result"],
          ai_model_call_usage: ["execution_kind", "requester_principal_id"],
          auth_sessions: ["audience"],
        }
        for (const [table, columns] of Object.entries(retired)) {
          const present = readMemoryTableColumns(db, table)
          for (const column of columns) expect(present, `${table}.${column}`).not.toContain(column)
        }
        const tables = readMemoryTableNames(db)
        expect(tables).not.toContain("webhook_deliveries")
        expect(tables).not.toContain("ai_price_schedules")
      } finally {
        db.close()
      }
    })

    test("indexes Share grant listing and session lookups", () => {
      const db = replayedDatabase()
      try {
        expect(readMemoryIndexColumns(db, "idx_share_grants_project_created")).toEqual([
          "project_id",
          "created_at",
          "id",
        ])
        expect(readMemoryIndexColumns(db, "idx_share_sessions_grant")).toEqual([
          "project_id",
          "grant_id",
          "created_at",
          "id",
        ])
        expect(readMemoryIndexColumns(db, "idx_share_sessions_expiry")).toEqual([
          "project_id",
          "expires_at",
        ])
      } finally {
        db.close()
      }
    })

    test("the timeseries primary key enforces the (series, at) natural key", () => {
      const db = replayedDatabase()
      try {
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

function readMemoryForeignKeyTables(db: Database, tableName: string): string[] {
  return (
    db.query(`PRAGMA foreign_key_list(${tableName})`).all() as { readonly table: string }[]
  ).map((foreignKey) => foreignKey.table)
}

function readMemoryForeignKeys(
  db: Database,
  tableName: string
): {
  readonly from: string
  readonly onDelete: string
  readonly table: string
  readonly to: string
}[] {
  const rows = db.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    readonly from: string
    readonly on_delete: string
    readonly table: string
    readonly to: string
  }>
  return rows.map(({ from, on_delete, table, to }) => ({ from, onDelete: on_delete, table, to }))
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
    const tempDir = await migratedDirectory()
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
})
