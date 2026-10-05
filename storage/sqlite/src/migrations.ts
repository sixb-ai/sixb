import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { StorageMigrator } from "@sixb/core"
import type {
  MigrationHistoryStore,
  MigrationRecord,
  MigrationSet,
  MigrationStep,
  MigrationStepOptions,
} from "@sixb/core/storage"
import {
  defineMigrations,
  describeMigrationHistory,
  runMigrationSet,
  step,
} from "@sixb/core/storage"
import initialSchemaSql from "./migrations/001-initial-schema.sql" with { type: "text" }
import workflowRunOutputSql from "./migrations/002-workflow-run-output.sql" with { type: "text" }
import mergeSyncRunsSql from "./migrations/003-merge-sync-runs.sql" with { type: "text" }
import executionsSql from "./migrations/004-executions.sql" with { type: "text" }
import workflowExecutionsSql from "./migrations/005-workflow-executions.sql" with { type: "text" }
import narrowOntologySourceRootIndexSql from "./migrations/006-narrow-ontology-source-root-index.sql" with {
  type: "text",
}
import splitOverridesSql from "./migrations/007-split-overrides.sql" with { type: "text" }
import actionExecutionsSql from "./migrations/008-action-executions.sql" with { type: "text" }
import agentExecutionsSql from "./migrations/009-agent-executions.sql" with { type: "text" }
import aiUsageAccountingFoundationSql from "./migrations/010-ai-usage-accounting-foundation.sql" with {
  type: "text",
}
import syncFailureRecordSql from "./migrations/011-sync-failure-record.sql" with { type: "text" }
import pipelineFailureRecordSql from "./migrations/012-pipeline-failure-record.sql" with {
  type: "text",
}
import workflowFailureRecordSql from "./migrations/013-workflow-failure-record.sql" with {
  type: "text",
}
import agentFailureRecordSql from "./migrations/014-agent-failure-record.sql" with { type: "text" }
import projectionFailureRecordSql from "./migrations/015-projection-failure-record.sql" with {
  type: "text",
}
import webhookRunFailureRecordSql from "./migrations/016-webhook-run-failure-record.sql" with {
  type: "text",
}
import actionFailureRecordSql from "./migrations/017-action-failure-record.sql" with {
  type: "text",
}
import ontologyOutboxFailureRecordSql from "./migrations/018-ontology-outbox-failure-record.sql" with {
  type: "text",
}
import webhookDeliveryFailureRecordSql from "./migrations/019-webhook-delivery-failure-record.sql" with {
  type: "text",
}
import dropRunUsageProjectionsSql from "./migrations/020-drop-run-usage-projections.sql" with {
  type: "text",
}
import syncPipelineExecutionsSql from "./migrations/021-sync-pipeline-executions.sql" with {
  type: "text",
}
import projectionExecutionsSql from "./migrations/022-projection-executions.sql" with {
  type: "text",
}
import webhookExecutionsSql from "./migrations/023-webhook-executions.sql" with { type: "text" }
import ontologyCommitExecutionsSql from "./migrations/024-ontology-commit-executions.sql" with {
  type: "text",
}
import connectorConnectionsSql from "./migrations/025-connector-connections.sql" with {
  type: "text",
}
import aiCostAccountingSql from "./migrations/026-ai-cost-accounting.sql" with { type: "text" }
import agentContextCheckpointsSql from "./migrations/027-agent-context-checkpoints.sql" with {
  type: "text",
}
import objectOverrideEditTimesSql from "./migrations/028-object-override-edit-times.sql" with {
  type: "text",
}
import modelAccountingSql from "./migrations/029-model-accounting.sql" with { type: "text" }
import aiUsageLimitsSql from "./migrations/030-ai-usage-limits.sql" with { type: "text" }
import subagentRunsSql from "./migrations/031-subagent-runs.sql" with { type: "text" }
import conversationRunSpecSql from "./migrations/032-conversation-run-spec.sql" with {
  type: "text",
}
import retireAgentDefinitionsSql from "./migrations/033-retire-agent-definitions.sql" with {
  type: "text",
}
import deviceAuthorizationsSql from "./migrations/034-device-authorizations.sql" with {
  type: "text",
}
import shareGrantsSql from "./migrations/035-share-grants.sql" with { type: "text" }
import shareSessionsSql from "./migrations/036-share-sessions.sql" with { type: "text" }
import projectionSourceRootsSql from "./migrations/038-projection-source-roots.sql" with {
  type: "text",
}
import outboxPublicationOrderSql from "./migrations/040-outbox-publication-order.sql" with {
  type: "text",
}
import agentThreadWorkspacesSql from "./migrations/041-agent-thread-workspaces.sql" with {
  type: "text",
}
import vectorProfilesSql from "./migrations/042-vector-profiles.sql" with { type: "text" }
import vectorIndexingSql from "./migrations/043-vector-indexing.sql" with { type: "text" }
import vectorBatchingSql from "./migrations/044-vector-batching.sql" with { type: "text" }
import agentThreadSandboxStateSql from "./migrations/045-agent-thread-sandbox-state.sql" with {
  type: "text",
}
import workflowInterventionPrincipalsSql from "./migrations/046-workflow-intervention-principals.sql" with {
  type: "text",
}
import ontologyCommitAttributionSql from "./migrations/047-ontology-commit-attribution.sql" with {
  type: "text",
}
import nativeSessionsSql from "./migrations/049-native-sessions.sql" with { type: "text" }
import directoryGroupMembershipsSql from "./migrations/050-directory-group-memberships.sql" with {
  type: "text",
}
import projectionRunSupersessionSql from "./migrations/051-projection-run-supersession.sql" with {
  type: "text",
}
import compactSourceStorageSql from "./migrations/052-compact-source-storage.sql" with {
  type: "text",
}
import replacementPlansSql from "./migrations/053-replacement-plans.sql" with { type: "text" }
import slimOntologyOutboxSql from "./migrations/054-slim-ontology-outbox.sql" with { type: "text" }
import commitTouchesSql from "./migrations/055-commit-touches.sql" with { type: "text" }

