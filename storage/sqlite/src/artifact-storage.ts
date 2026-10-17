import type { Database, SQLQueryBindings } from "bun:sqlite"
import {
  artifactStorageErrors,
  parseArtifactRow,
  parseArtifactVersionRow,
} from "@sixb/core/internal/storage"
import type {
  ArtifactFrameGrantRecord,
  ArtifactFrameTarget,
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  CreateArtifactInput,
  DeleteArtifactInput,
  DeleteArtifactVersionsByOriginInput,
  DeleteExpiredArtifactFrameGrantsInput,
  FindArtifactFrameGrantInput,
  GetArtifactInput,
  GetArtifactVersionInput,
  ListArtifactsInput,
  ListArtifactsResult,
  ListArtifactVersionsInput,
  ListArtifactVersionsResult,
  ListReferencingVersionsInput,
  PublishArtifactVersionInput,
  PublishedArtifactVersion,
} from "@sixb/core/storage"
import { runImmediateTransaction, type SqliteStoreConnection } from "./transactions"

const ARTIFACT_COLUMNS = `
  project_id AS projectId, id, kind, title,
  owner_principal_type AS ownerPrincipalType, owner_principal_id AS ownerPrincipalId,
  latest_version AS latestVersion, created_at AS createdAt, updated_at AS updatedAt
`

const VERSION_COLUMNS = `
  project_id AS projectId, artifact_id AS artifactId, version, title, entry, files, outline, refs,
  author_principal_type AS authorPrincipalType, author_principal_id AS authorPrincipalId,
  origin_thread_id AS originThreadId, origin_run_id AS originRunId, created_at AS createdAt
`

