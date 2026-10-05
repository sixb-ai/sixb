import { createHash } from "node:crypto"
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
import projectionSourceRootsSql from "./migrations/039-projection-source-roots.sql" with {
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
import objectQueryPreparationSql from "./migrations/055-object-query-preparation.sql" with {
  type: "text",
}
import commitTouchesSql from "./migrations/056-commit-touches.sql" with { type: "text" }
import audioTranscriptionSql from "./migrations/057-audio-transcription.sql" with { type: "text" }
import rerankingModelKindSql from "./migrations/058-reranking-model-kind.sql" with { type: "text" }
import type { ReservedSQL, SQL, SQLClient } from "./pg-client"
import { runPgTransactionOn, undoOnFailure, withReservedPgConnection } from "./transactions"

export interface PostgresMigrationContext {
  exec(sqlText: string): Promise<void>
}

export const POSTGRES_STORAGE_ADAPTER_ID = "SixbPostgresStorage"

export function pgSql(id: string, sqlText: string): MigrationStep<PostgresMigrationContext> {
  return pgStep(id, (context) => context.exec(sqlText), { checksum: checksum(sqlText) })
}

export function pgStep(
  id: string,
  up: (context: PostgresMigrationContext) => void | Promise<void>,
  options: MigrationStepOptions = {}
): MigrationStep<PostgresMigrationContext> {
  return step<PostgresMigrationContext>(id, up, options)
}

export function createPostgresStorageMigrators(
  sql: SQL,
  schemaName: string
): readonly StorageMigrator[] {
  return [
    createPostgresMigrator({
      sql,
      schemaName,
      migrations: postgresStorageMigrations,
    }),
  ]
}

export function createPostgresMigrator(params: {
  readonly sql: SQL
  readonly schemaName: string
  readonly migrations: MigrationSet<PostgresMigrationContext>
}): StorageMigrator {
  return {
    adapterId: params.migrations.adapterId,
    latestVersion: params.migrations.latestVersion,
    async status() {
      return describeMigrationHistory({
        migrations: params.migrations,
        rows: await readPostgresHistory(params.sql, params.schemaName, params.migrations.adapterId),
      })
    },
    migrate() {
      return withPostgresMigrationLock(params, async (sql) => {
        const session = postgresMigrationSession(sql, params.schemaName)
        return runMigrationSet({
          context: session.context,
          migrations: params.migrations,
          state: session.state,
        })
      })
    },
  }
}

export async function migratePostgresStorage(sql: SQL, schemaName: string): Promise<void> {
  await createPostgresMigrator({
    sql,
    schemaName,
    migrations: postgresStorageMigrations,
  }).migrate()
}

export async function dropSchema(sql: SQL, schemaName: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
}

export function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`[SixbPg] Invalid identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function postgresMigrationSession(
  sql: ReservedSQL,
  schemaName: string
): { context: PostgresMigrationContext; state: MigrationHistoryStore } {
  const schema = quoteIdent(schemaName)
  const migrationsTable = `${schema}.sixb_migrations`
  // Migration steps receive a stable context; route exec() through the active transaction.
  let active: SQLClient | null = null
  const connection = (): SQLClient => active ?? sql

  return {
    context: {
      async exec(sqlText) {
        await connection().unsafe(sqlText)
      },
    },
    state: {
      async ensure() {
        await sql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS ${schema};

          CREATE TABLE IF NOT EXISTS ${migrationsTable} (
            adapter_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            id TEXT NOT NULL,
            checksum TEXT,
            status TEXT NOT NULL CHECK (status IN ('started', 'applied')),
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ,
            PRIMARY KEY (adapter_id, version)
          );
        `)
      },
      async readHistory(adapterId) {
        const rows = await sql.unsafe<PostgresMigrationRow[]>(
          `SELECT * FROM ${migrationsTable} WHERE adapter_id = $1 ORDER BY version`,
          [adapterId]
        )
        return rows.map(rowToMigrationRecord)
      },
      async markStarted(adapterId, migration, at) {
        await connection().unsafe(
          `
            INSERT INTO ${migrationsTable} (
              adapter_id, version, id, checksum, status, started_at, finished_at
            ) VALUES ($1, $2, $3, $4, 'started', $5, NULL)
            ON CONFLICT(adapter_id, version) DO UPDATE SET
              id = excluded.id,
              checksum = excluded.checksum,
              status = excluded.status,
              started_at = excluded.started_at,
              finished_at = NULL
          `,
          [adapterId, migration.version, migration.id, migration.checksum ?? null, at]
        )
      },
      async markApplied(adapterId, migration, at) {
        await connection().unsafe(
          `
            UPDATE ${migrationsTable}
            SET status = 'applied', finished_at = $1
            WHERE adapter_id = $2 AND version = $3
          `,
          [at, adapterId, migration.version]
        )
      },
      async transaction(run) {
        // `sql` is the reserved connection holding the migration advisory lock. porsager's
        // `.begin` would open the transaction on another pool connection, so drive it on this one
        // and route exec()/markStarted()/markApplied() through it via `active`.
        const previous = active
        active = sql
        try {
          return await runPgTransactionOn(sql, async () => {
            await sql.unsafe(`SET LOCAL search_path TO ${schema}`)
            return run()
          })
        } finally {
          active = previous
        }
      },
    },
  }
}

