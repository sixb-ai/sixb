import { parseSixbFailure } from "@sixb/core/internal/errors"
import type { ProjectionEntityRef } from "@sixb/core/internal/materialization"
import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import type {
  AssertSourceMaterializationExecutionInput,
  OntologyCommitRecord,
  OntologyCommitWrite,
  OntologyOutboxRecord,
  OntologySourceRecord,
  StageSourceAssertion,
} from "@sixb/core/storage"
import { ONTOLOGY_OUTBOX_FAILURE_CODES } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"

export {
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertTimestamp,
  canonicalJson,
  linkRefFromColumns,
  objectRefFromColumns,
  originColumns,
  originWhere,
  sourceEntityKey,
} from "@sixb/core/internal/ontology-storage-provider"

export type PgRootOperation = <T>(run: (sql: SQLClient) => Promise<T>) => Promise<T>

type PgJsonValue = Parameters<SQLClient["json"]>[0]

export interface PgOntologyCommitRow {
  readonly project_id: string
  readonly id: string
  readonly idempotency_key: string
  readonly request_hash: string
  readonly origin_kind: string
  readonly origin_run_id: string | null
  readonly origin_batch_ordinal: number | string | null
  readonly origin: unknown
  readonly actor: unknown | null
  readonly ontology_revision: string
  readonly projection_revision: string | null
  readonly ownership_hash: string | null
  readonly intent: unknown
  readonly result: unknown
  readonly committed_at: Date | string
}

export interface PgOntologySourceRow {
  readonly project_id: string
  readonly source_id: string
  readonly materialization_id: string
  readonly projection_run_id: string
  readonly projection_kind: "object" | "link"
  readonly protocol: "replacement"
  readonly status: OntologySourceRecord["status"]
  readonly execution_token: string | null
  readonly dataset_id: string
  readonly dataset_version_id: string
  readonly dataset_version_created_at: Date | string
  readonly projection_revision: string
  readonly ownership_hash: string
  readonly ontology_revision: string
  readonly root_count: number | string | null
  readonly assertion_count: number | string | null
  readonly created_at: Date | string
  readonly ready_at: Date | string | null
  readonly activated_at: Date | string | null
  readonly terminal_at: Date | string | null
  readonly last_commit_id: string | null
  readonly updated_at: Date | string
}

export interface PgOntologySourceAssertionRow {
  readonly project_id: string
  readonly source_id: string
  readonly materialization_id: string
  readonly entity_kind: "object" | "link"
  readonly entity_key: unknown
  readonly entity_sort_key: string
  readonly root_kind: "object" | "link"
  readonly root_key: unknown
  readonly root_sort_key: string
  readonly staging_ordinal: number | string
  readonly root: unknown
  readonly assertion: unknown
}

export interface PgStoredOverrideRow {
  readonly value: unknown
  readonly last_commit_id: string
  readonly updated_at: Date | string
}

export interface PgOntologyOutboxRow {
  readonly envelope: unknown
  readonly available_at: Date | string
  readonly attempts: number | string
  readonly lease_id: string | null
  readonly lease_expires_at: Date | string | null
  readonly published_at: Date | string | null
  readonly last_failure: unknown | null
  readonly created_at: Date | string
}

export function jsonParameter(sql: SQLClient, value: unknown): ReturnType<SQLClient["json"]> {
  return sql.json(value as PgJsonValue)
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function optionalIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value)
}

export function databaseSafeInteger(value: number | string, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MaterializationConflictError(
      "effective-state",
      `${label} is outside the nonnegative safe-integer range.`
    )
  }
  return result
}

export function sourceRecord(row: PgOntologySourceRow): OntologySourceRecord {
  return {
    projectId: row.project_id,
    source: { projectionId: row.source_id },
    materializationId: row.materialization_id,
    projectionRunId: row.projection_run_id,
    projectionKind: row.projection_kind,
    protocol: row.protocol,
    status: row.status,
    executionToken: row.execution_token,
    datasetVersion: {
      datasetId: row.dataset_id,
      versionId: row.dataset_version_id,
      createdAt: toIsoString(row.dataset_version_created_at),
    },
    projectionRevision: row.projection_revision,
    ownershipHash: row.ownership_hash,
    ontologyRevision: row.ontology_revision,
    rootCount:
      row.root_count === null ? null : databaseSafeInteger(row.root_count, "Source root count"),
    assertionCount:
      row.assertion_count === null
        ? null
        : databaseSafeInteger(row.assertion_count, "Source assertion count"),
    createdAt: toIsoString(row.created_at),
    readyAt: optionalIsoString(row.ready_at),
    activatedAt: optionalIsoString(row.activated_at),
    terminalAt: optionalIsoString(row.terminal_at),
    lastCommitId: row.last_commit_id,
    updatedAt: toIsoString(row.updated_at),
  }
}

