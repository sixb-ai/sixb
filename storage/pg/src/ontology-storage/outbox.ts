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
  type PgOntologyOutboxRow,
  type PgRootOperation,
} from "./shared"

export class PgOntologyOutboxStorage implements OntologyOutboxStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  async claim(input: ClaimOntologyOutboxInput): Promise<readonly ClaimedOntologyOutboxRow[]> {
    return this.runRootOperation(async (sql) => {
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

      const rows = await sql<PgOntologyOutboxRow[]>`
        WITH candidates AS (
          SELECT project_id, id
          FROM ontology_outbox
          WHERE project_id = ${input.projectId}
            AND published_at IS NULL
            AND available_at <= ${input.now}
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
          ORDER BY created_at, id
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE ontology_outbox AS outbox
          SET attempts = outbox.attempts + 1,
            lease_id = ${input.leaseId},
            lease_expires_at = ${input.leaseExpiresAt}
          FROM candidates
          WHERE outbox.project_id = candidates.project_id AND outbox.id = candidates.id
          RETURNING outbox.id AS row_id, outbox.envelope, outbox.available_at,
            outbox.attempts, outbox.lease_id, outbox.lease_expires_at,
            outbox.published_at, outbox.last_error, outbox.created_at
        )
        SELECT * FROM claimed ORDER BY created_at, row_id
      `
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
    await this.runRootOperation(async (sql) => {
      assertLeaseInput(input)
      assertTimestamp(input.publishedAt, "Ontology outbox publishedAt")
      await assertLeaseBatch(sql, input.projectId, input.ids, input.leaseId)
      for (const id of input.ids) {
        const rows = await sql<{ readonly id: string }[]>`
          UPDATE ontology_outbox
          SET published_at = ${input.publishedAt}, lease_id = NULL, lease_expires_at = NULL
          WHERE project_id = ${input.projectId} AND id = ${id}
            AND lease_id = ${input.leaseId} AND lease_expires_at IS NOT NULL
          RETURNING id
        `
        if (rows.length !== 1) throw leaseConflict()
      }
    })
  }

  async reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(async (sql) => {
      assertLeaseInput(input)
      assertTimestamp(input.availableAt, "Ontology outbox availableAt")
      await assertLeaseBatch(sql, input.projectId, input.ids, input.leaseId)
      for (const id of input.ids) {
        const rows = await sql<{ readonly id: string }[]>`
          UPDATE ontology_outbox
          SET available_at = ${input.availableAt}, last_error = ${input.error},
            lease_id = NULL, lease_expires_at = NULL
          WHERE project_id = ${input.projectId} AND id = ${id}
            AND lease_id = ${input.leaseId} AND lease_expires_at IS NOT NULL
          RETURNING id
        `
        if (rows.length !== 1) throw leaseConflict()
      }
    })
  }

  async purgePublished(input: PurgePublishedOntologyOutboxInput): Promise<number> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Ontology outbox project id")
      assertPositiveInteger(input.limit, "Ontology outbox limit")
      assertTimestamp(input.publishedBefore, "Ontology outbox purge cutoff")
      const rows = await sql<{ readonly id: string }[]>`
        WITH selected AS (
          SELECT project_id, id
          FROM ontology_outbox
          WHERE project_id = ${input.projectId}
            AND published_at IS NOT NULL
            AND published_at < ${input.publishedBefore}
          ORDER BY published_at, id
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ontology_outbox AS outbox
        USING selected
        WHERE outbox.project_id = selected.project_id AND outbox.id = selected.id
        RETURNING outbox.id
      `
      return rows.length
    })
  }
}

async function assertLeaseBatch(
  sql: import("../pg-client").SQLClient,
  projectId: string,
  ids: readonly string[],
  leaseId: string
): Promise<void> {
  const seen = new Set<string>()
  for (const id of ids) {
    assertNonblank(id, "Ontology outbox event id")
    if (seen.has(id)) {
      throw new MaterializationValidationError(`Ontology outbox lease batch repeats event '${id}'.`)
    }
    seen.add(id)
  }
  for (const id of [...seen].sort()) {
    const [row] = await sql<
      { readonly lease_id: string | null; readonly lease_expires_at: Date | string | null }[]
    >`
      SELECT lease_id, lease_expires_at
      FROM ontology_outbox
      WHERE project_id = ${projectId} AND id = ${id}
      FOR UPDATE
    `
    if (!row || row.lease_id !== leaseId || row.lease_expires_at === null) {
      throw leaseConflict()
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