const MIGRATIONS_TABLE_SQL = `
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
`

export const SQLITE_STORAGE_ADAPTER_ID = "SixbSqliteStorage"
export const SQLITE_STORAGE_FILE = "storage.sqlite"

export const sqliteStorageMigrations = defineMigrations({
  adapterId: SQLITE_STORAGE_ADAPTER_ID,
  steps: [
    sqliteSql("001-initial-schema", initialSchemaSql),
    sqliteSql("002-workflow-run-output", workflowRunOutputSql),
    sqliteSql("003-merge-sync-runs", mergeSyncRunsSql),
    sqliteSql("004-executions", executionsSql),
    sqliteSql("005-workflow-executions", workflowExecutionsSql),
    sqliteSql("006-narrow-ontology-source-root-index", narrowOntologySourceRootIndexSql),
    sqliteSql("007-split-overrides", splitOverridesSql),
    sqliteSql("008-action-executions", actionExecutionsSql),
    sqliteSql("009-agent-executions", agentExecutionsSql),
    sqliteSql("010-ai-usage-accounting-foundation", aiUsageAccountingFoundationSql),
    sqliteSql("011-sync-failure-record", syncFailureRecordSql),
    sqliteSql("012-pipeline-failure-record", pipelineFailureRecordSql),
    sqliteSql("013-workflow-failure-record", workflowFailureRecordSql),
    sqliteSql("014-agent-failure-record", agentFailureRecordSql),
    sqliteSql("015-projection-failure-record", projectionFailureRecordSql),
    sqliteSql("016-webhook-run-failure-record", webhookRunFailureRecordSql),
    sqliteSql("017-action-failure-record", actionFailureRecordSql),
    sqliteSql("018-ontology-outbox-failure-record", ontologyOutboxFailureRecordSql),
    sqliteSql("019-webhook-delivery-failure-record", webhookDeliveryFailureRecordSql),
    sqliteSql("020-drop-run-usage-projections", dropRunUsageProjectionsSql),
    sqliteSql("021-sync-pipeline-executions", syncPipelineExecutionsSql),
    sqliteStep(
      "022-projection-executions",
      (db) => {
        if (db.query("SELECT 1 FROM projection_runs LIMIT 1").get()) {
          throw new Error(
            "[SixbSqliteStorage] Projection execution migration cannot preserve legacy runs with unknown authority."
          )
        }
        db.run(projectionExecutionsSql)
      },
      { checksum: checksum(projectionExecutionsSql) }
    ),
    sqliteStep(
      "023-webhook-executions",
      (db) => {
        const hasRuns = db.query("SELECT 1 FROM webhook_runs LIMIT 1").get()
        const hasDeliveries = db.query("SELECT 1 FROM webhook_deliveries LIMIT 1").get()
        if (hasRuns || hasDeliveries) {
          throw new Error(
            "[SixbSqliteStorage] Webhook execution migration cannot preserve legacy runs or deliveries with unknown authority."
          )
        }
        db.run(webhookExecutionsSql)
      },
      { checksum: checksum(webhookExecutionsSql) }
    ),
    sqliteStep(
      "024-ontology-commit-executions",
      (db) => {
        if (db.query("SELECT 1 FROM ontology_commits LIMIT 1").get()) {
          throw new Error(
            "[SixbSqliteStorage] Ontology commit execution migration cannot preserve commits with unknown authority."
          )
        }
        db.run(ontologyCommitExecutionsSql)
      },
      { checksum: checksum(ontologyCommitExecutionsSql) }
    ),
    sqliteSql("025-connector-connections", connectorConnectionsSql),
    sqliteSql("026-ai-cost-accounting", aiCostAccountingSql),
    sqliteSql("027-agent-context-checkpoints", agentContextCheckpointsSql),
    sqliteSql("028-object-override-edit-times", objectOverrideEditTimesSql),
    sqliteSql("029-model-accounting", modelAccountingSql),
    sqliteSql("030-ai-usage-limits", aiUsageLimitsSql),
    sqliteSql("031-subagent-runs", subagentRunsSql),
    sqliteSql("032-conversation-run-spec", conversationRunSpecSql),
    sqliteSql("033-retire-agent-definitions", retireAgentDefinitionsSql),
    sqliteSql("034-device-authorizations", deviceAuthorizationsSql),
    sqliteSql("035-share-grants", shareGrantsSql),
    sqliteSql("036-share-sessions", shareSessionsSql),
    sqliteSql("037-execution-requester-groups", executionRequesterGroupsSql),
    sqliteSql("038-projection-source-roots", projectionSourceRootsSql),
    sqliteSql("039-connector-optional-pkce", connectorOptionalPkceSql),
    sqliteSql("040-outbox-publication-order", outboxPublicationOrderSql),
    sqliteSql("041-agent-thread-workspaces", agentThreadWorkspacesSql),
    sqliteSql("042-vector-profiles", vectorProfilesSql),
    sqliteSql("043-vector-indexing", vectorIndexingSql),
    sqliteSql("044-vector-batching", vectorBatchingSql),
    sqliteSql("045-agent-thread-sandbox-state", agentThreadSandboxStateSql),
    sqliteSql("046-workflow-intervention-principals", workflowInterventionPrincipalsSql),
    sqliteSql("047-ontology-commit-attribution", ontologyCommitAttributionSql),
    sqliteSql("048-file-upload-sessions", fileUploadSessionsSql),
    sqliteSql("049-native-sessions", nativeSessionsSql),
    sqliteSql("050-directory-group-memberships", directoryGroupMembershipsSql),
    sqliteSql("051-projection-run-supersession", projectionRunSupersessionSql),
    sqliteStep(
      "052-compact-source-storage",
      (db) => {
        // SQLite has no procedural block to check the copy in SQL: count around it instead.
        const before = sourceStorageCounts(db)
        db.run(compactSourceStorageSql)
        const after = sourceStorageCounts(db)
        if (
          after.versions !== before.versions ||
          after.roots !== before.roots ||
          after.rows !== before.rows
        ) {
          throw new Error(
            "[SixbSqliteStorage] Source versions, roots or rows were lost while compacting source storage."
          )
        }
      },
      { checksum: checksum(compactSourceStorageSql) }
    ),
    sqliteSql("053-replacement-plans", replacementPlansSql),
    sqliteStep(
      "054-slim-ontology-outbox",
      (db) => {
        // SQLite has no procedural block to refuse the conversion in SQL: check before it.
        const mismatched = unrebuildableOutboxEvents(db)
        if (mismatched > 0) {
          throw new Error(
            `[SixbSqliteStorage] ${mismatched} outbox events would not rebuild from their commit.`
          )
        }
        db.run(slimOntologyOutboxSql)
      },
      { checksum: checksum(slimOntologyOutboxSql) }
    ),
    sqliteSql("055-commit-touches", commitTouchesSql),
  ],
})