export function sourceAssertion(row: PgOntologySourceAssertionRow): StageSourceAssertion {
  return {
    root: structuredClone(row.root) as ProjectionEntityRef,
    assertion: structuredClone(row.assertion) as StageSourceAssertion["assertion"],
    stagingOrdinal: databaseSafeInteger(row.staging_ordinal, "Source staging ordinal"),
  }
}

export function commitRecord(row: PgOntologyCommitRow): OntologyCommitRecord {
  const base = {
    projectId: row.project_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    origin: structuredClone(row.origin) as OntologyCommitWrite["origin"],
    ...(row.actor === null
      ? {}
      : {
          actor: structuredClone(row.actor) as NonNullable<OntologyCommitWrite["actor"]>,
        }),
    ontologyRevision: row.ontology_revision,
    ...(row.projection_revision === null ? {} : { projectionRevision: row.projection_revision }),
    ...(row.ownership_hash === null ? {} : { ownershipHash: row.ownership_hash }),
    committedAt: toIsoString(row.committed_at),
  }
  const intent = structuredClone(row.intent) as OntologyCommitWrite["intent"]
  const result = structuredClone(row.result) as OntologyCommitRecord["result"]
  return { ...base, intent, result } as OntologyCommitRecord
}

export function outboxRecord(row: PgOntologyOutboxRow): OntologyOutboxRecord {
  return {
    envelope: structuredClone(row.envelope) as OntologyOutboxRecord["envelope"],
    availableAt: toIsoString(row.available_at),
    attempts: databaseSafeInteger(row.attempts, "Ontology outbox attempts"),
    leaseId: row.lease_id,
    leaseExpiresAt: optionalIsoString(row.lease_expires_at),
    publishedAt: optionalIsoString(row.published_at),
    lastFailure:
      row.last_failure === null
        ? null
        : parseSixbFailure(row.last_failure, ONTOLOGY_OUTBOX_FAILURE_CODES),
    createdAt: toIsoString(row.created_at),
  }
}

export async function assertProjectionExecution(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly projectionRunId: string
    readonly executionToken: string
    readonly identity?: AssertSourceMaterializationExecutionInput["identity"]
  }
): Promise<void> {
  const [run] = await sql<
    {
      readonly projection_id: string
      readonly projection_kind: string
      readonly status: string
      readonly materialization_protocol: string | null
      readonly execution_token: string | null
      readonly dataset_id: string
      readonly dataset_version_id: string
      readonly dataset_version_created_at: Date | string | null
      readonly ontology_revision: string | null
      readonly projection_revision: string | null
      readonly ownership_hash: string | null
    }[]
  >`
    SELECT projection_id, projection_kind, status, materialization_protocol, execution_token,
      dataset_id, dataset_version_id, dataset_version_created_at,
      ontology_revision, projection_revision, ownership_hash
    FROM projection_runs
    WHERE project_id = ${input.projectId} AND id = ${input.projectionRunId}
    FOR UPDATE
  `
  if (!run || run.status !== "running") {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection run '${input.projectionRunId}' is missing or is not running.`
    )
  }
  if (run.projection_id !== input.sourceId || run.materialization_protocol !== "replacement") {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection run '${input.projectionRunId}' does not own replacement source '${input.sourceId}'.`
    )
  }
  if (run.execution_token !== input.executionToken) {
    throw new MaterializationConflictError(
      "execution-lost",
      `Projection run '${input.projectionRunId}' execution token is stale.`
    )
  }
  const identity = input.identity
  if (
    identity &&
    (run.projection_kind !== identity.projectionKind ||
      run.materialization_protocol !== identity.protocol ||
      run.dataset_id !== identity.datasetVersion.datasetId ||
      run.dataset_version_id !== identity.datasetVersion.versionId ||
      run.dataset_version_created_at === null ||
      toIsoString(run.dataset_version_created_at) !== identity.datasetVersion.createdAt ||
      run.ontology_revision !== identity.ontologyRevision ||
      run.projection_revision !== identity.projectionRevision ||
      run.ownership_hash !== identity.ownershipHash)
  ) {
    throw new MaterializationConflictError(
      "run-correlation",
      `Projection run '${input.projectionRunId}' immutable source identity does not match.`
    )
  }
}

export function ontologyLockKey(kind: string, ...parts: readonly string[]): string {
  return `ontology:${kind}:${JSON.stringify(parts)}`
}
