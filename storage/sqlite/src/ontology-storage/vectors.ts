import type { Database } from "bun:sqlite"
import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import type {
  MaterializationSession,
  ObjectVectorState,
  OntologyVectorStorage,
} from "@sixb/core/storage"
import { encodeSqliteVector } from "../vector-encoding"
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

  async write(input: Parameters<OntologyVectorStorage["write"]>[0]): Promise<void> {
    const { value } = input
    this.assertSession(input.session, input.projectId, value.lastCommitId)
    // The Materializer validates and normalizes float32 values before this boundary.
    const embedding = encodeSqliteVector(value.values)
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