export class SqliteArtifactStorage implements ArtifactStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    return runImmediateTransaction(this.db, () => {
      if (this.artifactRow(input.projectId, input.id)) {
        throw artifactStorageErrors.exists(input.id)
      }
      const createdAt = input.version.createdAt.toISOString()
      this.db
        .query(
          `INSERT INTO artifacts (
            project_id, id, kind, title, owner_principal_type, owner_principal_id,
            latest_version, next_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?, ?)`
        )
        .run(
          input.projectId,
          input.id,
          input.kind,
          input.version.title,
          input.owner.type,
          input.owner.id,
          createdAt,
          createdAt
        )
      this.insertVersion(input.projectId, input.id, 1, input.version)
      return this.published(input.projectId, input.id, 1)
    })
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    return runImmediateTransaction(this.db, () => {
      const current = this.db
        .query(
          "SELECT kind, next_version AS nextVersion FROM artifacts WHERE project_id = ? AND id = ?"
        )
        .get(input.projectId, input.artifactId) as {
        readonly kind: ArtifactRecord["kind"]
        readonly nextVersion: number
      } | null
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      if (current.kind !== input.kind) {
        throw artifactStorageErrors.kindMismatch(input.artifactId, current.kind, input.kind)
      }
      const version = current.nextVersion
      this.insertVersion(input.projectId, input.artifactId, version, input.version)
      this.db
        .query(
          `UPDATE artifacts
           SET title = ?, latest_version = ?, next_version = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`
        )
        .run(
          input.version.title,
          version,
          version + 1,
          input.version.createdAt.toISOString(),
          input.projectId,
          input.artifactId
        )
      return this.published(input.projectId, input.artifactId, version)
    })
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const row = this.artifactRow(input.projectId, input.id)
    return row ? parseArtifactRow(row) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const where = ["a.project_id = ?"]
    const params: SQLQueryBindings[] = [input.projectId]
    if (input.owner) {
      where.push("a.owner_principal_type = ? AND a.owner_principal_id = ?")
      params.push(input.owner.type, input.owner.id)
    }
    if (input.originThreadId !== undefined) {
      where.push(
        `EXISTS (
          SELECT 1 FROM artifact_versions v
          WHERE v.project_id = a.project_id AND v.artifact_id = a.id AND v.origin_thread_id = ?
        )`
      )
      params.push(input.originThreadId)
    }
    if (input.kind !== undefined) {
      where.push("a.kind = ?")
      params.push(input.kind)
    }
    const clause = where.join(" AND ")
    const { total } = this.db
      .query(`SELECT COUNT(*) AS total FROM artifacts a WHERE ${clause}`)
      .get(...params) as { readonly total: number }
    const offset = input.offset ?? 0
    const rows = this.db
      .query(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts a WHERE ${clause}
         ORDER BY a.updated_at DESC, a.id ASC LIMIT ? OFFSET ?`
      )
      .all(...params, input.limit ?? -1, offset) as Record<string, unknown>[]
    return {
      artifacts: rows.map(parseArtifactRow),
      hasMore: offset + rows.length < total,
      total,
    }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const row = this.versionRow(input.projectId, input.artifactId, input.version)
    return row ? parseArtifactVersionRow(row) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const { total } = this.db
      .query(
        "SELECT COUNT(*) AS total FROM artifact_versions WHERE project_id = ? AND artifact_id = ?"
      )
      .get(input.projectId, input.artifactId) as { readonly total: number }
    const offset = input.offset ?? 0
    const rows = this.db
      .query(
        `SELECT ${VERSION_COLUMNS} FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ?
         ORDER BY version DESC LIMIT ? OFFSET ?`
      )
      .all(input.projectId, input.artifactId, input.limit ?? -1, offset) as Record<
      string,
      unknown
    >[]
    return {
      versions: rows.map(parseArtifactVersionRow),
      hasMore: offset + rows.length < total,
      total,
    }
  }

  async listReferencingVersions(
    input: ListReferencingVersionsInput
  ): Promise<ArtifactVersionRecord[]> {
    // An address names the artifact when the id is followed by nothing, a version, a file, or a
    // part.
    const prefix = `artifact:${input.artifactId}`
    const rows = this.db
      .query(
        `SELECT ${VERSION_COLUMNS} FROM artifact_versions v
         WHERE (project_id, artifact_id, version) IN (
           SELECT project_id, id, latest_version FROM artifacts WHERE project_id = ?
         ) AND EXISTS (
           SELECT 1 FROM json_each(v.refs) r
           WHERE substr(json_extract(r.value, '$.address'), 1, ?) = ?
             AND substr(json_extract(r.value, '$.address'), ? + 1, 1) IN ('', '@', '/', '#')
         )
         ORDER BY artifact_id`
      )
      .all(input.projectId, prefix.length, prefix, prefix.length) as Record<string, unknown>[]
    return rows.map(parseArtifactVersionRow)
  }

  async createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void> {
    runImmediateTransaction(this.db, () => {
      const exists = this.db
        .query("SELECT 1 FROM artifacts WHERE project_id = ? AND id = ?")
        .get(record.projectId, record.artifactId)
      if (!exists) throw artifactStorageErrors.notFound(record.artifactId)
      this.db
        .query(
          `INSERT INTO artifact_frame_grants
             (project_id, token_hash, artifact_id, version, targets, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.projectId,
          record.tokenHash,
          record.artifactId,
          record.version,
          JSON.stringify(record.targets),
          record.createdAt.toISOString(),
          record.expiresAt.toISOString()
        )
    })
  }

  async findFrameGrant(
    input: FindArtifactFrameGrantInput
  ): Promise<ArtifactFrameGrantRecord | null> {
    const row = this.db
      .query(
        `SELECT project_id AS projectId, token_hash AS tokenHash, artifact_id AS artifactId,
                version, targets, created_at AS createdAt, expires_at AS expiresAt
         FROM artifact_frame_grants WHERE project_id = ? AND token_hash = ?`
      )
      .get(input.projectId, input.tokenHash) as Record<string, unknown> | null
    return row ? frameGrantFromRow(row) : null
  }

  async deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number> {
    return this.db
      .query(
        `DELETE FROM artifact_frame_grants WHERE rowid IN (
           SELECT rowid FROM artifact_frame_grants
           WHERE project_id = ? AND expires_at < ?
           ORDER BY expires_at LIMIT ?
         )`
      )
      .run(input.projectId, input.expiredBefore.toISOString(), input.limit).changes
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    // Versions and frame grants go with the artifact through ON DELETE CASCADE.
    return (
      this.db
        .query("DELETE FROM artifacts WHERE project_id = ? AND id = ?")
        .run(input.projectId, input.id).changes > 0
    )
  }

  async deleteVersionsByOrigin(input: DeleteArtifactVersionsByOriginInput): Promise<number> {
    return runImmediateTransaction(this.db, () => {
      const affected = this.db
        .query(
          `SELECT DISTINCT artifact_id AS artifactId FROM artifact_versions
           WHERE project_id = ? AND origin_run_id = ?`
        )
        .all(input.projectId, input.runId) as { readonly artifactId: string }[]
      const deleted = this.db
        .query("DELETE FROM artifact_versions WHERE project_id = ? AND origin_run_id = ?")
        .run(input.projectId, input.runId).changes
      for (const { artifactId } of affected) {
        this.repointLatest(input.projectId, artifactId)
      }
      return deleted
    })
  }

  /** Point an artifact at its newest remaining version, or delete it when none remains. */
  private repointLatest(projectId: string, artifactId: string): void {
    const latest = this.db
      .query(
        `SELECT version, title, created_at AS createdAt FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1`
      )
      .get(projectId, artifactId) as {
      readonly version: number
      readonly title: string
      readonly createdAt: string
    } | null
    if (!latest) {
      this.db
        .query("DELETE FROM artifacts WHERE project_id = ? AND id = ?")
        .run(projectId, artifactId)
      return
    }
    this.db
      .query(
        `UPDATE artifacts SET title = ?, latest_version = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`
      )
      .run(latest.title, latest.version, latest.createdAt, projectId, artifactId)
  }

  private insertVersion(
    projectId: string,
    artifactId: string,
    version: number,
    input: ArtifactVersionInput
  ): void {
    this.db
      .query(
        `INSERT INTO artifact_versions (
          project_id, artifact_id, version, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        artifactId,
        version,
        input.title,
        input.entry,
        JSON.stringify(input.files),
        JSON.stringify(input.outline),
        JSON.stringify(input.references),
        input.author.type,
        input.author.id,
        input.origin?.threadId ?? null,
        input.origin?.runId ?? null,
        input.createdAt.toISOString()
      )
  }

  private published(
    projectId: string,
    artifactId: string,
    version: number
  ): PublishedArtifactVersion {
    const artifact = this.artifactRow(projectId, artifactId)
    const stored = this.versionRow(projectId, artifactId, version)
    if (!artifact || !stored) throw artifactStorageErrors.notFound(artifactId)
    return { artifact: parseArtifactRow(artifact), version: parseArtifactVersionRow(stored) }
  }

  private artifactRow(projectId: string, id: string): Record<string, unknown> | null {
    return this.db
      .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ? AND id = ?`)
      .get(projectId, id) as Record<string, unknown> | null
  }

  private versionRow(
    projectId: string,
    artifactId: string,
    version: number
  ): Record<string, unknown> | null {
    return this.db
      .query(
        `SELECT ${VERSION_COLUMNS} FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(projectId, artifactId, version) as Record<string, unknown> | null
  }
}

function frameGrantFromRow(row: Record<string, unknown>): ArtifactFrameGrantRecord {
  return {
    projectId: String(row.projectId),
    tokenHash: String(row.tokenHash),
    artifactId: String(row.artifactId),
    version: Number(row.version),
    targets: JSON.parse(String(row.targets)) as ArtifactFrameTarget[],
    createdAt: new Date(String(row.createdAt)),
    expiresAt: new Date(String(row.expiresAt)),
  }
}
