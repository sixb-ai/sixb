import { describe, expect, test } from "bun:test"
import { defineObjectType, migrateStorage, OntologyRegistry, prop } from "@sixb/core"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  materializationEvent,
  type OntologyMaterializationEvent,
  type OntologyMaterializationEventAttribution,
  type OntologyMaterializationEventCommit,
  type OntologyMaterializationEventDraft,
} from "@sixb/core/internal/materialization"
import {
  defineMigrations,
  type MigrationReport,
  ONTOLOGY_OUTBOX_FAILURE_CODES,
  SYNC_RUN_FAILURE_CODES,
} from "@sixb/core/storage"
import {
  createMaterializerTestFixture,
  createTestAgentExecution,
  createTestWorkflowExecution,
  startTestProjectionRun,
  startTestSyncRun,
  startTestWebhookRun,
} from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import {
  createPostgresMigrator,
  POSTGRES_STORAGE_ADAPTER_ID,
  type PostgresMigrationContext,
  postgresStorageMigrations,
  quoteIdent,
} from "../src/migrations"
import { jsonParameter } from "../src/ontology-storage/shared"
import { createPgClient, type SQL } from "../src/pg-client"
import { createTestStorage, disposeTestStorage, type TestStorageOptions } from "./helpers"

const LEGACY_WEBHOOK_DELIVERY_FAILURE_CODES = ["webhook.delivery_failed"] as const

/** Every shipped migration, in order: renaming or reordering one breaks deployed databases. */
const SHIPPED_MIGRATIONS = [
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
  "038-outbox-publication-order",
  "039-projection-source-roots",
  "040-connector-optional-pkce",
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
  "055-object-query-preparation",
  "056-commit-touches",
  "057-audio-transcription",
  "058-reranking-model-kind",
  "059-file-download-grants",
  "060-drained-source-versions",
  "061-terminal-action-runs",
  "062-drop-auth-audience",
  "063-artifacts",
  "064-drop-output-diagnostics",
  "065-plan-work-payload-statistics",
  "066-activity",
  "067-activity-timeline",
  "068-activity-interactions",
  "069-artifact-kinds",
  "070-artifact-state",
  "071-agent-thread-participants",
  "072-forked-context-checkpoints",
  "073-unique-values",
  "074-generated-media-usage",
  "075-model-call-files",
  "076-agent-memory",
  "077-artifact-threads",
  "078-agent-approvals",
  "079-agent-approval-resume",
  "080-subagent-threads",
  "081-subagent-questions",
  "082-agent-run-cancel-requests",
  "083-agent-thread-runs-on",
]

