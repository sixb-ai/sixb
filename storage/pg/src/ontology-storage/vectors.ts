import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import type {
  MaterializationSession,
  ObjectVectorState,
  OntologyVectorStorage,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { jsonParameter as json, type PgRootOperation } from "./shared"

interface VectorMetadataRow {
  readonly profile: string
  readonly configuration: string
  readonly source: string[]
  readonly source_fingerprint: string
  readonly last_commit_id: string
}

export class PgOntologyVectorStorage implements OntologyVectorStorage {
  constructor(
    private readonly sql: SQLClient,
    private readonly runRootOperation: PgRootOperation,
    private readonly assertSession: (
      session: MaterializationSession,
      projectId: string,
      commitId?: string
    ) => void
  ) {}

  async list(
    input: Parameters<OntologyVectorStorage["list"]>[0]
  ): Promise<readonly ObjectVectorState[]> {
    return this.runRootOperation(async (sql) => {
      const rows = await sql<VectorMetadataRow[]>`
        SELECT profile, configuration, source, source_fingerprint, last_commit_id
        FROM object_vectors
        WHERE project_id = ${input.projectId}
          AND object_type_id = ${input.ref.objectTypeId} AND primary_id = ${input.ref.primaryId}
        ORDER BY profile
      `
      return rows.map((row) => ({
        ref: { ...input.ref },
        profile: row.profile,
        configuration: row.configuration,
        source: row.source,
        sourceFingerprint: row.source_fingerprint,
        lastCommitId: row.last_commit_id,
      }))
    })
  }

  async listBatch(
    input: Parameters<OntologyVectorStorage["listBatch"]>[0]
  ): Promise<readonly ObjectVectorState[]> {
    if (!input.refs.length) return []
    return this.runRootOperation(async (sql) => {
      const rows = await sql<
        (VectorMetadataRow & { object_type_id: string; primary_id: string })[]
      >`
        SELECT stored.object_type_id, stored.primary_id, stored.profile, stored.configuration,
          stored.source, stored.source_fingerprint, stored.last_commit_id
        FROM (SELECT DISTINCT ref->>'objectTypeId' AS object_type_id, ref->>'primaryId' AS primary_id
          FROM jsonb_array_elements(${json(sql, input.refs)}::jsonb) AS requested(ref)) AS requested
        JOIN object_vectors AS stored ON stored.project_id = ${input.projectId}
          AND stored.object_type_id = requested.object_type_id AND stored.primary_id = requested.primary_id
        ORDER BY stored.object_type_id, stored.primary_id, stored.profile
      `
      return rows.map((row) => ({
        ref: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
        profile: row.profile,
        configuration: row.configuration,
        source: row.source,
        sourceFingerprint: row.source_fingerprint,
        lastCommitId: row.last_commit_id,
      }))
    })
  }

  async removeBatch(input: Parameters<OntologyVectorStorage["removeBatch"]>[0]): Promise<void> {
    this.assertSession(input.session, input.projectId)
    if (!input.entries.length) return
    const removed = await this.sql`
      DELETE FROM object_vectors AS stored
      USING jsonb_array_elements(${json(this.sql, input.entries)}::jsonb) AS requested(entry)
      WHERE stored.project_id = ${input.projectId}
        AND stored.object_type_id = entry#>>'{ref,objectTypeId}'
        AND stored.primary_id = entry#>>'{ref,primaryId}' AND stored.profile = entry->>'profile'
        AND stored.last_commit_id = entry->>'expectedCommitId'
      RETURNING stored.profile
    `
    if (removed.length !== input.entries.length) throw vectorConflict()
  }

  async write(input: Parameters<OntologyVectorStorage["write"]>[0]): Promise<void> {
    const { value } = input
    this.assertSession(input.session, input.projectId, value.lastCommitId)
    // The Materializer validates float32 values before this provider boundary.
    const embedding = this.sql.array([...value.values])
    const rows =
      input.expectedCommitId === null
        ? await this.sql`
          INSERT INTO object_vectors (
            project_id, object_type_id, primary_id, profile,
            configuration, source, source_fingerprint, embedding, last_commit_id
          ) VALUES (
            ${input.projectId}, ${value.ref.objectTypeId}, ${value.ref.primaryId}, ${value.profile},
            ${value.configuration}, ${this.sql.array([...value.source])}::text[],
            ${value.sourceFingerprint}, ${embedding}::real[], ${value.lastCommitId}
          )
          ON CONFLICT (project_id, object_type_id, primary_id, profile) DO NOTHING
          RETURNING profile
        `
        : await this.sql`
          UPDATE object_vectors
          SET configuration = ${value.configuration}, source = ${this.sql.array([...value.source])}::text[],
            source_fingerprint = ${value.sourceFingerprint}, embedding = ${embedding}::real[],
            last_commit_id = ${value.lastCommitId}
          WHERE project_id = ${input.projectId}
            AND object_type_id = ${value.ref.objectTypeId} AND primary_id = ${value.ref.primaryId}
            AND profile = ${value.profile} AND last_commit_id = ${input.expectedCommitId}
          RETURNING profile
        `
    if (rows.length !== 1) throw vectorConflict()
  }

  async remove(input: Parameters<OntologyVectorStorage["remove"]>[0]): Promise<void> {
    this.assertSession(input.session, input.projectId)
    const rows = await this.sql`
      DELETE FROM object_vectors
      WHERE project_id = ${input.projectId}
        AND object_type_id = ${input.ref.objectTypeId} AND primary_id = ${input.ref.primaryId}
        AND profile = ${input.profile} AND last_commit_id = ${input.expectedCommitId}
      RETURNING profile
    `
    if (rows.length !== 1) throw vectorConflict()
  }
}

function vectorConflict(): MaterializationConflictError {
  return new MaterializationConflictError(
    "effective-state",
    "Vector changed since it was prepared."
  )
}