export function sqliteStoragePath(basePath: string): string {
  return `${basePath}/${SQLITE_STORAGE_FILE}`
}

export function sqliteSql(id: string, sqlText: string): MigrationStep<Database> {
  return sqliteStep(
    id,
    (db) => {
      db.run(sqlText)
    },
    { checksum: checksum(sqlText) }
  )
}

export function sqliteStep(
  id: string,
  up: (db: Database) => void | Promise<void>,
  options: MigrationStepOptions = {}
): MigrationStep<Database> {
  return step<Database>(id, up, options)
}

export function installFreshSqliteSchema(db: Database): void {
  for (const migration of sqliteStorageMigrations.steps) {
    const installed = migration.up(db)
    if (installed instanceof Promise) {
      throw new Error(
        `[${sqliteStorageMigrations.adapterId}] Fresh SQLite schema installation must be synchronous`
      )
    }
  }
}

export function createSqliteStorageMigrators(basePath: string): readonly StorageMigrator[] {
  return [
    createSqliteMigrator({
      path: sqliteStoragePath(basePath),
      migrations: sqliteStorageMigrations,
    }),
  ]
}

export function createSqliteMigrator(params: {
  readonly path: string
  readonly migrations: MigrationSet<Database>
}): StorageMigrator {
  return {
    adapterId: params.migrations.adapterId,
    latestVersion: params.migrations.latestVersion,
    async status() {
      return describeMigrationHistory({
        migrations: params.migrations,
        rows: await readSqliteHistory(params.path, params.migrations.adapterId),
      })
    },
    async migrate() {
      return withSqliteDatabase(params.path, (db) =>
        runMigrationSet({
          context: db,
          migrations: params.migrations,
          state: sqliteMigrationHistoryStore(db),
        })
      )
    },
  }
}

