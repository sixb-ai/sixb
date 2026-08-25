import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { parseActionRunFailure } from "@sixb/core/internal/action-run-storage"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  AGENT_RUN_FAILURE_CODES,
  ONTOLOGY_OUTBOX_FAILURE_CODES,
  PIPELINE_RUN_FAILURE_CODES,
  PROJECTION_RUN_FAILURE_CODES,
  SYNC_RUN_FAILURE_CODES,
  WEBHOOK_RUN_FAILURE_CODES,
  WORKFLOW_RUN_FAILURE_CODES,
} from "@sixb/core/storage"
import { SqliteStorage } from "../src"
import {
  createSqliteStorageMigrators,
  SQLITE_STORAGE_ADAPTER_ID,
  sqliteStorageMigrations,
  sqliteStoragePath,
} from "../src/migrations"
import { SqliteMaterializationStateReader } from "../src/ontology-storage/materialization-state"

const tempDirs: string[] = []
const LEGACY_WEBHOOK_DELIVERY_FAILURE_CODES = ["webhook.delivery_failed"] as const
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
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "011-sync-failure-record",
    status: "applied",
    version: 11,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "012-pipeline-failure-record",
    status: "applied",
    version: 12,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "013-workflow-failure-record",
    status: "applied",
    version: 13,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "014-agent-failure-record",
    status: "applied",
    version: 14,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "015-projection-failure-record",
    status: "applied",
    version: 15,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "016-webhook-run-failure-record",
    status: "applied",
    version: 16,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "017-action-failure-record",
    status: "applied",
    version: 17,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "018-ontology-outbox-failure-record",
    status: "applied",
    version: 18,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "019-webhook-delivery-failure-record",
    status: "applied",
    version: 19,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "020-drop-run-usage-projections",
    status: "applied",
    version: 20,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "021-sync-pipeline-executions",
    status: "applied",
    version: 21,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "022-projection-executions",
    status: "applied",
    version: 22,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "023-webhook-executions",
    status: "applied",
    version: 23,
  },
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "024-ontology-commit-executions",
    status: "applied",
    version: 24,
  },
  {
    adapter_id: "SixbSqliteStorage",
    checksum_length: 64,
    id: "025-agent-run-requester-authorization",
    status: "applied",
    version: 25,
  },
  {
    adapter_id: "SixbSqliteStorage",
    checksum_length: 64,
    id: "026-agent-delegated-authority",
    status: "applied",
    version: 26,
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

  test("delegated-authority migration preserves existing executions and admits both forms", () => {
    const db = new Database(":memory:")
    try {
      // Everything up to (but not including) 026.
      for (const step of sqliteStorageMigrations.steps.slice(0, 25)) {
        step.up(db)
      }
      db.query(
        `INSERT INTO auth_users (project_id, id, email, status, created_at, updated_at)
         VALUES ('p', 'usr_ada', 'ada@example.com', 'active', '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z')`
      ).run()
      db.query(
        `INSERT INTO auth_service_accounts
           (project_id, id, name, status, created_by_principal_type, created_by_principal_id, created_at, updated_at)
         VALUES ('p', 'svc_agent_main', 'Main', 'active', 'system', 'system', '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z')`
      ).run()
      const insertExecution = (id: string, authorityColumn: string, authorityValue: string) =>
        db
          .query(
            `INSERT INTO executions (
               project_id, id, executor_kind, executor_id, source_kind, source_id,
               requested_by_user_id, correlation_id, authority_kind, ${authorityColumn}, created_at
             ) VALUES ('p', ?, 'agent', ?, 'event', ?, 'usr_ada', 'corr', 'principal', ?, '2026-08-25T10:00:00.000Z')`
          )
          .run(id, `run-${id}`, `event-${id}`, authorityValue)

      insertExecution("exec_own", "authority_service_account_id", "svc_agent_main")
      // The delegated form is rejected before the migration...
      expect(() =>
        insertExecution("exec_delegated_early", "authority_user_id", "usr_ada")
      ).toThrow()

      sqliteStorageMigrations.steps[25]?.up(db)

      // ...accepted after it, and the pre-existing row survived the table rebuild.
      insertExecution("exec_delegated", "authority_user_id", "usr_ada")
      const ids = db.query("SELECT id FROM executions ORDER BY id").all() as {
        readonly id: string
      }[]
      expect(ids.map((row) => row.id)).toEqual(["exec_delegated", "exec_own"])

      // A third-party human is still refused.
      expect(() => insertExecution("exec_stranger", "authority_user_id", "usr_mallory")).toThrow()
    } finally {
      db.close()
    }
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

  test("migrates legacy failed run records from the version 10 schema", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps.slice(0, 10)) migration.up(db)
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
      for (const migration of sqliteStorageMigrations.steps.slice(10, executionMigrationIndex)) {
        migration.up(db)
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

  test("ontology outbox failure migration replaces legacy diagnostics with a safe failure", () => {
    const db = new Database(":memory:")
    try {
      const failureMigrationIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "018-ontology-outbox-failure-record"
      )
      const failureMigration = sqliteStorageMigrations.steps[failureMigrationIndex]
      if (failureMigrationIndex !== 17 || !failureMigration) {
        throw new Error("SQLite ontology outbox failure migration is missing.")
      }
      for (const migration of sqliteStorageMigrations.steps.slice(0, failureMigrationIndex)) {
        migration.up(db)
      }
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
    const db = new Database(":memory:")
    try {
      const failureMigrationIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "019-webhook-delivery-failure-record"
      )
      const failureMigration = sqliteStorageMigrations.steps[failureMigrationIndex]
      if (failureMigrationIndex !== 18 || !failureMigration) {
        throw new Error("SQLite webhook delivery failure migration is missing.")
      }
      for (const migration of sqliteStorageMigrations.steps.slice(0, failureMigrationIndex)) {
        migration.up(db)
      }
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

  test("rejects legacy Sync and Pipeline runs instead of inventing execution authority", () => {
    for (const kind of ["sync", "pipeline"] as const) {
      const db = new Database(":memory:")
      try {
        const executionMigrationIndex = sqliteStorageMigrations.steps.findIndex(
          (migration) => migration.id === "021-sync-pipeline-executions"
        )
        const executionMigration = sqliteStorageMigrations.steps[executionMigrationIndex]
        if (!executionMigration) {
          throw new Error("SQLite sync-pipeline-executions migration is missing.")
        }
        for (const migration of sqliteStorageMigrations.steps.slice(0, executionMigrationIndex)) {
          migration.up(db)
        }
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

  test("makes Sync and Pipeline execution links required and unique", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

      for (const table of ["sync_runs", "pipeline_runs"] as const) {
        expect(readMemoryColumn(db, table, "execution_id")?.notnull).toBe(1)
        expect(readMemoryColumn(db, table, "queued_at")?.notnull).toBe(1)
        expect(readMemoryColumn(db, table, "started_at")?.notnull).toBe(0)
        expect(readMemoryUniqueIndexes(db, table)).toContainEqual(["project_id", "execution_id"])
      }
    } finally {
      db.close()
    }
  })

  test("rejects legacy Projection runs instead of inventing execution authority", () => {
    const db = new Database(":memory:")
    try {
      const executionMigrationIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "022-projection-executions"
      )
      const executionMigration = sqliteStorageMigrations.steps[executionMigrationIndex]
      if (!executionMigration) {
        throw new Error("SQLite projection-executions migration is missing.")
      }
      for (const migration of sqliteStorageMigrations.steps.slice(0, executionMigrationIndex)) {
        migration.up(db)
      }
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

  test("makes the Projection execution link required and unique", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

      expect(readMemoryForeignKeyTables(db, "executions")).toContain("executions")
      expect(readMemoryForeignKeyTables(db, "executions")).not.toContain("executions_v2")
      expect(readMemoryColumn(db, "projection_runs", "execution_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "projection_runs", "queued_at")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "projection_runs", "started_at")?.notnull).toBe(0)
      expect(readMemoryUniqueIndexes(db, "projection_runs")).toContainEqual([
        "project_id",
        "execution_id",
      ])
    } finally {
      db.close()
    }
  })

  test("rejects legacy Webhook runs and deliveries instead of inventing authority", () => {
    for (const legacyRecord of ["run", "delivery"] as const) {
      const db = new Database(":memory:")
      try {
        const executionMigrationIndex = sqliteStorageMigrations.steps.findIndex(
          (migration) => migration.id === "023-webhook-executions"
        )
        const executionMigration = sqliteStorageMigrations.steps[executionMigrationIndex]
        if (!executionMigration) {
          throw new Error("SQLite webhook-executions migration is missing.")
        }
        for (const migration of sqliteStorageMigrations.steps.slice(0, executionMigrationIndex)) {
          migration.up(db)
        }

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

  test("makes the Webhook delivery and execution links required and unique", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

      expect(readMemoryTableNames(db)).not.toContain("webhook_deliveries")
      expect(readMemoryColumn(db, "webhook_runs", "execution_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "webhook_runs", "request_body_bytes")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "webhook_runs", "request_body_sha256")?.notnull).toBe(1)
      expect(readMemoryTableColumns(db, "webhook_runs")).not.toContain("delivery_claim_result")
      expect(readMemoryForeignKeyTables(db, "webhook_runs")).toContain("executions")
      expect(readMemoryUniqueIndexes(db, "webhook_runs")).toEqual(
        expect.arrayContaining([
          ["project_id", "execution_id"],
          ["project_id", "connector_id", "webhook_id", "idempotency_key"],
        ])
      )
    } finally {
      db.close()
    }
  })

  test("rejects legacy ontology commits instead of inventing execution authority", () => {
    const db = new Database(":memory:")
    try {
      const migrationIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "024-ontology-commit-executions"
      )
      const migration = sqliteStorageMigrations.steps[migrationIndex]
      if (!migration) throw new Error("SQLite ontology-commit execution migration is missing.")
      for (const previous of sqliteStorageMigrations.steps.slice(0, migrationIndex)) {
        previous.up(db)
      }
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

      expect(() => db.transaction(() => migration.up(db))()).toThrow("unknown authority")
      expect(readMemoryTableColumns(db, "ontology_commits")).not.toContain("execution_id")
    } finally {
      db.close()
    }
  })

  test("requires every ontology commit to reference a durable execution", () => {
    const db = new Database(":memory:")
    try {
      for (const migration of sqliteStorageMigrations.steps) migration.up(db)

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
    const agentRunColumns = readTableColumns(path, "agent_runs")
    const workflowAgentNodeColumns = readTableColumns(path, "workflow_agent_node_runs")
    expect(agentRunColumns).toContain("requester_group_ids")
    expect(agentRunColumns).not.toContain("usage_input_tokens")
    expect(agentRunColumns).not.toContain("usage_output_tokens")
    expect(agentRunColumns).not.toContain("usage_total_tokens")
    expect(agentRunColumns).not.toContain("usage_reasoning_tokens")
    expect(agentRunColumns).not.toContain("usage_cached_input_tokens")
    expect(workflowAgentNodeColumns).not.toContain("usage")
    expect(readTableColumns(path, "workflow_runs")).toContain("requester_group_ids")
  })

  test("drops only obsolete run usage projections from an existing schema", () => {
    // Regression guard: remove migration 020 (or any one DROP COLUMN) and this leaves the old
    // projection column behind; deleting the run rows instead breaks the preservation assertions.
    const db = new Database(":memory:")
    try {
      const cleanupIndex = sqliteStorageMigrations.steps.findIndex(
        (migration) => migration.id === "020-drop-run-usage-projections"
      )
      const cleanup = sqliteStorageMigrations.steps[cleanupIndex]
      if (!cleanup) throw new Error("expected run usage cleanup migration")
      for (const migration of sqliteStorageMigrations.steps.slice(0, cleanupIndex)) {
        const applied = migration.up(db)
        if (applied instanceof Promise) throw new Error("expected synchronous SQLite migration")
      }
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

      const agentColumns = tableColumns(db, "agent_runs")
      const workflowColumns = tableColumns(db, "workflow_agent_node_runs")
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

function tableColumns(db: Database, tableName: string): readonly string[] {
  return (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  )
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

function readMemoryForeignKeyTables(db: Database, tableName: string): string[] {
  return (
    db.query(`PRAGMA foreign_key_list(${tableName})`).all() as { readonly table: string }[]
  ).map((foreignKey) => foreignKey.table)
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