/**
 * Reads migration history without DDL and without the advisory lock. `null` means the
 * history table does not exist, which is a state and not a failure.
 *
 * `migrate()` cannot be used for this: it calls `ensure()` first, so it runs
 * `CREATE SCHEMA`/`CREATE TABLE` and reserves a connection to hold
 * `pg_advisory_lock`. A probe must need no DDL grant — `/ready` is public and
 * unauthenticated — and must not serialize N replicas behind one lock.
 *
 * `to_regclass` returns NULL for a missing relation (including a missing schema)
 * instead of raising, and needs no catalog privileges.
 */
async function readPostgresHistory(
  sql: SQL,
  schemaName: string,
  adapterId: string
): Promise<readonly MigrationRecord[] | null> {
  const schema = quoteIdent(schemaName)
  const probe = await sql.unsafe<{ oid: string | null }[]>(`SELECT to_regclass($1) AS oid`, [
    `${schema}.sixb_migrations`,
  ])
  if (!probe[0]?.oid) {
    return null
  }

  const rows = await sql.unsafe<PostgresMigrationRow[]>(
    `SELECT * FROM ${schema}.sixb_migrations WHERE adapter_id = $1 ORDER BY version`,
    [adapterId]
  )
  return rows.map(rowToMigrationRecord)
}

async function withPostgresMigrationLock<T>(
  params: {
    readonly sql: SQL
    readonly schemaName: string
    readonly migrations: MigrationSet<PostgresMigrationContext>
  },
  run: (sql: ReservedSQL) => Promise<T>
): Promise<T> {
  const [first, second] = advisoryLockParts(
    `storage:migration:${params.schemaName}:${params.migrations.adapterId}`
  )

  // A session-level lock outlives any transaction, so it is released before the connection goes
  // back to the pool — except when the connection was lost, which already released it.
  return withReservedPgConnection(params.sql, async (sql) => {
    const unlock = () => sql`SELECT pg_advisory_unlock(${first}, ${second})`
    await sql`SELECT pg_advisory_lock(${first}, ${second})`
    const result = await undoOnFailure(() => run(sql), unlock)
    await unlock()
    return result
  })
}

