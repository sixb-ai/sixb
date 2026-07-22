import type {
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  GetOntologyCommitByOriginInput,
  ListOntologyCommitsInput,
  ListOntologyCommitsResult,
  OntologyCommitRecord,
  OntologyCommitStorage,
} from "@sixb/core/storage"
import {
  assertNonblank,
  assertNonnegativeInteger,
  commitRecord,
  originWhere,
  type PgOntologyCommitRow,
  type PgRootOperation,
} from "./shared"

export class PgOntologyCommitStorage implements OntologyCommitStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  async getByIdempotencyKey(
    input: GetOntologyCommitByIdempotencyKeyInput
  ): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Ontology commit project id")
      assertNonblank(input.idempotencyKey, "Ontology commit idempotency key")
      const [row] = await sql<PgOntologyCommitRow[]>`
        SELECT * FROM ontology_commits
        WHERE project_id = ${input.projectId} AND idempotency_key = ${input.idempotencyKey}
      `
      return row ? commitRecord(row) : null
    })
  }

  async getById(input: GetOntologyCommitByIdInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Ontology commit project id")
      assertNonblank(input.id, "Ontology commit id")
      const [row] = await sql<PgOntologyCommitRow[]>`
        SELECT * FROM ontology_commits
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `
      return row ? commitRecord(row) : null
    })
  }

  async getByOrigin(input: GetOntologyCommitByOriginInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Ontology commit project id")
      const origin = originWhere(input.origin)
      assertNonblank(origin.runId, "Ontology commit origin run id")
      if (origin.batchOrdinal !== null) {
        assertNonnegativeInteger(origin.batchOrdinal, "Ontology telemetry commit batch ordinal")
      }
      const [row] =
        origin.batchOrdinal === null
          ? await sql<PgOntologyCommitRow[]>`
              SELECT * FROM ontology_commits
              WHERE project_id = ${input.projectId}
                AND origin_kind = ${origin.kind}
                AND origin_run_id = ${origin.runId}
                AND origin_batch_ordinal IS NULL
            `
          : await sql<PgOntologyCommitRow[]>`
              SELECT * FROM ontology_commits
              WHERE project_id = ${input.projectId}
                AND origin_kind = ${origin.kind}
                AND origin_run_id = ${origin.runId}
                AND origin_batch_ordinal = ${origin.batchOrdinal}
            `
      return row ? commitRecord(row) : null
    })
  }

  async list(input: ListOntologyCommitsInput): Promise<ListOntologyCommitsResult> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Ontology commit project id")
      if (input.run) assertNonblank(input.run.id, "Ontology commit run id")
      const offset = input.offset ?? 0
      const limit = input.limit
      assertNonnegativeInteger(offset, "Ontology commit list offset")
      if (limit !== undefined) assertNonnegativeInteger(limit, "Ontology commit list limit")

      const runFilter =
        input.run?.kind === "action"
          ? sql`AND origin_kind = 'action' AND origin_run_id = ${input.run.id}`
          : input.run?.kind === "projection"
            ? sql`AND origin_run_id = ${input.run.id}
                  AND origin_kind IN ('projection', 'telemetry')`
            : sql``
      const [{ total }] = await sql<{ readonly total: number | string }[]>`
        SELECT COUNT(*) AS total
        FROM ontology_commits
        WHERE project_id = ${input.projectId} ${runFilter}
      `
      const direction = input.order === "desc" ? sql`DESC` : sql`ASC`
      const order =
        input.run?.kind === "projection"
          ? sql`CASE WHEN origin_kind = 'telemetry' THEN origin_batch_ordinal ELSE -1 END
                ${direction}, committed_at ${direction}, id ${direction}`
          : sql`committed_at ${direction}, id ${direction}`
      const limitFragment = limit === undefined ? sql`` : sql`LIMIT ${limit}`
      const rows = await sql<PgOntologyCommitRow[]>`
        SELECT * FROM ontology_commits
        WHERE project_id = ${input.projectId} ${runFilter}
        ORDER BY ${order}
        ${limitFragment} OFFSET ${offset}
      `
      const count = Number(total)
      const commits = rows.map(commitRecord)
      return { commits, total: count, hasMore: offset + commits.length < count }
    })
  }
}
