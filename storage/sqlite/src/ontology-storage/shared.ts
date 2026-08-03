import type { Database } from "bun:sqlite"
import type { ProjectionEntityRef } from "@sixb/core/internal/materialization"
import type {
  AssertSourceMaterializationExecutionInput,
  OntologyCommitRecord,
  OntologyCommitWrite,
  OntologyOutboxRecord,
  OntologySourceRecord,
  StageSourceAssertion,
} from "@sixb/core/storage"

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

import {
  type MaterializationConflictKind,
  materializationConflict,
} from "@sixb/core/internal/materialization"

export type SqliteRootOperation = <T>(run: () => Promise<T> | T) => Promise<T>

export interface SqliteOntologyCommitRow {
  readonly project_id: string
  readonly id: string
  readonly idempotency_key: string
  readonly request_hash: string
  readonly origin_kind: string
  readonly origin_run_id: string | null
  readonly origin_batch_ordinal: number | null
  readonly origin: string
  readonly actor: string | null
  readonly ontology_revision: string
  readonly projection_revision: string | null
  readonly ownership_hash: string | null
  readonly intent: string
  readonly result: string
  readonly committed_at: string
}

export interface SqliteOntologySourceRow {
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
  readonly dataset_version_created_at: string
  readonly projection_revision: string
  readonly ownership_hash: string
  readonly ontology_revision: string
  readonly root_count: number | null
  readonly assertion_count: number | null
  readonly created_at: string
  readonly ready_at: string | null
  readonly activated_at: string | null
  readonly terminal_at: string | null
  readonly last_commit_id: string | null
  readonly updated_at: string
}

export interface SqliteOntologySourceAssertionRow {
  readonly project_id: string
  readonly source_id: string
  readonly materialization_id: string
  readonly entity_kind: "object" | "link"
  readonly entity_key: string
  readonly entity_sort_key: string
  readonly root_kind: "object" | "link"
  readonly root_key: string
  readonly root_sort_key: string
  readonly staging_ordinal: number
  readonly root: string
  readonly assertion: string
}

export interface SqliteOntologyOverrideRow {
  readonly entity_kind: "object" | "link"
  readonly value: string
  readonly last_commit_id: string
  readonly updated_at: string
}

export interface SqliteOntologyOutboxRow {
  readonly envelope: string
  readonly available_at: string
  readonly attempts: number
  readonly lease_id: string | null
  readonly lease_expires_at: string | null
  readonly published_at: string | null
  readonly last_error: string | null
  readonly created_at: string
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

export function sourceRecord(row: SqliteOntologySourceRow): OntologySourceRecord {
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
      createdAt: row.dataset_version_created_at,
    },
    projectionRevision: row.projection_revision,
    ownershipHash: row.ownership_hash,
    ontologyRevision: row.ontology_revision,
    rootCount: row.root_count,
    assertionCount: row.assertion_count,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
    terminalAt: row.terminal_at,
    lastCommitId: row.last_commit_id,
    updatedAt: row.updated_at,
  }
}

export function sourceAssertion(row: SqliteOntologySourceAssertionRow): StageSourceAssertion {
  return {
    root: parseJson<ProjectionEntityRef>(row.root),
    assertion: parseJson<StageSourceAssertion["assertion"]>(row.assertion),
    stagingOrdinal: row.staging_ordinal,
  }
}

export function commitRecord(row: SqliteOntologyCommitRow): OntologyCommitRecord {
  const base = {
    projectId: row.project_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    origin: parseJson<OntologyCommitWrite["origin"]>(row.origin),
    ...(row.actor === null
      ? {}
      : { actor: parseJson<NonNullable<OntologyCommitWrite["actor"]>>(row.actor) }),
    ontologyRevision: row.ontology_revision,
    ...(row.projection_revision === null ? {} : { projectionRevision: row.projection_revision }),
    ...(row.ownership_hash === null ? {} : { ownershipHash: row.ownership_hash }),
    committedAt: row.committed_at,
  }
  const intent = parseJson<OntologyCommitWrite["intent"]>(row.intent)
  const result = parseJson<OntologyCommitRecord["result"]>(row.result)
  return { ...base, intent, result } as OntologyCommitRecord
}

export function outboxRecord(row: SqliteOntologyOutboxRow): OntologyOutboxRecord {
  return {
    envelope: parseJson<OntologyOutboxRecord["envelope"]>(row.envelope),
    availableAt: row.available_at,
    attempts: row.attempts,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    publishedAt: row.published_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  }
}

export function assertProjectionExecution(
  db: Database,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly projectionRunId: string
    readonly executionToken: string
    readonly identity?: AssertSourceMaterializationExecutionInput["identity"]
  }
): void {
  const run = db
    .query(
      `
        SELECT projection_id, projection_kind, status, materialization_protocol, execution_token,
          dataset_id, dataset_version_id, dataset_version_created_at,
          ontology_revision, projection_revision, ownership_hash
        FROM projection_runs
        WHERE project_id = ? AND id = ?
      `
    )
    .get(input.projectId, input.projectionRunId) as {
    projection_id: string
    projection_kind: string
    status: string
    materialization_protocol: string | null
    execution_token: string | null
    dataset_id: string
    dataset_version_id: string
    dataset_version_created_at: string | null
    ontology_revision: string | null
    projection_revision: string | null
    ownership_hash: string | null
  } | null
  if (!run || run.status !== "running") {
    throw materializationConflict(
      "run-correlation",
      `Projection run '${input.projectionRunId}' is missing or is not running.`
    )
  }
  if (run.projection_id !== input.sourceId || run.materialization_protocol !== "replacement") {
    throw materializationConflict(
      "run-correlation",
      `Projection run '${input.projectionRunId}' does not own replacement source '${input.sourceId}'.`
    )
  }
  if (run.execution_token !== input.executionToken) {
    throw materializationConflict(
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
      run.dataset_version_created_at !== identity.datasetVersion.createdAt ||
      run.ontology_revision !== identity.ontologyRevision ||
      run.projection_revision !== identity.projectionRevision ||
      run.ownership_hash !== identity.ownershipHash)
  ) {
    throw materializationConflict(
      "run-correlation",
      `Projection run '${input.projectionRunId}' immutable source identity does not match.`
    )
  }
}

export function requireChanges(
  changes: number,
  kind: MaterializationConflictKind,
  message: string
): void {
  if (changes !== 1) throw materializationConflict(kind, message)
}

export function isSqliteConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const details = error as Error & { readonly code?: unknown; readonly errno?: unknown }
  if (typeof details.code === "string") {
    return [
      "SQLITE_CONSTRAINT_CHECK",
      "SQLITE_CONSTRAINT_FOREIGNKEY",
      "SQLITE_CONSTRAINT_NOTNULL",
      "SQLITE_CONSTRAINT_PRIMARYKEY",
      "SQLITE_CONSTRAINT_UNIQUE",
    ].includes(details.code)
  }
  return details.errno === 19
}