const steps = postgresStorageMigrations.steps

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
  test("moves historical snapshots to executions and preserves empty child snapshots", async () => {
    // Removal proof: omit 037's recursive backfill; the snapshots below become empty.
    await withDatabase({ migrate: false }, async ({ sql, schemaName, context }) => {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`)
      await sql.unsafe(`
        CREATE TABLE executions (project_id TEXT, id TEXT, parent_execution_id TEXT);
        CREATE TABLE workflow_runs (project_id TEXT, execution_id TEXT, requester_group_ids JSONB);
        CREATE TABLE agent_runs (project_id TEXT, execution_id TEXT, requester_group_ids JSONB);
        INSERT INTO executions VALUES ('p', 'root', NULL), ('p', 'workflow', 'root'),
          ('p', 'task', 'workflow'), ('p', 'agent', 'root'), ('p', 'child', 'agent'),
          ('p', 'empty', 'agent'), ('other', 'workflow', NULL);
        INSERT INTO workflow_runs VALUES ('p', 'workflow', '["finance"]');
        INSERT INTO agent_runs VALUES ('p', 'agent', '["support"]'), ('p', 'empty', '[]');
      `)
      await steps[indexOf("037-execution-requester-groups")]!.up(context)
      const rows =
        await sql`SELECT project_id, id, requester_group_ids FROM executions ORDER BY project_id, id`
      expect([...rows]).toEqual([
        { project_id: "other", id: "workflow", requester_group_ids: [] },
        { project_id: "p", id: "agent", requester_group_ids: ["support"] },
        { project_id: "p", id: "child", requester_group_ids: ["support"] },
        { project_id: "p", id: "empty", requester_group_ids: [] },
        { project_id: "p", id: "root", requester_group_ids: [] },
        { project_id: "p", id: "task", requester_group_ids: ["finance"] },
        { project_id: "p", id: "workflow", requester_group_ids: ["finance"] },
      ])
    })
  })

  test("attributes existing commits and pending events from their executions", async () => {
    // Removal proof: drop 047's commit UPDATE; `SET NOT NULL` on executor then fails.
    await withDatabase({ migrate: false }, async ({ sql, schemaName, context }) => {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`)
      await sql.unsafe(`
        CREATE TABLE executions (
          project_id TEXT, id TEXT, executor_kind TEXT, executor_id TEXT,
          requested_by_user_id TEXT, requested_by_service_account_id TEXT,
          authority_primitive_id TEXT, authority_kernel_operation TEXT
        );
        CREATE TABLE ontology_commits (
          project_id TEXT, id TEXT, execution_id TEXT, actor JSONB
        );
        CREATE TABLE ontology_outbox (project_id TEXT, commit_id TEXT, envelope JSONB NOT NULL);
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
            CASE WHEN id = 'request' THEN '{"id":"alice","type":"user"}'::jsonb END
          FROM executions;
        INSERT INTO ontology_outbox VALUES
          ('p', 'c-request', '{"id":"e1","actor":{"id":"alice","type":"user"}}'),
          ('p', 'c-scheduled', '{"id":"e2"}');
      `)
      await steps[indexOf("047-ontology-commit-attribution")]!.up(context)

      expect(await readTableColumns(sql, "ontology_commits")).not.toContain("actor")
      expect(await readColumnNullable(sql, "ontology_commits", "executor")).toBe("NO")
      const commits = await sql`SELECT id, requested_by, executor FROM ontology_commits ORDER BY id`
      expect([...commits]).toEqual([
        {
          id: "c-action",
          requested_by: { type: "user", id: "alice" },
          executor: { type: "primitive", kind: "action", id: "approve", runId: "run-1" },
        },
        {
          id: "c-agent",
          requested_by: { type: "user", id: "alice" },
          executor: { type: "agent", runId: "agent-run" },
        },
        {
          id: "c-index",
          requested_by: null,
          executor: {
            type: "kernel",
            operation: { type: "ontology.indexVectors", indexingId: "indexing-1" },
          },
        },
        {
          id: "c-recover",
          requested_by: null,
          executor: {
            type: "kernel",
            operation: { type: "ontology.recover", recoveryId: "recovery-1" },
          },
        },
        {
          id: "c-request",
          requested_by: { type: "user", id: "alice" },
          executor: { type: "request", requestId: "req-1" },
        },
        {
          id: "c-scheduled",
          requested_by: null,
          executor: { type: "primitive", kind: "workflow", id: "nightly", runId: "wf-run" },
        },
        {
          id: "c-service",
          requested_by: { type: "serviceAccount", id: "svc-import" },
          executor: { type: "request", requestId: "req-2" },
        },
      ])

      const envelopes = await sql`SELECT envelope FROM ontology_outbox ORDER BY commit_id`
      expect([...envelopes].map((row) => row.envelope)).toEqual([
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
    })
  })

  test("upgrades model accounting in one step without losing historical evidence or constraints", async () => {
    // Regression proof: omit 029's reason conversion or native ID columns, or change shipped 026.
    await withDatabase({ migrate: false }, async ({ sql, schemaName, context }) => {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`)
      await sql.unsafe(`CREATE TABLE ai_model_call_usage (
        project_id TEXT, id TEXT, provider_id TEXT, requested_model_id TEXT, occurred_at TEXT,
        PRIMARY KEY (project_id, id)
      )`)
      await sql.unsafe(
        "INSERT INTO ai_model_call_usage VALUES ('project', 'usage', 'mock', 'model', '2026-08-01')"
      )
      await steps[indexOf("026-ai-cost-accounting")]!.up(context)
      await sql.unsafe(`INSERT INTO ai_model_call_valuations (
        project_id, usage_record_id, status, provider_id, model_id, reason, details, rated_at
      ) VALUES ('project', 'usage', 'unpriceable', 'mock', 'model', 'missingCatalogEntry',
        '{"pricingContext":{}}', '2026-08-01')`)
      for (const sourceId of ["provider-reported", "model-rate-card", "unknown-old-source"]) {
        await sql`INSERT INTO ai_model_call_usage VALUES ('project', ${sourceId}, 'mock', 'model', '2026-08-01')`
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
        await sql`INSERT INTO ai_model_call_valuations (project_id, usage_record_id, status,
          provider_id, model_id, currency, amount_nanos, details, rated_at)
          VALUES ('project', ${sourceId}, 'rated', 'mock', 'model', 'USD', 10000, ${details}::text::jsonb, '2026-08-01')`
      }
      await sql.unsafe(
        `UPDATE ai_model_call_valuations SET details = '{"pricingContext":{},"priceSource":{"sourceId":"provider-reported","sourceEntryId":"missing-report","sourceVersion":"v1","observedAt":"2026-08-01T00:00:00.000Z"}}' WHERE usage_record_id = 'usage'`
      )
      const before =
        await sql`SELECT usage_record_id, details FROM ai_model_call_valuations ORDER BY usage_record_id`
      await steps[indexOf("029-model-accounting")]!.up(context)
      const [converted] =
        await sql`SELECT reason FROM ai_model_call_valuations WHERE usage_record_id = 'usage'`
      expect(converted?.reason).toBe("missingRateCard")
      const after =
        await sql`SELECT usage_record_id, details FROM ai_model_call_valuations ORDER BY usage_record_id`
      expect([...after]).toEqual([...before])
      // Bun 1.3.14's rejects matcher hangs on postgres.js's lazy PendingQuery thenable.
      // Regression proof: remove Promise.resolve here and this test times out instead of finishing.
      await expect(
        Promise.resolve(
          sql.unsafe(
            "UPDATE ai_model_call_valuations SET reason = 'missingCatalogEntry' WHERE usage_record_id = 'usage'"
          )
        )
      ).rejects.toThrow()
      await expect(Promise.resolve(sql.unsafe("DELETE FROM ai_model_call_usage"))).rejects.toThrow()
      const [reasoning] =
        await sql`SELECT COUNT(*)::int AS count FROM ai_model_call_usage WHERE requested_reasoning IS NULL`
      expect(reasoning?.count).toBe(4)
      const [nativeIds] =
        await sql`SELECT COUNT(*)::int AS count FROM ai_model_call_usage WHERE provider_ids IS NULL`
      expect(nativeIds?.count).toBe(4)
    })
  })

  test("delegated execution migration preserves ancestry and rejects a missing kind", async () => {
    await withDatabase({ migrate: false }, async ({ sql, schemaName, context }) => {
      await sql.unsafe(`CREATE SCHEMA ${quoteIdent(schemaName)}`)
      // Keep the execution/share schema current, including 031's inherited Agent authority,
      // without replaying unrelated migrations in this focused upgrade fixture.
      for (const id of [
        "001-initial-schema",
        "004-executions",
        "022-projection-executions",
        "031-subagent-runs",
        "035-share-grants",
      ]) {
        await steps[indexOf(id)]!.up(context)
      }

      await sql.unsafe(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, parent_execution_id, authority_kind, authority_primitive_kind,
          authority_primitive_id, created_at
        ) VALUES
          (
            'project-a', 'legacy-parent', 'request', 'request-1', 'http', 'request-1',
            'correlation-1', NULL, 'disabled', NULL, NULL, '2026-08-20T12:00:00.000Z'
          ),
          (
            'project-a', 'legacy-child', 'action', 'action-run-1', 'execution',
            'legacy-parent', 'correlation-1', 'legacy-parent', 'trustedPrimitive', 'action',
            'send-email', '2026-08-20T12:00:01.000Z'
          ),
          (
            'project-a', 'legacy-agent', 'agent', 'agent-run-1', 'execution',
            'legacy-parent', 'correlation-1', 'legacy-parent', 'disabled', NULL,
            NULL, '2026-08-20T12:00:02.000Z'
          );

        INSERT INTO share_grants (
          project_id, id, definition_id, target_object_type_id, target_primary_id,
          issued_by_type, issued_by_id, authority_version, authority_snapshot,
          authority_digest, token_hash, destination_path, created_at, expires_at
        ) VALUES (
          'project-a', 'grant-1', 'share-definition', 'Report', 'report-1',
          'user', 'user-1', 1, '{"version":1,"access":{"grants":[]}}'::jsonb,
          repeat('a', 64), repeat('b', 64), '/reports/report-1',
          '2026-08-20T12:00:00.000Z', '2026-08-20T13:00:00.000Z'
        );
      `)

      await steps[indexOf("036-share-sessions")]!.up(context)

      await sql.unsafe(`
        INSERT INTO share_sessions (
          project_id, id, grant_id, token_hash, created_at, expires_at, absolute_expires_at
        ) VALUES (
          'project-a', 'session-1', 'grant-1', repeat('c', 64),
          '2026-08-20T12:00:00.000Z', '2026-08-20T12:10:00.000Z',
          '2026-08-20T13:00:00.000Z'
        );
      `)

      const preserved = await sql.unsafe<
        {
          readonly authority_delegation_kind: string | null
          readonly authority_kind: string
          readonly id: string
          readonly parent_execution_id: string | null
          readonly source_id: string
        }[]
      >(`
        SELECT id, source_id, parent_execution_id, authority_kind, authority_delegation_kind
        FROM executions
        ORDER BY id
      `)
      expect([...preserved]).toEqual([
        {
          authority_delegation_kind: null,
          authority_kind: "disabled",
          id: "legacy-agent",
          parent_execution_id: "legacy-parent",
          source_id: "legacy-parent",
        },
        {
          authority_delegation_kind: null,
          authority_kind: "trustedPrimitive",
          id: "legacy-child",
          parent_execution_id: "legacy-parent",
          source_id: "legacy-parent",
        },
        {
          authority_delegation_kind: null,
          authority_kind: "disabled",
          id: "legacy-parent",
          parent_execution_id: null,
          source_id: "request-1",
        },
      ])

      // Regression proof: without the explicit NOT NULL term PostgreSQL treats the delegated
      // shape CHECK as unknown, which satisfies a CHECK and lets this malformed row through.
      // postgres.js queries are lazy Promise subclasses. Bun 1.3.14's rejects matcher does not
      // assimilate them, so normalize the query to a native Promise to ensure it is dispatched.
      await expect(
        Promise.resolve(
          sql.unsafe(`
            INSERT INTO executions (
              project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
              authority_kind, authority_delegation_kind, authority_delegation_id,
              authority_delegation_session_id, created_at
            ) VALUES (
              'project-a', 'invalid-delegated', 'request', 'request-2', 'http', 'request-2',
              'correlation-2', 'delegated', NULL, 'grant-1', 'session-1',
              '2026-08-20T12:01:00.000Z'
            )
          `)
        )
      ).rejects.toMatchObject({ code: "23514" })
    })
  })

  test("merge sync migration preserves existing runs and admits merge mode", async () => {
    // This fixture intentionally predates durable execution links. Exercise migration 003
    // without crossing migration 020, which must reject legacy runs with unknown authority.
    const merge = indexOf("003-merge-sync-runs")
    await withDatabase({ migrateThrough: merge }, async ({ sql, migrateThrough }) => {
      await sql.unsafe(
        `
          INSERT INTO sync_runs (
            project_id, id, sync_id, dataset_id, mode, status, started_at
          ) VALUES ($1, $2, $3, $4, 'append', 'succeeded', $5)
        `,
        ["project-a", "run-append", "sync-orders", "raw.orders", "2026-08-07T12:00:00.000Z"]
      )
      await migrateThrough(merge + 1)
      await sql.unsafe(
        `
          INSERT INTO sync_runs (
            project_id, id, sync_id, dataset_id, mode, status, started_at
          ) VALUES ($1, $2, $3, $4, 'merge', 'running', $5)
        `,
        ["project-a", "run-merge", "sync-invoices", "raw.invoices", "2026-08-07T12:01:00.000Z"]
      )

      const rows = await sql.unsafe<{ id: string; mode: string }[]>(
        "SELECT id, mode FROM sync_runs ORDER BY id"
      )
      expect([...rows]).toEqual([
        { id: "run-append", mode: "append" },
        { id: "run-merge", mode: "merge" },
      ])
    })
  })

  test("splits legacy overrides and derives unambiguous link slot authority", async () => {
    const split = indexOf("007-split-overrides")
    await withDatabase({ migrateThrough: split }, async ({ storage, sql }) => {
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
          `INSERT INTO ontology_overrides (
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

      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
      const rows = await sql.unsafe<{ source_primary_id: string; value: unknown }[]>(
        `SELECT source_primary_id, value
         FROM ontology_link_overrides
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
    })
  })

  test("keeps projection runs and admits superseded runs and retrying failures", async () => {
    // Removal proof: drop 051's DO block; the old status checks, still in place, reject both the
    // superseded run and the running run's error below.
    const index = indexOf("051-projection-run-supersession")
    await withDatabase({ migrateThrough: index }, async ({ sql, migrateThrough }) => {
      const failure = JSON.stringify({
        code: "projection.execution_failed",
        message: "Projection execution failed.",
        retryable: false,
        at: "2026-09-01T12:00:00.000Z",
      })
      const insertRun = async (
        id: string,
        status: string,
        versionId: string,
        error: string | null
      ) => {
        await sql.unsafe(
          `
            INSERT INTO executions (
              project_id, id, executor_kind, executor_id, source_kind, source_id,
              correlation_id, authority_kind, authority_primitive_kind, authority_primitive_id,
              created_at
            ) VALUES (
              'project-a', $1, 'projection', 'rooms', 'datasetVersion', $2, $1,
              'trustedPrimitive', 'projection', 'rooms', '2026-09-01T12:00:00.000Z'
            )
          `,
          [`execution-${id}`, versionId]
        )
        await sql.unsafe(
          `
            INSERT INTO projection_runs (
              project_id, id, execution_id, projection_id, projection_kind,
              materialization_protocol, dataset_id, dataset_version_id,
              dataset_version_created_at, ontology_revision, projection_revision,
              ownership_hash, object_type_id, status, queued_at, started_at, finished_at,
              attempt, execution_token, error
            ) VALUES (
              'project-a', $2, $1, 'rooms', 'object', 'replacement', 'rooms', $3,
              '2026-09-01T12:00:00.000Z', 'ontology', 'projection', 'ownership', 'Room', $4,
              '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z', $5, 1, $6,
              $7::text::jsonb
            )
          `,
          [
            `execution-${id}`,
            id,
            versionId,
            status,
            status === "running" ? null : "2026-09-01T12:01:00.000Z",
            status === "running" ? "token" : null,
            error,
          ]
        )
      }
      await insertRun("failed-run", "failed", "version-1", failure)
      await insertRun("running-run", "running", "version-2", null)

      await migrateThrough(index + 1)
      await insertRun("superseded-run", "superseded", "version-3", null)
      await sql.unsafe(
        `UPDATE projection_runs SET error = $1::text::jsonb WHERE id = 'running-run'`,
        [failure]
      )

      const rows = await sql.unsafe<{ id: string; status: string; error_code: string | null }[]>(
        `SELECT id, status, error->>'code' AS error_code FROM projection_runs ORDER BY id`
      )
      expect([...rows]).toEqual([
        { id: "failed-run", status: "failed", error_code: "projection.execution_failed" },
        { id: "running-run", status: "running", error_code: "projection.execution_failed" },
        { id: "superseded-run", status: "superseded", error_code: null },
      ])
      await expect(
        insertRun("superseded-with-error", "superseded", "version-4", failure)
      ).rejects.toThrow("projection_runs_superseded_check")
    })
  })

  test("shares each existing artifact in the threads its versions came from", async () => {
    // Removal proof: drop the INSERT from 077; the artifact is then shared nowhere.
    const index = indexOf("077-artifact-threads")
    await withDatabase({ migrateThrough: index }, async ({ storage, sql, migrateThrough }) => {
      await sql.unsafe(`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, created_at, updated_at
        ) VALUES (
          'project-a', 'art_0000000001', 'document', 'Report', 'user', 'usr-1', 3, 4,
          '2026-07-01T12:00:00.000Z', '2026-07-01T12:02:00.000Z'
        )
        `)
      for (const [version, thread, run, at] of [
        [1, "'thread-1'", "'run-1'", "2026-07-01T12:00:00.000Z"],
        [2, "'thread-1'", "'run-2'", "2026-07-01T12:01:00.000Z"],
        [3, "NULL", "NULL", "2026-07-01T12:02:00.000Z"],
      ] as const) {
        await sql.unsafe(`
          INSERT INTO artifact_versions (
            project_id, artifact_id, version, title, entry, files, outline, refs,
            author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
          ) VALUES (
            'project-a', 'art_0000000001', ${version}, 'Report', 'document.md', '[]'::jsonb,
            '{"kind":"document","headings":[]}'::jsonb, '[]'::jsonb, 'user', 'usr-1',
            ${thread}, ${run}, '${at}'
          )
          `)
      }

      await migrateThrough(index + 1)
      await expect(
        storage.artifacts.listThreadIds({ projectId: "project-a", id: "art_0000000001" })
      ).resolves.toEqual(["thread-1"])
    })
  })

  test("gives each earlier child a thread holding its task, under its conversation", async () => {
    // Removal proof: drop 080's backfill; restoring the run check then fails on the children
    // that have no thread.
    const index = indexOf("080-subagent-threads")
    await withDatabase({ migrateThrough: index }, async ({ storage, sql, migrateThrough }) => {
      const projectId = "project-a"
      const digest = "a".repeat(64)
      await sql.unsafe(`
        INSERT INTO agent_threads (
          project_id, id, owner_principal_type, owner_principal_id, status, message_count,
          created_at, updated_at
        ) VALUES (
          'project-a', 'thread-1', 'user', 'usr-1', 'active', 2, '2026-07-01T12:00:00.000Z',
          '2026-07-01T12:00:00.000Z'
        )
      `)
      const parentExecution = await createTestAgentExecution(storage, { projectId, runId: "run-1" })
      await sql`
        INSERT INTO agent_runs (
          project_id, id, execution_id, kind, thread_id, trigger_message_id, status, created_at
        ) VALUES (
          ${projectId}, 'run-1', ${parentExecution}, 'conversation', 'thread-1', 'msg-1',
          'succeeded', '2026-07-01T12:00:00.000Z'
        )
      `
      for (const [id, status] of [
        [`agt_run_child_${digest}`, "succeeded"],
        ["legacy-child", "running"],
      ] as const) {
        const executionId = await createTestAgentExecution(storage, {
          projectId,
          runId: id,
          sourceExecutionId: parentExecution,
        })
        await sql`
          INSERT INTO agent_runs (
            project_id, id, execution_id, kind, parent_run_id, spawn_key, spec, result, status,
            created_at, completed_at
          ) VALUES (
            ${projectId}, ${id}, ${executionId}, 'subagent', 'run-1', ${`key-${id}`},
            ${JSON.stringify({ task: `Task of ${id}` })}::text::jsonb,
            ${status === "succeeded" ? JSON.stringify({ text: "Done." }) : null}::text::jsonb,
            ${status}, '2026-07-01T12:00:01.000Z',
            ${status === "running" ? null : "2026-07-01T12:00:05.000Z"}
          )
        `
      }

      await migrateThrough(index + 1)

      const children = [
        { run: `agt_run_child_${digest}`, thread: `agt_thr_child_${digest}`, active: null },
        { run: "legacy-child", thread: "agt_thr_child_legacy-child", active: "legacy-child" },
      ]
      const threads = await storage.agents.threads.getByIds({
        projectId,
        ids: children.map((child) => child.thread),
      })
      expect(threads).toEqual(
        children.map((child) => ({
          id: child.thread,
          projectId,
          kind: "subagent",
          parent: { threadId: "thread-1", spawnedBy: "run-1", key: `key-${child.run}` },
          ownerPrincipal: { type: "user", id: "usr-1" },
          title: undefined,
          status: "active",
          activeRunId: child.active,
          lastMessageAt: new Date("2026-07-01T12:00:01.000Z"),
          messageCount: 1,
          createdAt: new Date("2026-07-01T12:00:01.000Z"),
          updatedAt: new Date(
            child.active ? "2026-07-01T12:00:01.000Z" : "2026-07-01T12:00:05.000Z"
          ),
        }))
      )
      for (const child of children) {
        await expect(
          storage.agents.messages.list({ projectId, threadId: child.thread })
        ).resolves.toMatchObject({
          messages: [
            {
              runId: child.run,
              role: "user",
              seq: 1,
              parts: [{ type: "text", text: `Task of ${child.run}` }],
            },
          ],
          total: 1,
        })
        const run = await storage.agents.runs.getById({ projectId, id: child.run })
        expect(run).toMatchObject({ kind: "subagent", threadId: child.thread })
        await expect(
          storage.agents.messages.getById({
            projectId,
            id: run?.kind === "subagent" ? run.triggerMessageId : "",
          })
        ).resolves.toMatchObject({ threadId: child.thread, seq: 1 })
      }
      await expect(storage.agents.threads.list({ projectId })).resolves.toMatchObject({
        threads: [{ id: "thread-1", kind: "conversation" }],
        total: 1,
      })

      // A child run has a thread from now on, and a conversation's children go with it.
      const refused = await Promise.resolve(
        sql`UPDATE agent_runs SET thread_id = NULL WHERE id = 'legacy-child'`
      ).catch((error: unknown) => error)
      expect(refused).toMatchObject({ code: "23514" })
      await sql`DELETE FROM agent_threads WHERE id = 'thread-1'`
      expect(await sql`SELECT id FROM agent_threads`).toHaveLength(0)
    })
  })

  test("scopes a run's context checkpoint to its thread and keeps existing ones", async () => {
    // Removal proof: drop 072's DO block; the project-wide constraint stays, and the copy of
    // `run-2`'s checkpoint into another thread violates it.
    const index = indexOf("072-forked-context-checkpoints")
    await withDatabase(
      { migrateThrough: index },
      async ({ storage, sql, schemaName, migrateThrough }) => {
        const uniqueConstraints = async () => {
          const rows = await sql.unsafe<{ definition: string }[]>(
            `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid = $1::regclass AND contype = 'u' ORDER BY 1`,
            [`${quoteIdent(schemaName)}.agent_context_checkpoints`]
          )
          return rows.map((row) => row.definition)
        }

        await seedCompactedThread(storage, sql)
        expect(await uniqueConstraints()).toEqual(["UNIQUE (project_id, created_by_run_id)"])

        await migrateThrough(index + 1)
        expect(await uniqueConstraints()).toEqual([
          "UNIQUE (project_id, thread_id, created_by_run_id)",
        ])
        await expect(
          storage.agents.checkpoints.getLatest({ projectId: "project-a", threadId: "thread-1" })
        ).resolves.toMatchObject({ id: "checkpoint-1", createdByRunId: "run-2" })

        // What a fork writes: the same run's checkpoint, in another thread.
        await storage.agents.threads.create({
          projectId: "project-a",
          id: "thread-fork",
          ownerPrincipal: { type: "user", id: "usr-2" },
        })
        await sql.unsafe(
          `INSERT INTO ${quoteIdent(schemaName)}.agent_context_checkpoints
          SELECT project_id, 'checkpoint-copy', 'thread-fork', created_by_run_id,
            previous_checkpoint_id, reason, summary, summary_format_version,
            summarized_through_seq, observed_head_seq, estimated_input_tokens_before,
            estimated_input_tokens_after, summary_model_id, created_at
          FROM ${quoteIdent(schemaName)}.agent_context_checkpoints WHERE id = 'checkpoint-1'`
        )
        await expect(
          storage.agents.checkpoints.getLatest({ projectId: "project-a", threadId: "thread-fork" })
        ).resolves.toMatchObject({ id: "checkpoint-copy", createdByRunId: "run-2" })
      }
    )
  })

  test("keeps every Action run readable as a terminal record", async () => {
    // Removal proofs: drop the `jsonb_set` on `{details,phase}` from 061, and the enqueue failure
    // below keeps phase 'enqueue', which `parseActionRunFailure` rejects. Drop the UPDATE that
    // joins `ontology_commits`, and the runs whose edits committed are recorded as failed.
    const index = indexOf("061-terminal-action-runs")
    await withDatabase({ migrateThrough: index }, async ({ storage, sql, migrateThrough }) => {
      const failure = (code: string, retryable: boolean, phase: string) =>
        JSON.stringify({
          code,
          message: "Stored failure.",
          retryable,
          at: "2026-01-01T00:00:02.000Z",
          details: { actionId: "send-quote", runId: "ignored", phase },
        })
      const insertRun = async (
        id: string,
        status: string,
        phase: string | null,
        startedAt: string | null,
        finishedAt: string | null,
        error: string | null
      ) => {
        await sql.unsafe(
          `
            INSERT INTO executions (
              project_id, id, executor_kind, executor_id, source_kind, source_id,
              correlation_id, authority_kind, authority_primitive_kind, authority_primitive_id,
              created_at
            ) VALUES (
              'p', $1, 'action', $2, 'event', 'event', $1, 'trustedPrimitive', 'action',
              'send-quote', '2026-01-01T00:00:00.000Z'
            )
          `,
          [`execution-${id}`, id]
        )
        await sql.unsafe(
          `
            INSERT INTO action_runs (
              project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
              started_at, finished_at, params, idempotency_key, error
            ) VALUES (
              'p', $1, $2, 'send-quote', 'none', $3, $4, '2026-01-01T00:00:00.000Z', $5, $6,
              '{"amount": 1}', $7, $8::text::jsonb
            )
          `,
          [id, `execution-${id}`, status, phase, startedAt, finishedAt, `action:p:${id}`, error]
        )
      }
      const started = "2026-01-01T00:00:01.000Z"
      const finished = "2026-01-01T00:00:02.000Z"
      const committedAt = "2026-01-01T00:00:03.000Z"
      await insertRun("queued", "queued", "request", null, null, null)
      await insertRun("running", "running", "edits", started, null, null)
      await insertRun(
        "cancelled",
        "cancelled",
        "cancelled",
        started,
        finished,
        failure("runtime.cancelled", false, "cancelled")
      )
      await insertRun(
        "enqueue-failed",
        "failed",
        "enqueue",
        null,
        finished,
        failure("queue.enqueue_failed", true, "enqueue")
      )
      await insertRun("unexplained", "failed", "commit", started, finished, null)
      await insertRun("succeeded", "succeeded", "commit", started, finished, null)
      // Runs a crash left running after their edits committed.
      for (const [id, phase] of [
        ["committed", "commit"],
        ["committed-in-effects", "effects"],
      ] as const) {
        await insertRun(id, "running", phase, started, null, null)
        await sql.unsafe(
          `
            INSERT INTO ontology_commits (
              project_id, id, idempotency_key, request_hash, execution_id, origin_kind,
              origin_run_id, origin, ontology_revision, intent, result, committed_at
            ) VALUES (
              'p', $1, $2, 'hash', $3, 'action', $4, '{}', 'revision', '{}', '{}', $5
            )
          `,
          [`commit-${id}`, `action:${id}:edits`, `execution-${id}`, id, committedAt]
        )
      }

      await migrateThrough(index + 1)
      const listed = await storage.actionRuns.list({ projectId: "p", limit: 10 })
      const runs = new Map(listed.runs.map((run) => [run.id, run]))

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
      expect(await readTableColumns(sql, "action_runs")).not.toContain("queued_at")
      const refusal = await sql
        .unsafe(
          `INSERT INTO action_runs (
            project_id, id, execution_id, action_id, subject_kind, status, phase, started_at,
            finished_at, params, idempotency_key
          ) VALUES ('p', 'late', 'execution-queued', 'send-quote', 'none', 'queued',
            'validation', now(), now(), '{}', 'late')`
        )
        .then(
          () => "inserted",
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        )
      expect(refusal).toContain("action_runs_status_check")
    })
  })

  // Removal proof: drop the UPDATE from 062 and the Atlas browser session stays active, listed
  // among the person's sessions though no cookie can reach it.
  test("ends Atlas's browser sessions and keeps the app's and native ones", async () => {
    const index = indexOf("062-drop-auth-audience")
    await withDatabase({ migrateThrough: index }, async ({ sql, migrateThrough }) => {
      await sql.unsafe(
        `INSERT INTO auth_users (project_id, id, email, status, created_at, updated_at)
        VALUES ('p', 'usr_1', 'ava@acme.com', 'active', now(), now())`
      )
      // A native (CLI) session has a refresh token, a client name and a short access expiry;
      // the bearer-state constraint requires all three together.
      for (const [id, audience, refreshTokenHash, clientName] of [
        ["atlas", "atlas", null, null],
        ["app", "app", null, null],
        ["native", "atlas", "refresh-hash", "Sixb CLI"],
      ] as const) {
        await sql.unsafe(
          `INSERT INTO auth_sessions (
            project_id, id, user_id, strategy_id, audience, token_hash, created_at, expires_at,
            refresh_token_hash, client_name, access_expires_at
          ) VALUES (
            'p', $1, 'usr_1', 'magic-link', $2, $3, now(), now() + interval '1 day', $4, $5,
            CASE WHEN $4::text IS NULL THEN NULL ELSE now() + interval '1 hour' END
          )`,
          [id, audience, `hash-${id}`, refreshTokenHash, clientName]
        )
      }

      await migrateThrough(index + 1)

      const rows = await sql.unsafe<{ id: string; revoked: boolean }[]>(
        "SELECT id, revoked_at IS NOT NULL AS revoked FROM auth_sessions ORDER BY id"
      )
      expect(rows.map((row) => [row.id, row.revoked])).toEqual([
        ["app", false],
        ["atlas", true],
        ["native", false],
      ])
      expect(await readTableColumns(sql, "auth_sessions")).not.toContain("audience")
    })
  })

  test("migrates failed run records from the version 10 main schema", async () => {
    await withDatabase({ migrateThrough: 10 }, async ({ sql, migrateThrough }) => {
      await sql.unsafe(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, authority_primitive_kind, authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'execution-action-legacy', 'action', 'action-legacy', 'event',
          'event-action-legacy', 'correlation-action-legacy', 'trustedPrimitive', 'action',
          'approve', '2026-08-10T12:00:00.000Z'
        );

        INSERT INTO sync_runs (
          project_id, id, sync_id, dataset_id, mode, status, started_at, finished_at,
          error_name, error_message
        ) VALUES (
          'project-a', 'sync-legacy', 'sync.orders', 'orders', 'snapshot', 'failed',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z',
          'ProviderError', 'secret sync diagnostic'
        );

        INSERT INTO action_runs (
          project_id, id, execution_id, action_id, subject_kind, status, phase, queued_at,
          finished_at, params, idempotency_key, error_name, error_message, error_phase
        ) VALUES (
          'project-a', 'action-legacy', 'execution-action-legacy', 'approve', 'none', 'failed',
          'enqueue',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:01:00.000Z', '{}'::jsonb,
          'action-legacy', 'QueueError', 'secret queue diagnostic', 'enqueue'
        );
      `)

      // Up to the execution links of 021, which reject legacy runs.
      await expect(migrateThrough(indexOf("021-sync-pipeline-executions"))).resolves.toMatchObject({
        status: "migrated",
      })

      const [sync] = await sql.unsafe<Array<{ readonly error: unknown }>>(
        "SELECT error FROM sync_runs WHERE id = 'sync-legacy'"
      )
      const [action] = await sql.unsafe<Array<{ readonly error: unknown }>>(
        "SELECT error FROM action_runs WHERE id = 'action-legacy'"
      )
      expect(parseSixbFailure(sync?.error, SYNC_RUN_FAILURE_CODES)).toMatchObject({
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: { syncId: "sync.orders", runId: "sync-legacy" },
      })
      // 061 later rewrites this failure: enqueue failures and phases are gone.
      expect(parseSixbFailure(action?.error)).toMatchObject({
        code: "queue.enqueue_failed",
        retryable: true,
        details: { actionId: "approve", runId: "action-legacy", phase: "enqueue" },
      })
      expect(JSON.stringify(sync)).not.toContain("secret")
      expect(await readTableColumns(sql, "sync_runs")).not.toContain("error_message")
      expect(await readTableColumns(sql, "action_runs")).not.toContain("error_phase")
    })
  })

  test("ontology outbox failure migration replaces legacy diagnostics with a safe failure", async () => {
    const index = indexOf("018-ontology-outbox-failure-record")
    await withDatabase({ migrateThrough: index }, async ({ sql, migrateThrough }) => {
      await sql.unsafe(`
        INSERT INTO ontology_outbox (
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

      // Only through 018: its rows have no commit, so 054 would rightly refuse them.
      await migrateThrough(index + 1)

      const rows = await sql.unsafe<
        Array<{ readonly id: string; readonly last_failure: unknown | null }>
      >("SELECT id, last_failure FROM ontology_outbox ORDER BY id")
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
      expect(await readTableColumns(sql, "ontology_outbox")).toContain("last_failure")
      expect(await readTableColumns(sql, "ontology_outbox")).not.toContain("last_error")
    })
  })

  describe("054 slim ontology outbox", () => {
    const index = indexOf("054-slim-ontology-outbox")
    const commit: OntologyMaterializationEventCommit = {
      projectId: "p",
      id: "c-1",
      committedAt: "2026-10-01T08:00:00.000Z",
      origin: { kind: "runtime", requestId: "req-1" },
    }
    /** What the execution below says, and what 053 copied onto the commit. */
    const attribution: OntologyMaterializationEventAttribution = {
      correlationId: "correlation-1",
      executor: { type: "request", requestId: "req-1" },
    }
    const drafts: readonly OntologyMaterializationEventDraft[] = [
      {
        type: "object.created",
        payload: { objectTypeId: "Room", primaryId: "r-1", properties: { b: 2, a: [1] } },
      },
      {
        type: "link.updated",
        payload: {
          sourceTypeId: "Room",
          sourceId: "r-1",
          linkId: "site",
          targetTypeId: "Site",
          targetId: "s-1",
          properties: { since: 2020 },
          propertyChanges: { since: { operation: "updated", before: 2019, after: 2020 } },
        },
      },
      {
        type: "telemetry.appended",
        payload: {
          objectTypeId: "Room",
          objectId: "r-1",
          propertyId: "temperature",
          value: 21.5,
          at: "2026-10-01T07:59:00.000Z",
          unit: "celsius",
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

    /** Stores `commit` and its events as 053 stored them. */
    async function seedAt053(sql: SQL, stored: readonly OntologyMaterializationEvent[]) {
      await sql`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, created_at
        ) VALUES (
          'p', 'x-1', 'request', 'req-1', 'http', 'req-1', 'correlation-1', 'disabled',
          ${commit.committedAt}
        )
      `
      await sql`
        INSERT INTO ontology_commits (
          project_id, id, idempotency_key, request_hash, execution_id, origin_kind, origin,
          executor, ontology_revision, intent, result, committed_at
        ) VALUES (
          'p', 'c-1', 'runtime:c-1', 'hash', 'x-1', 'runtime',
          ${jsonParameter(sql, commit.origin)}, ${jsonParameter(sql, attribution.executor)},
          'revision', '{}'::jsonb, '{}'::jsonb, ${commit.committedAt}
        )
      `
      for (const envelope of stored) {
        await sql`
          INSERT INTO ontology_outbox (
            project_id, id, commit_id, commit_ordinal, envelope, available_at, created_at
          ) VALUES (
            'p', ${envelope.id}, 'c-1', ${envelope.commitOrdinal}, ${jsonParameter(sql, envelope)},
            ${commit.committedAt}, ${commit.committedAt}
          )
        `
      }
    }

    // Removal proof: keep `propertyChanges` in a created draft, or drop a context field from the
    // rebuild; the claimed events no longer equal what 053 stored.
    test("keeps every pending event exactly as consumers would have received it", async () => {
      await withDatabase({ migrateThrough: index }, async ({ storage, sql }) => {
        await seedAt053(sql, envelopes)
        await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })

        expect(await readTableColumns(sql, "ontology_outbox")).not.toContain("envelope")
        const commitColumns = await readTableColumns(sql, "ontology_commits")
        expect(commitColumns).not.toContain("requested_by")
        expect(commitColumns).not.toContain("executor")
        expect([...(await sql`SELECT event FROM ontology_outbox ORDER BY commit_ordinal`)]).toEqual(
          drafts.map((event) => ({ event }))
        )
        const claimed = await storage.ontology.outbox.claim({
          projectId: "p",
          now: "2026-10-01T09:00:00.000Z",
          limit: 10,
          leaseId: "lease",
          leaseExpiresAt: "2026-10-01T09:01:00.000Z",
        })
        expect(claimed.map((row) => row.envelope)).toStrictEqual(envelopes)
      })
    })

    // Removal proof: drop the DO block from 054; the tampered event is converted and would reach
    // consumers with its execution's correlation id instead of its own.
    test("refuses to convert an event that would not rebuild from its commit", async () => {
      await withDatabase({ migrateThrough: index }, async ({ storage, sql }) => {
        const [first, ...rest] = envelopes
        await seedAt053(sql, [{ ...first!, correlationId: "elsewhere" }, ...rest])
        await expect(migrateStorage(storage)).rejects.toThrow(
          "1 outbox events would not rebuild from their commit"
        )
        expect(await readTableColumns(sql, "ontology_outbox")).toContain("envelope")
      })
    })
  })

  test("webhook delivery failure migration replaces legacy diagnostics with a safe failure", async () => {
    const index = indexOf("019-webhook-delivery-failure-record")
    await withDatabase({ migrateThrough: index }, async ({ sql, migrateThrough }) => {
      await sql.unsafe(`
        INSERT INTO webhook_deliveries (
          project_id, connector_id, webhook_id, idempotency_key, status,
          received_at, completed_at, failed_at, error
        ) VALUES
          (
            'project-a', 'github', 'events', 'delivery-failed-at', 'failed',
            '2026-08-10T12:00:00.000Z', NULL, '2026-08-10T12:01:00.000Z',
            'Error: handler unavailable'
          ),
          (
            'project-a', 'stripe', 'payments', 'delivery-received-at', 'failed',
            '2026-08-10T12:02:00.000Z', NULL, NULL,
            'Error: legacy row without failure time'
          )
      `)

      // Stop at 019: later authority migrations deliberately reject these legacy deliveries.
      await expect(migrateThrough(index + 1)).resolves.toMatchObject({ status: "migrated" })

      const rows = await sql.unsafe<
        Array<{ readonly idempotency_key: string; readonly failure: unknown | null }>
      >("SELECT idempotency_key, failure FROM webhook_deliveries ORDER BY idempotency_key")
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
      expect(await readTableColumns(sql, "webhook_deliveries")).toContain("failure")
      expect(await readTableColumns(sql, "webhook_deliveries")).not.toContain("error")
    })
  })

  test("recorded old checksums are rejected before schema mutation", async () => {
    await withDatabase({}, async ({ storage, sql }) => {
      await sql.unsafe(
        "UPDATE sixb_migrations SET checksum = 'old-checksum' WHERE adapter_id = $1 AND version = 1",
        [POSTGRES_STORAGE_ADAPTER_ID]
      )

      await expect(migrateStorage(storage)).rejects.toThrow("checksum")
      expect((await readMigrationRows(sql))[0]?.checksum_length).toBe("old-checksum".length)
      expect(await readTableNames(sql)).toContain("ontology_outbox")
    })
  })

  test("fresh schema installs the exact ontology table set, provenance columns, and no retired column", async () => {
    await withDatabase({}, async ({ sql }) => {
      expect((await readTableNames(sql)).filter((name) => name.startsWith("ontology_"))).toEqual([
        "ontology_commit_touch_horizons",
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
      const commitColumns = await readTableColumns(sql, "ontology_commits")
      for (const copy of ["actor", "requested_by", "executor", "correlation_id"]) {
        expect(commitColumns).not.toContain(copy)
      }
      expect(await readTableColumns(sql, "objects")).toContain("last_commit_id")
      expect(await readTableColumns(sql, "links")).toContain("last_commit_id")
      expect(await readTableColumns(sql, "timeseries")).toContain("last_commit_id")
      expect(await readTableColumns(sql, "ontology_commits")).toContain("execution_id")
      expect(await readTableColumns(sql, "objects")).not.toContain("source_event_id")
      expect(await readTableColumns(sql, "links")).not.toContain("source_event_id")
      expect(await readTableColumns(sql, "timeseries")).not.toContain("source_event_id")
      expect(await readTableNames(sql)).not.toContain("applied_events_objects")
      expect(await readColumnNullable(sql, "objects", "last_commit_id")).toBe("NO")
      expect(await readColumnNullable(sql, "links", "last_commit_id")).toBe("NO")
      expect(await readColumnNullable(sql, "timeseries", "last_commit_id")).toBe("NO")
      expect(await readColumnNullable(sql, "ontology_commits", "execution_id")).toBe("NO")
      expect(await readTableColumns(sql, "timeseries_latest")).toEqual(
        expect.arrayContaining([
          "object_type_id",
          "object_id",
          "property_id",
          "at",
          "last_commit_id",
        ])
      )
      expect(await readTableColumns(sql, "projection_runs")).toEqual(
        expect.arrayContaining([
          "attempt",
          "execution_id",
          "execution_token",
          "queued_at",
          "materialization_protocol",
          "dataset_version_created_at",
          "fixed_batch_size",
          "next_batch_ordinal",
          "next_row_offset",
          "input_exhausted",
          "error",
        ])
      )
      expect(await readColumnNullable(sql, "projection_runs", "execution_id")).toBe("NO")
      expect(await readColumnNullable(sql, "projection_runs", "queued_at")).toBe("NO")
      expect(await readColumnNullable(sql, "projection_runs", "started_at")).toBe("YES")
      expect(await readTableColumns(sql, "workflow_runs")).toEqual(
        expect.arrayContaining(["execution_id"])
      )
      expect(await readTableColumns(sql, "workflow_runs")).not.toEqual(
        expect.arrayContaining([
          "source",
          "requested_by_principal_type",
          "requested_by_principal_id",
        ])
      )
      expect(await readColumnNullable(sql, "workflow_runs", "execution_id")).toBe("NO")
      expect(await readTableColumns(sql, "action_runs")).toContain("execution_id")
      expect(await readColumnNullable(sql, "action_runs", "execution_id")).toBe("NO")
      for (const table of ["sync_runs", "pipeline_runs"] as const) {
        expect(await readColumnNullable(sql, table, "execution_id")).toBe("NO")
        expect(await readColumnNullable(sql, table, "queued_at")).toBe("NO")
        expect(await readColumnNullable(sql, table, "started_at")).toBe("YES")
      }
      expect(await readTableNames(sql)).not.toContain("webhook_deliveries")
      expect(await readTableColumns(sql, "webhook_runs")).not.toContain("delivery_claim_result")
      expect(await readColumnNullable(sql, "webhook_runs", "execution_id")).toBe("NO")
      expect(await readColumnNullable(sql, "webhook_runs", "request_body_bytes")).toBe("NO")
      expect(await readColumnNullable(sql, "webhook_runs", "request_body_sha256")).toBe("NO")
      expect(await readUniqueConstraints(sql, "webhook_runs")).toEqual(
        expect.arrayContaining([
          ["project_id", "execution_id"],
          ["project_id", "connector_id", "webhook_id", "idempotency_key"],
        ])
      )

      // Model-call usage belongs to an execution, which cannot be deleted from under it.
      expect(await readTableForeignKeys(sql, "ai_model_call_usage")).toContainEqual({
        column_name: "execution_id",
        delete_action: "r",
        foreign_column_name: "id",
        foreign_table_name: "executions",
      })
      expect(await readTableColumns(sql, "workflow_agent_node_runs")).toContain("actor_id")
      for (const [table, retired] of [
        ["auth_sessions", ["audience"]],
        ["ai_model_call_usage", ["execution_kind", "requester_principal_id"]],
        [
          "agent_runs",
          [
            "agent_id",
            "requester_group_ids",
            "usage_input_tokens",
            "usage_output_tokens",
            "usage_total_tokens",
            "usage_reasoning_tokens",
            "usage_cached_input_tokens",
          ],
        ],
        ["agent_threads", ["agent_id"]],
        ["workflow_agent_node_runs", ["agent_id", "usage"]],
        ["workflow_runs", ["requester_group_ids"]],
      ] as const) {
        const columns = await readTableColumns(sql, table)
        for (const column of retired) expect(columns).not.toContain(column)
      }
    })
  })

  test("backfills canonical workflow outputs by node index", async () => {
    await withDatabase({ migrate: false }, async ({ sql, schemaName, context }) => {
      await sql.unsafe(`CREATE SCHEMA ${quoteIdent(schemaName)}`)
      await steps[0]!.up(context)
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

      await steps[1]!.up(context)

      const rows = await sql.unsafe<{ id: string; output: unknown }[]>(
        "SELECT id, output FROM workflow_runs ORDER BY id"
      )
      expect([...rows]).toEqual([
        { id: "action-run", output: { seed: "kept" } },
        { id: "data-run", output: { winner: 10 } },
        { id: "failed-run", output: null },
      ])
    })
  })

  test("rewrites legacy intervention actors to the canonical principal shape", async () => {
    // Regression proof: remove 046; the legacy { principalType, principalId } values survive.
    const index = indexOf("046-workflow-intervention-principals")
    await withDatabase({ migrateThrough: index }, async ({ sql, context }) => {
      await sql.unsafe(`
        INSERT INTO workflow_interventions (
          project_id, id, workflow_id, workflow_run_id, node_run_id, node_index, node_id,
          node_key, intervention_id, input, default_response, status, requested_at,
          submitted_by, cancelled_by
        ) VALUES
          ('project-a', 'submitted', 'wf', 'run', 'node-run', 0, 'node', 'node', 'review',
           '{}', '{}', 'submitted', '2026-01-01T00:00:00.000Z',
           '{"principalType":"user","principalId":"usr_1"}', NULL),
          ('project-a', 'cancelled', 'wf', 'run', 'node-run', 0, 'node', 'node', 'review',
           '{}', '{}', 'cancelled', '2026-01-01T00:00:00.000Z',
           NULL, '{"principalType":"system","principalId":"workflow-timeout"}'),
          ('project-a', 'current', 'wf', 'run', 'node-run', 0, 'node', 'node', 'review',
           '{}', '{}', 'submitted', '2026-01-01T00:00:00.000Z',
           '{"type":"serviceAccount","id":"sa_1"}', NULL),
          ('project-a', 'pending', 'wf', 'run', 'node-run', 0, 'node', 'node', 'review',
           '{}', '{}', 'pending', '2026-01-01T00:00:00.000Z', NULL, NULL);
      `)

      await steps[index]!.up(context)

      const rows = await sql.unsafe<{ id: string; submitted_by: unknown; cancelled_by: unknown }[]>(
        "SELECT id, submitted_by, cancelled_by FROM workflow_interventions ORDER BY id"
      )
      expect([...rows]).toEqual([
        {
          id: "cancelled",
          submitted_by: null,
          cancelled_by: { type: "system", id: "workflow-timeout" },
        },
        {
          id: "current",
          submitted_by: { type: "serviceAccount", id: "sa_1" },
          cancelled_by: null,
        },
        { id: "pending", submitted_by: null, cancelled_by: null },
        { id: "submitted", submitted_by: { type: "user", id: "usr_1" }, cancelled_by: null },
      ])
    })
  })

  // Each migration links existing rows to a durable execution, which a legacy row cannot honestly
  // have: it must fail, and leave every table it touches as it was.
  test.each([
    [
      "workflow run",
      "005-workflow-executions",
      `INSERT INTO workflow_runs (project_id, id, workflow_id, status, input, started_at)
       VALUES ('project-a', 'legacy-run', 'legacy-workflow', 'queued', '{}',
         '2026-01-01T00:00:00.000Z')`,
      ["workflow_runs"],
    ],
    [
      "Action run",
      "008-action-executions",
      `INSERT INTO action_runs (
         project_id, id, action_id, subject_kind, status, phase, queued_at, params, idempotency_key
       ) VALUES (
         'project-a', 'legacy-action-run', 'legacy-action', 'none', 'queued', 'request',
         '2026-01-01T00:00:00.000Z', '{}', 'action:project-a:legacy-action-run'
       )`,
      ["action_runs"],
    ],
    [
      "Agent run",
      "009-agent-executions",
      `INSERT INTO agent_runs (
         project_id, id, thread_id, agent_id, trigger_message_id, status, created_at
       ) VALUES (
         'project-a', 'legacy-agent-run', 'legacy-thread', 'legacy-agent',
         'legacy-message', 'queued', '2026-01-01T00:00:00.000Z'
       )`,
      ["agent_runs"],
    ],
    [
      "Sync run",
      "021-sync-pipeline-executions",
      `INSERT INTO sync_runs (project_id, id, sync_id, dataset_id, mode, status, started_at)
       VALUES ('project-a', 'legacy-sync-run', 'sync-orders', 'raw.orders', 'snapshot',
         'running', '2026-01-01T00:00:00.000Z')`,
      ["sync_runs", "pipeline_runs"],
    ],
    [
      "Pipeline run",
      "021-sync-pipeline-executions",
      `INSERT INTO pipeline_runs (project_id, id, pipeline_id, status, started_at)
       VALUES ('project-a', 'legacy-pipeline-run', 'pipeline-orders', 'running',
         '2026-01-01T00:00:00.000Z')`,
      ["sync_runs", "pipeline_runs"],
    ],
    [
      "Projection run",
      "022-projection-executions",
      `INSERT INTO projection_runs (
         project_id, id, projection_id, projection_kind, materialization_protocol,
         dataset_id, dataset_version_id, dataset_version_created_at, ontology_revision,
         projection_revision, ownership_hash, object_type_id, status, started_at, attempt,
         execution_token
       ) VALUES (
         'project-a', 'legacy-projection-run', 'project-devices', 'object', 'replacement',
         'raw.devices', 'version-1', '2026-01-01T00:00:00.000Z', 'ontology-1',
         'projection-1', 'ownership-1', 'Device', 'running',
         '2026-01-01T00:00:00.000Z', 1, 'legacy-token'
       )`,
      ["projection_runs"],
    ],
    [
      "Webhook run",
      "023-webhook-executions",
      `INSERT INTO webhook_runs (
         project_id, id, connector_id, webhook_id, status, method, route, started_at
       ) VALUES (
         'project-a', 'legacy-webhook-run', 'github', 'events', 'running', 'POST',
         '/api/webhooks/github/events', '2026-01-01T00:00:00.000Z'
       )`,
      ["webhook_runs", "webhook_deliveries"],
    ],
    [
      "Webhook delivery",
      "023-webhook-executions",
      `INSERT INTO webhook_deliveries (
         project_id, connector_id, webhook_id, idempotency_key, status, received_at
       ) VALUES (
         'project-a', 'github', 'events', 'delivery-1', 'in_progress', '2026-01-01T00:00:00.000Z'
       )`,
      ["webhook_runs", "webhook_deliveries"],
    ],
    [
      "ontology commit",
      "024-ontology-commit-executions",
      `INSERT INTO ontology_commits (
         project_id, id, idempotency_key, request_hash, origin_kind, origin,
         ontology_revision, intent, result, committed_at
       ) VALUES (
         'project-a', 'legacy-commit', 'runtime:legacy-commit', 'legacy-hash', 'runtime',
         '{"kind":"runtime","requestId":"legacy-request"}', 'ontology-1',
         '{"kind":"edit","mode":"atomic","operationCount":0}',
         '{"kind":"edit","commitId":"legacy-commit","created":true,"eventCount":0,"committedAt":"2026-01-01T00:00:00.000Z","outcomes":[],"changes":{"objects":[],"links":[]}}',
         '2026-01-01T00:00:00.000Z'
       )`,
      ["ontology_commits"],
    ],
  ] as const)("rejects a legacy %s instead of inventing its execution authority (%s)", async (_record, migration, legacy, unchanged) => {
    const index = indexOf(migration)
    await withDatabase({ migrateThrough: index }, async ({ sql, context }) => {
      await sql.unsafe(legacy)

      await expect(steps[index]!.up(context)).rejects.toThrow()
      for (const table of unchanged) {
        const columns = await readTableColumns(sql, table)
        expect(columns.length).toBeGreaterThan(0)
        expect(columns).not.toContain("execution_id")
      }
    })
  })

  test("untracked existing schema collides and rolls back without conversion", async () => {
    await withDatabase({}, async ({ storage, sql }) => {
      await seedExistingStoreRows(storage)
      await sql.unsafe("DROP TABLE sixb_migrations")

      await expect(migrateStorage(storage)).rejects.toThrow("already exists")
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "project-a",
          objectTypeId: "Room",
          primaryId: "room:101",
        })
      ).toMatchObject({ properties: { name: "Legacy Room" } })
      expect(await readMigrationRows(sql)).toEqual([])
    })
  })

  test("stores a headless connector attempt as the run's single protocol child", async () => {
    await withDatabase({}, async ({ sql }) => {
      expect(await readTableColumns(sql, "connector_connection_runs")).not.toContain(
        "authorization_attempt_id"
      )
      expect(await readTableColumns(sql, "connector_authorization_attempts")).not.toContain(
        "owner_type"
      )
      expect(await readTableColumns(sql, "connector_connections")).not.toContain("owner_type")
      expect(await readUniqueConstraints(sql, "connector_authorization_attempts")).toContainEqual([
        "project_id",
        "connector_id",
        "connection_run_id",
      ])
      expect(await readTableForeignKeys(sql, "connector_authorization_attempts")).toContainEqual({
        column_name: "connection_run_id",
        delete_action: "r",
        foreign_column_name: "id",
        foreign_table_name: "connector_connection_runs",
      })
      expect(await readUniqueConstraints(sql, "connector_connections")).toContainEqual([
        "project_id",
        "connector_id",
        "slot",
      ])
    })
  })

  test("AI cost accounting migration preserves existing Phase 1 usage rows", async () => {
    const index = indexOf("026-ai-cost-accounting")
    await withDatabase({ migrateThrough: index }, async ({ sql, context }) => {
      await sql.unsafe(`
        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id, correlation_id,
          authority_kind, authority_primitive_kind, authority_primitive_id, created_at
        ) VALUES (
          'project-a', 'execution-1', 'workflow', 'workflow-1', 'event', 'event-1',
          'correlation-1', 'trustedPrimitive', 'workflow', 'workflow-1',
          '2026-08-01T11:59:00.000Z'
        );

        INSERT INTO ai_model_call_usage (
          project_id, id, execution_id, attempt, call_id, provider_id, requested_model_id,
          response_id, input_tokens, output_tokens, total_tokens, reporting_status, raw_usage,
          occurred_at, recorded_at
        ) VALUES (
          'project-a', 'usage-1', 'execution-1', 1, 'call-1', 'gateway', 'openai/gpt-5',
          'response-1', 12, 8, 20, 'complete', '{"inputTokens":12,"outputTokens":8}',
          '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:01.000Z'
        );
      `)
      const before = [
        ...(await sql.unsafe<Record<string, unknown>[]>("SELECT * FROM ai_model_call_usage")),
      ]

      await steps[index]!.up(context)

      expect([
        ...(await sql.unsafe<Record<string, unknown>[]>("SELECT * FROM ai_model_call_usage")),
      ]).toEqual(before)
      expect(await readTableColumns(sql, "ai_model_call_valuations")).toEqual(
        expect.arrayContaining(["usage_record_id", "status", "details", "amount_nanos", "rated_at"])
      )
      expect(await readTableColumns(sql, "ai_price_schedules")).toEqual([])
      await sql.unsafe(`
        INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id, currency, amount_nanos,
          reason, details, rated_at
        ) VALUES (
          'project-a', 'usage-1', 'rated', 'vercel', 'openai/gpt-5', 'USD', 20,
          NULL, '{"pricingContext":{},"historical":"preserve"}', '2026-08-01T12:00:01.000Z'
        )
      `)
      const oldCost = [...(await sql.unsafe("SELECT * FROM ai_model_call_valuations"))]
      await expect(
        context.exec("UPDATE ai_model_call_valuations SET status = 'reported'")
      ).rejects.toThrow()
      for (const migration of steps.slice(index + 1)) {
        await migration.up(context)
      }
      // Later agent migrations must preserve the native accounting rows and constraints.
      expect([...(await sql.unsafe("SELECT * FROM ai_model_call_valuations"))]).toEqual(oldCost)
      expect([
        ...(await sql.unsafe<Record<string, unknown>[]>("SELECT * FROM ai_model_call_usage")),
      ]).toEqual(
        before.map((row) => ({
          ...row,
          requested_reasoning: null,
          provider_ids: null,
          audio_duration_ms: null,
          model_kind: null,
          image_output_tokens: null,
          audio_output_tokens: null,
          output_images: null,
          input_characters: null,
        }))
      )
      await expect(
        context.exec("UPDATE ai_model_call_valuations SET status = 'reported'")
      ).rejects.toThrow()
      await expect(
        context.exec("UPDATE ai_model_call_valuations SET amount_nanos = NULL")
      ).rejects.toThrow()
    })
  })

  test("drops only obsolete run usage projections from an existing schema", async () => {
    // Regression guard: remove migration 020 (or any one DROP COLUMN) and this leaves the old
    // projection column behind; deleting the run rows instead breaks the preservation assertions.
    const index = indexOf("020-drop-run-usage-projections")
    await withDatabase({ migrateThrough: index }, async ({ sql, context }) => {
      await sql.unsafe(`
        INSERT INTO auth_service_accounts (
          project_id, id, name, status, created_by_system_id, created_at, updated_at
        ) VALUES (
          'project-a', 'agent:sales', 'Sales Agent', 'active', 'test',
          '2026-07-01T11:55:00.000Z', '2026-07-01T11:55:00.000Z'
        );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, authority_kind, authority_primitive_kind, authority_primitive_id,
          created_at
        ) VALUES
          (
            'project-a', 'request-execution-1', 'request', 'request-1', 'http', 'request-1',
            'correlation-1', 'disabled', NULL, NULL, '2026-07-01T11:56:00.000Z'
          ),
          (
            'project-a', 'workflow-execution-1', 'workflow', 'workflow-run-1', 'event',
            'event-1', 'correlation-2', 'trustedPrimitive', 'workflow', 'resolve-transaction',
            '2026-07-01T11:56:00.000Z'
          );

        INSERT INTO executions (
          project_id, id, executor_kind, executor_id, source_kind, source_id,
          correlation_id, parent_execution_id, authority_kind,
          authority_service_account_id, created_at
        ) VALUES
          (
            'project-a', 'agent-execution-1', 'agent', 'run-1', 'execution',
            'request-execution-1', 'correlation-1', 'request-execution-1', 'principal',
            'agent:sales', '2026-07-01T11:57:00.000Z'
          ),
          (
            'project-a', 'node-execution-1', 'agent', 'node-1', 'execution',
            'workflow-execution-1', 'correlation-2', 'workflow-execution-1', 'principal',
            'agent:sales', '2026-07-01T11:57:00.000Z'
          );

        INSERT INTO agent_runs (
          project_id, id, execution_id, thread_id, agent_id, trigger_message_id, status,
          usage_input_tokens, usage_output_tokens, usage_total_tokens, created_at
        ) VALUES (
          'project-a', 'run-1', 'agent-execution-1', 'thread-1', 'sales', 'message-1',
          'succeeded', 12, 8, 20, '2026-07-01T12:00:00.000Z'
        );

        INSERT INTO workflow_runs (
          project_id, id, execution_id, workflow_id, status, input, started_at
        ) VALUES (
          'project-a', 'workflow-run-1', 'workflow-execution-1', 'resolve-transaction',
          'succeeded', '{}', '2026-07-01T12:00:00.000Z'
        );
        INSERT INTO workflow_node_runs (
          project_id, id, workflow_run_id, workflow_id, node_index, node_type, node_id,
          node_key, status, input, started_at
        ) VALUES (
          'project-a', 'node-1', 'workflow-run-1', 'resolve-transaction', 0, 'agent',
          'resolve-agent', 'resolveAgent', 'succeeded', '{}', '2026-07-01T12:00:00.000Z'
        );
        INSERT INTO workflow_agent_node_runs (
          project_id, node_run_id, execution_id, agent_id, status, prompt, usage, created_at
        ) VALUES (
          'project-a', 'node-1', 'node-execution-1', 'sales', 'succeeded', 'Resolve it',
          '{"inputTokens":12,"outputTokens":8}', '2026-07-01T12:00:00.000Z'
        );
      `)

      await steps[index]!.up(context)

      const agentColumns = await readTableColumns(sql, "agent_runs")
      const workflowColumns = await readTableColumns(sql, "workflow_agent_node_runs")
      expect(agentColumns.some((column) => column.startsWith("usage_"))).toBe(false)
      expect(workflowColumns).not.toContain("usage")
      expect([
        ...(await sql`SELECT id, execution_id, status FROM agent_runs WHERE id = 'run-1'`),
      ]).toEqual([{ id: "run-1", execution_id: "agent-execution-1", status: "succeeded" }])
      expect([
        ...(await sql`
          SELECT node_run_id, execution_id, status FROM workflow_agent_node_runs
          WHERE node_run_id = 'node-1'
        `),
      ]).toEqual([{ node_run_id: "node-1", execution_id: "node-execution-1", status: "succeeded" }])
    })
  })

  test("dirty migration history blocks storage migrations", async () => {
    // A started row above the applied ones: a dirty history has to block a schema that is
    // otherwise current, which is the case an operator actually meets after a migration was
    // interrupted.
    await withDatabase({}, async ({ storage, sql }) => {
      await sql.unsafe(
        `
          INSERT INTO sixb_migrations (
            adapter_id, version, id, checksum, status, started_at, finished_at
          ) VALUES ($1, 9999, '9999-interrupted', NULL, 'started', $2, NULL)
        `,
        [POSTGRES_STORAGE_ADAPTER_ID, "2026-04-19T00:00:00.000Z"]
      )

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
    await withDatabase({ migrate: false }, async ({ storage, schemaName, sql }) => {
      const [migrator] = storage.migrators
      const status = await migrator?.status()

      expect(status).toMatchObject({
        adapterId: POSTGRES_STORAGE_ADAPTER_ID,
        state: "uninitialized",
        appliedVersion: 0,
      })
      expect(status?.reason).toBeTruthy()
      // No DDL ran: the schema itself never came into existence.
      const [schema] = await sql<
        { oid: string | null }[]
      >`SELECT to_regnamespace(${schemaName}) AS oid`
      expect(schema?.oid).toBeNull()
    })
  })

  test("status() reports current after a migration", async () => {
    await withDatabase({}, async ({ storage }) => {
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

  test("serializes concurrent migrations, records each shipped migration once, then is current", async () => {
    await withDatabase(
      { migrate: false },
      async ({ storage, schemaName, sql, connectionString }) => {
        const peers = Array.from(
          { length: 3 },
          () => new PostgresStorage({ connectionString, schemaName, max: 2 })
        )
        try {
          const results = await Promise.all(
            [storage, ...peers].map((candidate) => migrateStorage(candidate))
          )

          expect(results.map((result) => result.status).sort()).toEqual([
            "current",
            "current",
            "current",
            "migrated",
          ])
          const [report] = results.find((result) => result.status === "migrated")?.reports ?? []
          expect(report).toMatchObject({
            adapterId: POSTGRES_STORAGE_ADAPTER_ID,
            status: "migrated",
          })
          expect(report?.applied).toEqual(SHIPPED_MIGRATIONS)
          expect(await readMigrationRows(sql)).toEqual(
            SHIPPED_MIGRATIONS.map((id, index) => ({
              adapter_id: POSTGRES_STORAGE_ADAPTER_ID,
              checksum_length: 64,
              id,
              status: "applied",
              version: index + 1,
            }))
          )
          await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "current" })
        } finally {
          await Promise.all(peers.map((peer) => peer.close()))
        }
      }
    )
  })
})

interface MigrationFixture {
  readonly storage: PostgresStorage
  readonly schemaName: string
  readonly connectionString: string
  /** A client on the fixture's schema. */
  readonly sql: SQL
  /** Runs one migration's SQL directly, outside the runner and its history. */
  readonly context: PostgresMigrationContext
  /** Runs the shipped migrations through the first `count`, as an upgrade would. */
  migrateThrough(count: number): Promise<MigrationReport>
}

/** A database of its own, migrated as `options` asks (see `createTestStorage`). */
async function withDatabase(
  options: TestStorageOptions,
  run: (fixture: MigrationFixture) => Promise<void>
): Promise<void> {
  const { storage, schemaName, connectionString } = await createTestStorage(options)
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  try {
    await run({
      storage,
      schemaName,
      connectionString,
      sql,
      context: { exec: (text) => sql.unsafe(text).then(() => undefined) },
      migrateThrough: (count) =>
        createPostgresMigrator({
          sql,
          schemaName,
          migrations: defineMigrations({
            adapterId: POSTGRES_STORAGE_ADAPTER_ID,
            steps: steps.slice(0, count),
          }),
        }).migrate(),
    })
  } finally {
    await sql.end()
    await disposeTestStorage(storage)
  }
}

function indexOf(id: string): number {
  const index = steps.findIndex((step) => step.id === id)
  if (index < 0) throw new Error(`[SixbPg] Migration ${id} is missing.`)
  return index
}

/**
 * A thread whose second turn compacted the first, both finished. Written as rows: it seeds a
 * schema older than the code reading it.
 */
async function seedCompactedThread(storage: PostgresStorage, sql: SQL): Promise<void> {
  const projectId = "project-a"
  await sql`
    INSERT INTO agent_threads (
      project_id, id, owner_principal_type, owner_principal_id, status, message_count, created_at,
      updated_at
    ) VALUES (
      ${projectId}, 'thread-1', 'user', 'usr-1', 'active', 4, '2026-07-01T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z'
    )
  `
  for (const runId of ["run-1", "run-2"]) {
    const executionId = await createTestAgentExecution(storage, { projectId, runId })
    await sql`
      INSERT INTO agent_runs (
        project_id, id, execution_id, kind, thread_id, trigger_message_id, spec, status, created_at
      ) VALUES (
        ${projectId}, ${runId}, ${executionId}, 'conversation', 'thread-1',
        ${runId === "run-1" ? "question-1" : "question-2"},
        '{"model":{"provider":"test","modelId":"test-model"}}'::jsonb, 'succeeded',
        '2026-07-01T12:00:00.000Z'
      )
    `
  }
  for (const [seq, id, runId, role] of [
    [1, "question-1", null, "user"],
    [2, "answer-1", "run-1", "assistant"],
    [3, "question-2", null, "user"],
    [4, "answer-2", "run-2", "assistant"],
  ] as const) {
    await sql`
      INSERT INTO agent_messages (
        project_id, id, thread_id, run_id, role, seq, parts, content_version, created_at
      ) VALUES (
        ${projectId}, ${id}, 'thread-1', ${runId}, ${role}, ${seq},
        ${JSON.stringify([{ type: "text", text: id }])}::text::jsonb, 2, '2026-07-01T12:00:00.000Z'
      )
    `
  }
  await sql`
    INSERT INTO agent_context_checkpoints (
      project_id, id, thread_id, created_by_run_id, reason, summary, summary_format_version,
      summarized_through_seq, observed_head_seq, estimated_input_tokens_before,
      estimated_input_tokens_after, summary_model_id, created_at
    ) VALUES (
      ${projectId}, 'checkpoint-1', 'thread-1', 'run-2', 'threshold',
      'The first question was answered.', 1, 2, 3, 1000, 300, 'test-model',
      '2026-07-01T12:00:00.000Z'
    )
  `
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
  await startTestSyncRun(storage, {
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
  const projectionRun = await startTestProjectionRun(storage, {
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
  await startTestWebhookRun(storage, {
    id: "webhook-run-1",
    projectId: "project-a",
    connectorId: "github",
    webhookId: "events",
    method: "POST",
    route: "/api/webhooks/github/events",
    requestBodyBytes: 12,
    requestBodySha256: "0".repeat(64),
    idempotencyKey: "delivery-1",
    startedAt: new Date("2026-04-19T12:00:00.000Z"),
  })
  await storage.webhookRuns.finish({
    id: "webhook-run-1",
    projectId: "project-a",
    status: "succeeded",
    finishedAt: new Date("2026-04-19T12:00:02.000Z"),
    responseStatus: 202,
  })
}

async function readMigrationRows(sql: SQL): Promise<
  Array<{
    adapter_id: string
    checksum_length: number
    id: string
    status: string
    version: number
  }>
> {
  const rows = await sql<
    {
      adapter_id: string
      checksum_length: number | string
      id: string
      status: string
      version: number
    }[]
  >`
    SELECT adapter_id, version, id, status, length(checksum) AS checksum_length
    FROM sixb_migrations
    ORDER BY adapter_id, version
  `
  return rows.map((row) => ({ ...row, checksum_length: Number(row.checksum_length) }))
}

async function readTableNames(sql: SQL): Promise<readonly string[]> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename
  `
  return rows.map((row) => row.tablename)
}

async function readTableColumns(sql: SQL, tableName: string): Promise<readonly string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${tableName}
    ORDER BY ordinal_position
  `
  return rows.map((row) => row.column_name)
}

async function readTableForeignKeys(
  sql: SQL,
  tableName: string
): Promise<
  readonly {
    readonly column_name: string
    readonly delete_action: string
    readonly foreign_column_name: string
    readonly foreign_table_name: string
  }[]
> {
  return sql<
    {
      readonly column_name: string
      readonly delete_action: string
      readonly foreign_column_name: string
      readonly foreign_table_name: string
    }[]
  >`
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
      AND source_schema.nspname = current_schema()
      AND source_table.relname = ${tableName}
    ORDER BY c.conname, source_key.position
  `
}

async function readColumnNullable(
  sql: SQL,
  tableName: string,
  columnName: string
): Promise<"YES" | "NO"> {
  const [row] = await sql<{ is_nullable: "YES" | "NO" }[]>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `
  if (!row) throw new Error(`Column ${tableName}.${columnName} was not found.`)
  return row.is_nullable
}

async function readUniqueConstraints(
  sql: SQL,
  tableName: string
): Promise<readonly (readonly string[])[]> {
  const rows = await sql<{ readonly constraint_name: string; readonly column_name: string }[]>`
    SELECT tc.constraint_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = ${tableName}
      AND tc.constraint_type = 'UNIQUE'
    ORDER BY tc.constraint_name, kcu.ordinal_position
  `
  const constraints = new Map<string, string[]>()
  for (const row of rows) {
    const columns = constraints.get(row.constraint_name) ?? []
    columns.push(row.column_name)
    constraints.set(row.constraint_name, columns)
  }
  return [...constraints.values()]
}
