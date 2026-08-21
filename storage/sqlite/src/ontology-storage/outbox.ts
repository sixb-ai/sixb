import type { Database } from "bun:sqlite"
import { serializeSixbFailure } from "@sixb/core/internal/errors"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "@sixb/core/internal/materialization"
import type {
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CompleteOntologyOutboxLeaseInput,
  OntologyOutboxStorage,
  OntologyOutboxSummary,
  PurgePublishedOntologyOutboxInput,
  RescheduleOntologyOutboxLeaseInput,
  SummarizeOntologyOutboxInput,
} from "@sixb/core/storage"
import { ONTOLOGY_OUTBOX_FAILURE_CODES } from "@sixb/core/storage"
import {
  assertNonblank,
  assertPositiveInteger,
  assertTimestamp,
  outboxRecord,
  type SqliteOntologyOutboxRow,
  type SqliteRootOperation,
} from "./shared"

export class SqliteOntologyOutboxStorage implements OntologyOutboxStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async claim(input: ClaimOntologyOutboxInput): Promise<readonly ClaimedOntologyOutboxRow[]> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology outbox project id")
      assertPositiveInteger(input.limit, "Ontology outbox limit")
      const now = assertTimestamp(input.now, "Ontology outbox claim time")
      const leaseExpiry = assertTimestamp(input.leaseExpiresAt, "Ontology outbox lease expiry")
      assertNonblank(input.leaseId, "Ontology outbox lease id")
      if (leaseExpiry <= now) {
        throw new MaterializationValidationError(
          "Ontology outbox lease expiry must be later than the claim time."
        )
      }

      const rows = this.db
        .query(
          `
            UPDATE ontology_outbox
            SET attempts = attempts + 1, lease_id = ?, lease_expires_at = ?
            WHERE rowid IN (
              SELECT rowid
              FROM ontology_outbox
              WHERE project_id = ? AND published_at IS NULL AND available_at <= ?
                AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
              ORDER BY created_at, commit_id, commit_ordinal
              LIMIT ?
            )
            RETURNING envelope, available_at, attempts, lease_id, lease_expires_at,
              published_at, last_failure, created_at
          `
        )
        .all(
          input.leaseId,
          input.leaseExpiresAt,
          input.projectId,
          input.now,
          input.now,
          input.limit
        ) as SqliteOntologyOutboxRow[]
      return rows
        .map((row) => outboxRecord(row))
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.envelope.id.localeCompare(right.envelope.id)
        )
        .map((record) => {
          if (record.leaseId === null || record.leaseExpiresAt === null) {
            throw new MaterializationConflictError(
              "outbox-lease",
              "Ontology outbox claim returned an unpaired lease."
            )
          }
          return { ...record, leaseId: record.leaseId, leaseExpiresAt: record.leaseExpiresAt }
        })
    })
  }

  async markPublished(input: CompleteOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(() => {
      assertLeaseInput(input)
      assertTimestamp(input.publishedAt, "Ontology outbox publishedAt")
      const ids = validateLeaseIds(input.ids)
      const changed = this.db
        .query(
          `
            WITH requested(id) AS MATERIALIZED (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            ), leased(id) AS MATERIALIZED (
              SELECT outbox.id FROM ontology_outbox AS outbox
              JOIN requested USING (id)
              WHERE outbox.project_id = ? AND outbox.lease_id = ?
                AND outbox.lease_expires_at IS NOT NULL
            ), eligible(id) AS (
              SELECT id FROM leased WHERE (SELECT COUNT(*) FROM leased) = ?
            )
            UPDATE ontology_outbox
            SET published_at = ?, lease_id = NULL, lease_expires_at = NULL
            WHERE project_id = ? AND id IN (SELECT id FROM eligible)
              AND lease_id = ? AND lease_expires_at IS NOT NULL
          `
        )
        .run(
          JSON.stringify(ids),
          input.projectId,
          input.leaseId,
          ids.length,
          input.publishedAt,
          input.projectId,
          input.leaseId
        ).changes
      if (changed !== ids.length) throw leaseConflict()
    })
  }

  async reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(() => {
      assertLeaseInput(input)
      assertTimestamp(input.availableAt, "Ontology outbox availableAt")
      const ids = validateLeaseIds(input.ids)
      const failure =
        input.failure === undefined
          ? null
          : serializeSixbFailure(input.failure, ONTOLOGY_OUTBOX_FAILURE_CODES)
      const changed = this.db
        .query(
          `
            WITH requested(id) AS MATERIALIZED (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            ), leased(id) AS MATERIALIZED (
              SELECT outbox.id FROM ontology_outbox AS outbox
              JOIN requested USING (id)
              WHERE outbox.project_id = ? AND outbox.lease_id = ?
                AND outbox.lease_expires_at IS NOT NULL
            ), eligible(id) AS (
              SELECT id FROM leased WHERE (SELECT COUNT(*) FROM leased) = ?
            )
            UPDATE ontology_outbox
            SET available_at = ?, last_failure = COALESCE(?, last_failure),
              lease_id = NULL, lease_expires_at = NULL
            WHERE project_id = ? AND id IN (SELECT id FROM eligible)
              AND lease_id = ? AND lease_expires_at IS NOT NULL
          `
        )
        .run(
          JSON.stringify(ids),
          input.projectId,
          input.leaseId,
          ids.length,
          input.availableAt,
          failure,
          input.projectId,
          input.leaseId
        ).changes
      if (changed !== ids.length) throw leaseConflict()
    })
  }

  async purgePublished(input: PurgePublishedOntologyOutboxInput): Promise<number> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology outbox project id")
      assertPositiveInteger(input.limit, "Ontology outbox limit")
      assertTimestamp(input.publishedBefore, "Ontology outbox purge cutoff")
      return this.db
        .query(
          `
            DELETE FROM ontology_outbox
            WHERE rowid IN (
              SELECT rowid FROM ontology_outbox
              WHERE project_id = ? AND published_at IS NOT NULL AND published_at < ?
              ORDER BY published_at, id
              LIMIT ?
            )
          `
        )
        .run(input.projectId, input.publishedBefore, input.limit).changes
    })
  }

  async summarize(input: SummarizeOntologyOutboxInput): Promise<OntologyOutboxSummary> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology outbox project id")
      const summary = this.db
        .query(
          `
            SELECT COUNT(*) AS pending_count,
              MIN(created_at) AS oldest_pending_at,
              SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS retrying_count,
              COALESCE(MAX(attempts), 0) AS max_attempts
            FROM ontology_outbox
            WHERE project_id = ? AND published_at IS NULL
          `
        )
        .get(input.projectId) as {
        readonly pending_count: number
        readonly oldest_pending_at: string | null
        readonly retrying_count: number | null
        readonly max_attempts: number
      }
      return {
        pendingCount: summary.pending_count,
        oldestPendingAt: summary.oldest_pending_at,
        retryingCount: summary.retrying_count ?? 0,
        maxAttempts: summary.max_attempts,
      }
    })
  }
}

function validateLeaseIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const id of ids) {
    assertNonblank(id, "Ontology outbox event id")
    if (seen.has(id)) {
      throw new MaterializationValidationError(`Ontology outbox lease batch repeats event '${id}'.`)
    }
    seen.add(id)
  }
  return [...seen]
}

function assertLeaseInput(input: {
  readonly projectId: string
  readonly ids: readonly string[]
  readonly leaseId: string
}): void {
  assertNonblank(input.projectId, "Ontology outbox project id")
  assertNonblank(input.leaseId, "Ontology outbox lease id")
}

function leaseConflict(): MaterializationConflictError {
  return new MaterializationConflictError("outbox-lease", "Ontology outbox lease does not match.")
}