function advisoryLockParts(key: string): readonly [number, number] {
  const hash = createHash("sha256").update(key).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

function rowToMigrationRecord(row: PostgresMigrationRow): MigrationRecord {
  return {
    adapterId: row.adapter_id,
    version: row.version,
    id: row.id,
    checksum: row.checksum ?? undefined,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export const postgresStorageMigrations = defineMigrations<PostgresMigrationContext>({
  adapterId: POSTGRES_STORAGE_ADAPTER_ID,
  steps: [
    pgSql("001-initial-schema", initialSchemaSql),
    pgSql("002-workflow-run-output", workflowRunOutputSql),
    pgSql("003-merge-sync-runs", mergeSyncRunsSql),
    pgSql("004-executions", executionsSql),
    pgSql("005-workflow-executions", workflowExecutionsSql),
    pgSql("006-narrow-ontology-source-root-index", narrowOntologySourceRootIndexSql),
    pgSql("007-split-overrides", splitOverridesSql),
    pgSql("008-action-executions", actionExecutionsSql),
    pgSql("009-agent-executions", agentExecutionsSql),
    pgSql("010-ai-usage-accounting-foundation", aiUsageAccountingFoundationSql),
    pgSql("011-sync-failure-record", syncFailureRecordSql),
    pgSql("012-pipeline-failure-record", pipelineFailureRecordSql),
    pgSql("013-workflow-failure-record", workflowFailureRecordSql),
    pgSql("014-agent-failure-record", agentFailureRecordSql),
    pgSql("015-projection-failure-record", projectionFailureRecordSql),
    pgSql("016-webhook-run-failure-record", webhookRunFailureRecordSql),
    pgSql("017-action-failure-record", actionFailureRecordSql),
    pgSql("018-ontology-outbox-failure-record", ontologyOutboxFailureRecordSql),
    pgSql("019-webhook-delivery-failure-record", webhookDeliveryFailureRecordSql),
    pgSql("020-drop-run-usage-projections", dropRunUsageProjectionsSql),
    pgSql("021-sync-pipeline-executions", syncPipelineExecutionsSql),
    pgSql("022-projection-executions", projectionExecutionsSql),
    pgSql("023-webhook-executions", webhookExecutionsSql),
    pgSql("024-ontology-commit-executions", ontologyCommitExecutionsSql),
    pgSql("025-connector-connections", connectorConnectionsSql),
    pgSql("026-ai-cost-accounting", aiCostAccountingSql),
    pgSql("027-agent-context-checkpoints", agentContextCheckpointsSql),
    pgSql("028-object-override-edit-times", objectOverrideEditTimesSql),
    pgSql("029-model-accounting", modelAccountingSql),
    pgSql("030-ai-usage-limits", aiUsageLimitsSql),
    pgSql("031-subagent-runs", subagentRunsSql),
    pgSql("032-conversation-run-spec", conversationRunSpecSql),
    pgSql("033-retire-agent-definitions", retireAgentDefinitionsSql),
    pgSql("034-device-authorizations", deviceAuthorizationsSql),
    pgSql("035-share-grants", shareGrantsSql),
    pgSql("036-share-sessions", shareSessionsSql),
    pgSql("037-execution-requester-groups", executionRequesterGroupsSql),
    pgSql("038-outbox-publication-order", outboxPublicationOrderSql),
    pgSql("039-projection-source-roots", projectionSourceRootsSql),
    pgSql("040-connector-optional-pkce", connectorOptionalPkceSql),
    pgSql("041-agent-thread-workspaces", agentThreadWorkspacesSql),
    pgSql("042-vector-profiles", vectorProfilesSql),
    pgSql("043-vector-indexing", vectorIndexingSql),
    pgSql("044-vector-batching", vectorBatchingSql),
    pgSql("045-agent-thread-sandbox-state", agentThreadSandboxStateSql),
    pgSql("046-workflow-intervention-principals", workflowInterventionPrincipalsSql),
    pgSql("047-ontology-commit-attribution", ontologyCommitAttributionSql),
    pgSql("048-file-upload-sessions", fileUploadSessionsSql),
    pgSql("049-native-sessions", nativeSessionsSql),
    pgSql("050-directory-group-memberships", directoryGroupMembershipsSql),
    pgSql("051-projection-run-supersession", projectionRunSupersessionSql),
    pgSql("052-compact-source-storage", compactSourceStorageSql),
    pgSql("053-replacement-plans", replacementPlansSql),
    pgSql("054-slim-ontology-outbox", slimOntologyOutboxSql),
    pgSql("055-object-query-preparation", objectQueryPreparationSql),
    pgSql("056-commit-touches", commitTouchesSql),
    pgSql("057-audio-transcription", audioTranscriptionSql),
    pgSql("058-reranking-model-kind", rerankingModelKindSql),
    pgSql("059-file-download-grants", fileDownloadGrantsSql),
  ],
})

interface PostgresMigrationRow {
  readonly adapter_id: string
  readonly version: number
  readonly id: string
  readonly checksum: string | null
  readonly status: MigrationRecord["status"]
  readonly started_at: Date | string
  readonly finished_at: Date | string | null
}

import executionRequesterGroupsSql from "./migrations/037-execution-requester-groups.sql" with {
  type: "text",
}
import outboxPublicationOrderSql from "./migrations/038-outbox-publication-order.sql" with {
  type: "text",
}

import connectorOptionalPkceSql from "./migrations/040-connector-optional-pkce.sql" with {
  type: "text",
}
import fileUploadSessionsSql from "./migrations/048-file-upload-sessions.sql" with { type: "text" }
import fileDownloadGrantsSql from "./migrations/059-file-download-grants.sql" with { type: "text" }
