import { parseSixbFailure } from "@sixb/core/internal/errors"
import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import {
  type ClaimedOutboxDraft,
  sourceAssertionFromColumns,
  sourceEntityFromKey,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  AssertSourceMaterializationExecutionInput,
  OntologyCommitRecord,
  OntologyCommitWrite,
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
  readonly execution_id: string
  readonly origin_kind: string
  readonly origin_run_id: string | null
  readonly origin_batch_ordinal: number | string | null
  readonly origin: unknown
  readonly ontology_revision: string
  readonly projection_revision: string | null
  readonly ownership_hash: string | null
  readonly intent: unknown
  readonly result: unknown
  readonly committed_at: Date | string
}

export interface PgOntologySourceRow {
  readonly version_id: string
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
  readonly base_materialization_id: string | null
  readonly base_commit_id: string | null
  readonly assertion_count: number | string | null
  readonly created_at: Date | string
  readonly ready_at: Date | string | null
  readonly activated_at: Date | string | null
  readonly terminal_at: Date | string | null
  readonly last_commit_id: string | null
  readonly updated_at: Date | string
}

/** An assertion with its root and version, as `sourceAssertionColumns` selects it. */
export interface PgOntologySourceAssertionRow {
  readonly source_id: string
  readonly materialization_id: string
  readonly root_key: string
  readonly staging_ordinal: number | string
  readonly entity_kind: "object" | "link"
  readonly object_type_id: string | null
  readonly primary_id: string | null
  readonly source_type_id: string | null
  readonly source_primary_id: string | null
  readonly link_id: string | null
  readonly target_type_id: string | null
  readonly target_primary_id: string | null
  readonly payload: unknown
}

export interface PgStoredOverrideRow {
  readonly value: unknown
  readonly last_commit_id: string
  readonly updated_at: Date | string
}

export interface PgOntologyOutboxRow {
  readonly id: string
  readonly commit_id: string
  readonly commit_ordinal: number | string
  readonly event: unknown
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
    ...(row.base_materialization_id === null
      ? {}
      : {
          base: {
            materializationId: row.base_materialization_id,
            lastCommitId: row.base_commit_id!,
          },
        }),
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
    root: sourceEntityFromKey(row.root_key),
    assertion: sourceAssertionFromColumns(row, row.payload),
    stagingOrdinal: databaseSafeInteger(row.staging_ordinal, "Source staging ordinal"),
  }
}

export function commitRecord(row: PgOntologyCommitRow): OntologyCommitRecord {
  const base = {
    projectId: row.project_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    executionId: row.execution_id,
    origin: structuredClone(row.origin) as OntologyCommitWrite["origin"],
    ontologyRevision: row.ontology_revision,
    ...(row.projection_revision === null ? {} : { projectionRevision: row.projection_revision }),
    ...(row.ownership_hash === null ? {} : { ownershipHash: row.ownership_hash }),
    committedAt: toIsoString(row.committed_at),
  }
  const intent = structuredClone(row.intent) as OntologyCommitWrite["intent"]
  const result = structuredClone(row.result) as OntologyCommitRecord["result"]
  return { ...base, intent, result } as OntologyCommitRecord
}

/** A claimed row as stored: its draft, to rebuild from its commit. */
export function claimedOutboxDraft(row: PgOntologyOutboxRow): ClaimedOutboxDraft {
  if (row.lease_id === null || row.lease_expires_at === null) {
    throw new MaterializationConflictError(
      "outbox-lease",
      "Ontology outbox claim returned an unpaired lease."
    )
  }
  return {
    id: row.id,
    commitId: row.commit_id,
    commitOrdinal: databaseSafeInteger(row.commit_ordinal, "Ontology outbox commit ordinal"),
    event: structuredClone(row.event) as ClaimedOutboxDraft["event"],
    availableAt: toIsoString(row.available_at),
    attempts: databaseSafeInteger(row.attempts, "Ontology outbox attempts"),
    leaseId: row.lease_id,
    leaseExpiresAt: toIsoString(row.lease_expires_at),
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

export function jsonTupleExpression(parts: readonly string[]): string {
  return `concat('[', ${parts.join(", ',', ")}, ']')`
}

/** The canonical JSON key of a row's identity columns, as `objectRefKey`/`linkRefKey` render it. */
export function columnKeyExpression(columns: readonly string[]): string {
  return jsonTupleExpression(columns.map((column) => `to_jsonb(${column})::text`))
}
