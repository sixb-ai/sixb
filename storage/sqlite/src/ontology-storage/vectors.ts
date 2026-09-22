import type { Database } from "bun:sqlite"
import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import type {
  MaterializationSession,
  ObjectVectorState,
  OntologyVectorStorage,
} from "@sixb/core/storage"
import type { SqliteRootOperation } from "./shared"

interface VectorMetadataRow {
  readonly profile: string
  readonly configuration: string
  readonly source: string
  readonly source_fingerprint: string
  readonly last_commit_id: string
}

export class SqliteOntologyVectorStorage implements OntologyVectorStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation,
    private readonly assertSession: (
      session: MaterializationSession,
      projectId: string,
      commitId?: string
    ) => void
  ) {}

  async list(
    input: Parameters<OntologyVectorStorage["list"]>[0]
  ): Promise<readonly ObjectVectorState[]> {
    return this.runRootOperation(() => {
      const rows = this.db
        .query<VectorMetadataRow, [string, string, string]>(`
        SELECT profile, configuration, source, source_fingerprint, last_commit_id
        FROM object_vectors
        WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
        ORDER BY profile
      `)
        .all(input.projectId, input.ref.objectTypeId, input.ref.primaryId)
      return rows.map((row) => ({
        ref: { ...input.ref },
        profile: row.profile,
        configuration: row.configuration,
        source: JSON.parse(row.source) as string[],
        sourceFingerprint: row.source_fingerprint,
        lastCommitId: row.last_commit_id,
      }))
    })
  }

  async listBatch(
    input: Parameters<OntologyVectorStorage["listBatch"]>[0]
  ): Promise<readonly ObjectVectorState[]> {
    if (!input.refs.length) return []
    return this.runRootOperation(() => {
      // Keep the bounded request set first so SQLite probes the composite object index.
      const rows = this.db
        .query<
          VectorMetadataRow & { object_type_id: string; primary_id: string },
          [string, string]
        >(`
        WITH requested AS (
          SELECT DISTINCT json_extract(value, '$.objectTypeId') AS object_type_id,
            json_extract(value, '$.primaryId') AS primary_id FROM json_each(?)
        )
        SELECT stored.object_type_id, stored.primary_id, stored.profile, stored.configuration,
          stored.source, stored.source_fingerprint, stored.last_commit_id
        FROM requested CROSS JOIN object_vectors AS stored
        WHERE stored.project_id = ? AND stored.object_type_id = requested.object_type_id
          AND stored.primary_id = requested.primary_id
        ORDER BY stored.object_type_id, stored.primary_id, stored.profile
      `)
        .all(JSON.stringify(input.refs), input.projectId)
      return rows.map((row) => ({
        ref: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
        profile: row.profile,
        configuration: row.configuration,
        source: JSON.parse(row.source) as string[],
        sourceFingerprint: row.source_fingerprint,
        lastCommitId: row.last_commit_id,
      }))
    })
  }

  async removeBatch(input: Parameters<OntologyVectorStorage["removeBatch"]>[0]): Promise<void> {
    this.assertSession(input.session, input.projectId)
    if (!input.entries.length) return
    const { changes } = this.db
      .query(`
      DELETE FROM object_vectors WHERE rowid IN (
        SELECT stored.rowid FROM json_each(?) AS requested CROSS JOIN object_vectors AS stored
        WHERE stored.project_id = ? AND stored.object_type_id = json_extract(requested.value, '$.ref.objectTypeId')
          AND stored.primary_id = json_extract(requested.value, '$.ref.primaryId')
          AND stored.profile = json_extract(requested.value, '$.profile')
          AND stored.last_commit_id = json_extract(requested.value, '$.expectedCommitId')
      )
    `)
      .run(JSON.stringify(input.entries), input.projectId)
    if (changes !== input.entries.length) throw vectorConflict()
  }

  async write(input: Parameters<OntologyVectorStorage["write"]>[0]): Promise<void> {
    const { value } = input
    this.assertSession(input.session, input.projectId, value.lastCommitId)
    // The Materializer validates float32 values. Store a portable little-endian representation.
    const embedding = new Uint8Array(value.values.length * 4)
    const view = new DataView(embedding.buffer)
    for (let i = 0; i < value.values.length; i++) view.setFloat32(i * 4, value.values[i]!, true)
    const changes =
      input.expectedCommitId === null
        ? this.db
            .query(`
          INSERT INTO object_vectors (
            project_id, object_type_id, primary_id, profile,
            configuration, source, source_fingerprint, embedding, last_commit_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, object_type_id, primary_id, profile) DO NOTHING
        `)
            .run(
              input.projectId,
              value.ref.objectTypeId,
              value.ref.primaryId,
              value.profile,
              value.configuration,
              JSON.stringify(value.source),
              value.sourceFingerprint,
              embedding,
              value.lastCommitId
            ).changes
        : this.db
            .query(`
          UPDATE object_vectors
          SET configuration = ?, source = ?, source_fingerprint = ?, embedding = ?, last_commit_id = ?
          WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
            AND profile = ? AND last_commit_id = ?
        `)
            .run(
              value.configuration,
              JSON.stringify(value.source),
              value.sourceFingerprint,
              embedding,
              value.lastCommitId,
              input.projectId,
              value.ref.objectTypeId,
              value.ref.primaryId,
              value.profile,
              input.expectedCommitId
            ).changes
    if (changes !== 1) throw vectorConflict()
  }

  async remove(input: Parameters<OntologyVectorStorage["remove"]>[0]): Promise<void> {
    this.assertSession(input.session, input.projectId)
    const { changes } = this.db
      .query(`
      DELETE FROM object_vectors
      WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
        AND profile = ? AND last_commit_id = ?
    `)
      .run(
        input.projectId,
        input.ref.objectTypeId,
        input.ref.primaryId,
        input.profile,
        input.expectedCommitId
      )
    if (changes !== 1) throw vectorConflict()
  }
}

function vectorConflict(): MaterializationConflictError {
  return new MaterializationConflictError(
    "effective-state",
    "Vector changed since it was prepared."
  )
}