export async function migrateSqliteStorage(basePath: string): Promise<void> {
  mkdirSync(basePath, { recursive: true })

  for (const migrator of createSqliteStorageMigrators(basePath)) {
    await migrator.migrate()
  }
}

function sqliteMigrationHistoryStore(db: Database): MigrationHistoryStore {
  return {
    ensure() {
      db.run(MIGRATIONS_TABLE_SQL)
    },
    readHistory(adapterId) {
      return db
        .query("SELECT * FROM sixb_migrations WHERE adapter_id = ? ORDER BY version")
        .all(adapterId)
        .map(rowToMigrationRecord)
    },
    markStarted(adapterId, migration, at) {
      db.query(`
        INSERT INTO sixb_migrations (
          adapter_id, version, id, checksum, status, started_at, finished_at
        ) VALUES (?, ?, ?, ?, 'started', ?, NULL)
        ON CONFLICT(adapter_id, version) DO UPDATE SET
          id = excluded.id,
          checksum = excluded.checksum,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = NULL
      `).run(adapterId, migration.version, migration.id, migration.checksum ?? null, at)
    },
    markApplied(adapterId, migration, at) {
      db.query(`
        UPDATE sixb_migrations
        SET status = 'applied', finished_at = ?
        WHERE adapter_id = ? AND version = ?
      `).run(at, adapterId, migration.version)
    },
    async transaction(run) {
      // SQLite cannot rebuild a referenced parent table while foreign-key enforcement is active,
      // even when the replacement satisfies every deferred reference. Migrations therefore run
      // with enforcement paused, validate the complete schema before commit, then restore it.
      db.run("PRAGMA foreign_keys = OFF")
      db.run("BEGIN")

      try {
        const result = await run()
        const violations = db.query("PRAGMA foreign_key_check").all()
        if (violations.length > 0) {
          throw new Error(
            `[${SQLITE_STORAGE_ADAPTER_ID}] Migration produced ${violations.length} foreign-key violation(s).`
          )
        }
        db.run("COMMIT")
        return result
      } catch (error) {
        rollbackQuietly(db)
        throw error
      } finally {
        db.run("PRAGMA foreign_keys = ON")
      }
    },
  }
}

