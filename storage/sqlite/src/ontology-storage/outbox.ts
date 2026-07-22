import type { Database } from "bun:sqlite"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "@sixb/core/internal/materializer"
import type {
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CompleteOntologyOutboxLeaseInput,
  OntologyOutboxStorage,
  PurgePublishedOntologyOutboxInput,
  RescheduleOntologyOutboxLeaseInput,
} from "@sixb/core/storage"
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

      const ids = this.db
        .query(
          `
            SELECT id
            FROM ontology_outbox
            WHERE project_id = ? AND published_at IS NULL AND available_at <= ?
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            ORDER BY created_at, id
            LIMIT ?
          `
        )
        .all(input.projectId, input.now, input.now, input.limit) as { readonly id: string }[]
      const update = this.db.query(
        `
          UPDATE ontology_outbox
          SET attempts = attempts + 1, lease_id = ?, lease_expires_at = ?
          WHERE project_id = ? AND id = ? AND published_at IS NULL AND available_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `
      )
      for (const row of ids) {
        const changed = update.run(
          input.leaseId,
          input.leaseExpiresAt,
          input.projectId,
          row.id,
          input.now,
          input.now
        ).changes
        if (changed !== 1) {
          throw new MaterializationConflictError(
            "outbox-lease",
            "Ontology outbox claim changed while acquiring its lease."
          )
        }
      }
      if (ids.length === 0) return []
      const rows = ids.map(({ id }) =>
        this.db
          .query(
            `
              SELECT envelope, available_at, attempts, lease_id, lease_expires_at,
                published_at, last_error, created_at
              FROM ontology_outbox
              WHERE project_id = ? AND id = ?
            `
          )
          .get(input.projectId, id)
      ) as SqliteOntologyOutboxRow[]
      return rows.map((row) => {
        const record = outboxRecord(row)
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
      this.assertLeaseBatch(input.projectId, input.ids, input.leaseId)
      const update = this.db.query(
        `
          UPDATE ontology_outbox
          SET published_at = ?, lease_id = NULL, lease_expires_at = NULL
          WHERE project_id = ? AND id = ? AND lease_id = ? AND lease_expires_at IS NOT NULL
        `
      )
      for (const id of input.ids) {
        if (update.run(input.publishedAt, input.projectId, id, input.leaseId).changes !== 1) {
          throw leaseConflict()
        }
      }
    })
  }

  async reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(() => {
      assertLeaseInput(input)
      assertTimestamp(input.availableAt, "Ontology outbox availableAt")
      this.assertLeaseBatch(input.projectId, input.ids, input.leaseId)
      const update = this.db.query(
        `
          UPDATE ontology_outbox
          SET available_at = ?, last_error = ?, lease_id = NULL, lease_expires_at = NULL
          WHERE project_id = ? AND id = ? AND lease_id = ? AND lease_expires_at IS NOT NULL
        `
      )
      for (const id of input.ids) {
        if (
          update.run(input.availableAt, input.error, input.projectId, id, input.leaseId).changes !==
          1
        ) {
          throw leaseConflict()
        }
      }
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

  private assertLeaseBatch(projectId: string, ids: readonly string[], leaseId: string): void {
    const seen = new Set<string>()
    const lookup = this.db.query(
      `
        SELECT lease_id, lease_expires_at
        FROM ontology_outbox
        WHERE project_id = ? AND id = ?
      `
    )
    for (const id of ids) {
      assertNonblank(id, "Ontology outbox event id")
      if (seen.has(id)) {
        throw new MaterializationValidationError(
          `Ontology outbox lease batch repeats event '${id}'.`
        )
      }
      seen.add(id)
      const row = lookup.get(projectId, id) as {
        readonly lease_id: string | null
        readonly lease_expires_at: string | null
      } | null
      if (!row || row.lease_id !== leaseId || row.lease_expires_at === null) {
        throw leaseConflict()
      }
    }
  }
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
