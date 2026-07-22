import type { Database } from "bun:sqlite"
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
  type SqliteOntologyCommitRow,
  type SqliteRootOperation,
} from "./shared"

export class SqliteOntologyCommitStorage implements OntologyCommitStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async getByIdempotencyKey(
    input: GetOntologyCommitByIdempotencyKeyInput
  ): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology commit project id")
      assertNonblank(input.idempotencyKey, "Ontology commit idempotency key")
      return this.readOne(
        "project_id = ? AND idempotency_key = ?",
        input.projectId,
        input.idempotencyKey
      )
    })
  }

  async getById(input: GetOntologyCommitByIdInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology commit project id")
      assertNonblank(input.id, "Ontology commit id")
      return this.readOne("project_id = ? AND id = ?", input.projectId, input.id)
    })
  }

  async getByOrigin(input: GetOntologyCommitByOriginInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology commit project id")
      const origin = originWhere(input.origin)
      assertNonblank(origin.runId, "Ontology commit origin run id")
      if (origin.batchOrdinal !== null) {
        assertNonnegativeInteger(origin.batchOrdinal, "Ontology telemetry commit batch ordinal")
      }
      return origin.batchOrdinal === null
        ? this.readOne(
            "project_id = ? AND origin_kind = ? AND origin_run_id = ? AND origin_batch_ordinal IS NULL",
            input.projectId,
            origin.kind,
            origin.runId
          )
        : this.readOne(
            "project_id = ? AND origin_kind = ? AND origin_run_id = ? AND origin_batch_ordinal = ?",
            input.projectId,
            origin.kind,
            origin.runId,
            origin.batchOrdinal
          )
    })
  }

  async list(input: ListOntologyCommitsInput): Promise<ListOntologyCommitsResult> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology commit project id")
      if (input.run) assertNonblank(input.run.id, "Ontology commit run id")
      const offset = input.offset ?? 0
      const limit = input.limit ?? -1
      assertNonnegativeInteger(offset, "Ontology commit list offset")
      if (limit !== -1) assertNonnegativeInteger(limit, "Ontology commit list limit")
      const filters = ["project_id = ?"]
      const values: (string | number)[] = [input.projectId]
      if (input.run?.kind === "action") {
        filters.push("origin_kind = 'action' AND origin_run_id = ?")
        values.push(input.run.id)
      } else if (input.run?.kind === "projection") {
        filters.push("origin_run_id = ? AND origin_kind IN ('projection', 'telemetry')")
        values.push(input.run.id)
      }
      const where = filters.join(" AND ")
      const totalRow = this.db
        .query(`SELECT COUNT(*) AS total FROM ontology_commits WHERE ${where}`)
        .get(...values) as { readonly total: number }
      const direction = input.order === "desc" ? "DESC" : "ASC"
      const order =
        input.run?.kind === "projection"
          ? `CASE WHEN origin_kind = 'telemetry' THEN origin_batch_ordinal ELSE -1 END ${direction}, committed_at ${direction}, id ${direction}`
          : `committed_at ${direction}, id ${direction}`
      const rows = this.db
        .query(
          `
            SELECT * FROM ontology_commits
            WHERE ${where}
            ORDER BY ${order}
            LIMIT ? OFFSET ?
          `
        )
        .all(...values, limit, offset) as SqliteOntologyCommitRow[]
      const commits = rows.map(commitRecord)
      return {
        commits,
        total: totalRow.total,
        hasMore: offset + commits.length < totalRow.total,
      }
    })
  }

  private readOne(
    where: string,
    ...values: readonly (string | number)[]
  ): OntologyCommitRecord | null {
    const row = this.db
      .query(`SELECT * FROM ontology_commits WHERE ${where}`)
      .get(...values) as SqliteOntologyCommitRow | null
    return row ? commitRecord(row) : null
  }
}