function rowToMigrationRecord(row: unknown): MigrationRecord {
  const migration = row as {
    adapter_id: string
    version: number
    id: string
    checksum: string | null
    status: "started" | "applied"
    started_at: string
    finished_at: string | null
  }

  return {
    adapterId: migration.adapter_id,
    version: migration.version,
    id: migration.id,
    checksum: migration.checksum ?? undefined,
    status: migration.status,
    startedAt: migration.started_at,
    finishedAt: migration.finished_at ?? undefined,
  }
}

function sourceStorageCounts(db: Database): {
  readonly versions: number
  readonly roots: number
  readonly rows: number
} {
  return db
    .query(`SELECT (SELECT count(*) FROM ontology_sources) AS versions,
      (SELECT count(*) FROM ontology_source_roots) AS roots,
      (SELECT count(*) FROM ontology_source_rows) AS rows`)
    .get() as { readonly versions: number; readonly roots: number; readonly rows: number }
}

/**
 * Stored events that would not rebuild exactly from their commit and execution. Who asked and what
 * wrote are derived from the execution exactly as 047 derived the commit's copies; both sides were
 * written as canonical JSON, so equal JSON compares as equal text.
 */
function unrebuildableOutboxEvents(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS mismatched
       FROM ontology_outbox AS outbox
       LEFT JOIN ontology_commits AS commits
         ON commits.project_id = outbox.project_id AND commits.id = outbox.commit_id
       LEFT JOIN executions
         ON executions.project_id = commits.project_id AND executions.id = commits.execution_id
       WHERE executions.id IS NULL
         OR outbox.envelope ->> '$.id' IS NOT outbox.id
         OR outbox.envelope ->> '$.commitOrdinal' IS NOT outbox.commit_ordinal
         OR outbox.envelope ->> '$.commitId' IS NOT commits.id
         OR outbox.envelope ->> '$.projectId' IS NOT commits.project_id
         OR outbox.envelope ->> '$.schemaVersion' IS NOT 1
         OR outbox.envelope ->> '$.occurredAt' IS NOT commits.committed_at
         OR outbox.envelope -> '$.origin' IS NOT json(commits.origin)
         OR outbox.envelope ->> '$.correlationId' IS NOT executions.correlation_id
         OR outbox.envelope -> '$.requestedBy' IS NOT CASE
           WHEN executions.requested_by_user_id IS NOT NULL
             THEN json_object('id', executions.requested_by_user_id, 'type', 'user')
           WHEN executions.requested_by_service_account_id IS NOT NULL
             THEN json_object('id', executions.requested_by_service_account_id, 'type', 'serviceAccount')
         END
         OR outbox.envelope -> '$.executor' IS NOT CASE executions.executor_kind
           WHEN 'request' THEN json_object('requestId', executions.executor_id, 'type', 'request')
           WHEN 'agent' THEN json_object('runId', executions.executor_id, 'type', 'agent')
           WHEN 'kernel' THEN json_object(
             'operation',
             CASE executions.authority_kernel_operation
               WHEN 'ontology.recover'
                 THEN json_object('recoveryId', executions.executor_id, 'type', 'ontology.recover')
               ELSE json_object('indexingId', executions.executor_id, 'type', 'ontology.indexVectors')
             END,
             'type', 'kernel'
           )
           ELSE json_object(
             'id', executions.authority_primitive_id,
             'kind', executions.executor_kind,
             'runId', executions.executor_id,
             'type', 'primitive'
           )
         END
         OR outbox.envelope ->> '$.topic' IS NOT CASE substr(outbox.envelope ->> '$.type', 1, 4)
           WHEN 'obje' THEN 'objects'
           WHEN 'link' THEN 'links'
           WHEN 'tele' THEN 'telemetry'
         END
         OR outbox.envelope ->> '$.partitionKey' IS NOT CASE outbox.envelope ->> '$.topic'
           WHEN 'objects' THEN (outbox.envelope ->> '$.payload.objectTypeId') || ':' ||
             (outbox.envelope ->> '$.payload.primaryId')
           WHEN 'links' THEN (outbox.envelope ->> '$.payload.sourceTypeId') || ':' ||
             (outbox.envelope ->> '$.payload.sourceId') || ':' ||
             (outbox.envelope ->> '$.payload.linkId')
           WHEN 'telemetry' THEN (outbox.envelope ->> '$.payload.objectTypeId') || ':' ||
             (outbox.envelope ->> '$.payload.objectId') || ':' ||
             (outbox.envelope ->> '$.payload.propertyId')
         END
         OR (
           outbox.envelope ->> '$.type' IN ('object.created', 'link.created')
           AND (
             (SELECT COUNT(*) FROM json_each(outbox.envelope, '$.payload.propertyChanges'))
               IS NOT (SELECT COUNT(*) FROM json_each(outbox.envelope, '$.payload.properties'))
             OR EXISTS (
               SELECT 1
               FROM json_each(outbox.envelope, '$.payload.propertyChanges') AS change
               LEFT JOIN json_each(outbox.envelope, '$.payload.properties') AS property
                 ON property.key = change.key
               WHERE property.key IS NULL
                 OR change.value ->> '$.operation' IS NOT 'created'
                 OR json_type(change.value, '$.after') IS NOT property.type
                 OR change.value ->> '$.after' IS NOT property.value
                 OR (SELECT COUNT(*) FROM json_each(change.value)) IS NOT 2
             )
           )
         )`
    )
    .get() as { readonly mismatched: number }
  return row.mismatched
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Reads migration history without creating anything. `null` means there is no history
 * to read, which is a state and not a failure.
 *
 * `new Database(path)` creates the file, and `withSqliteDatabase` additionally mkdirs
 * its parent — fine on the way to a migration, wrong for a probe. So: `existsSync`
 * first, then open `readonly` so even a mistake below cannot write. `:memory:` is
 * always empty on a fresh connection, so there is nothing to report.
 */
async function readSqliteHistory(
  path: string,
  adapterId: string
): Promise<readonly MigrationRecord[] | null> {
  if (path === ":memory:" || !existsSync(path)) {
    return null
  }

  const db = new Database(path, { readonly: true })
  try {
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sixb_migrations'")
      .get()
    if (!table) {
      return null
    }

    return db
      .query("SELECT * FROM sixb_migrations WHERE adapter_id = ? ORDER BY version")
      .all(adapterId)
      .map(rowToMigrationRecord)
  } finally {
    db.close()
  }
}

async function withSqliteDatabase<T>(path: string, run: (db: Database) => Promise<T>): Promise<T> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)

  try {
    return await run(db)
  } finally {
    db.close()
  }
}

function rollbackQuietly(db: Database): void {
  try {
    db.run("ROLLBACK")
  } catch {
    // Ignore rollback errors so the original migration failure is preserved.
  }
}

import executionRequesterGroupsSql from "./migrations/037-execution-requester-groups.sql" with {
  type: "text",
}

import connectorOptionalPkceSql from "./migrations/039-connector-optional-pkce.sql" with {
  type: "text",
}
import fileUploadSessionsSql from "./migrations/048-file-upload-sessions.sql" with { type: "text" }
