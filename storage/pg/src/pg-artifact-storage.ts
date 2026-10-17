import {
  artifactStorageErrors,
  parseArtifactRow,
  parseArtifactVersionRow,
} from "@sixb/core/internal/storage"
import type {
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  CreateArtifactInput,
  DeleteArtifactInput,
  DeleteArtifactVersionsByOriginInput,
  GetArtifactInput,
  GetArtifactVersionInput,
  ListArtifactsInput,
  ListArtifactsResult,
  ListArtifactVersionsInput,
  ListArtifactVersionsResult,
  PublishArtifactVersionInput,
  PublishedArtifactVersion,
} from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "./pg-client"
import { type PgStoreClient, runPgTransaction } from "./transactions"

interface PgRow {
  readonly [column: string]: unknown
}

export class PgArtifactStorage implements ArtifactStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const [inserted] = await tx<PgRow[]>`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, created_at, updated_at
        ) VALUES (
          ${input.projectId}, ${input.id}, ${input.kind}, ${input.version.title},
          ${input.owner.type}, ${input.owner.id}, 1, 2,
          ${input.version.createdAt}, ${input.version.createdAt}
        )
        ON CONFLICT (project_id, id) DO NOTHING
        RETURNING id
      `
      if (!inserted) throw artifactStorageErrors.exists(input.id)
      await insertVersion(tx, input.projectId, input.id, 1, input.version)
      return published(tx, input.projectId, input.id, 1)
    })
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      // The row lock serializes concurrent publishes of one artifact.
      const [current] = await tx<PgRow[]>`
        SELECT kind, next_version FROM artifacts
        WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
        FOR UPDATE
      `
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const kind = current.kind as ArtifactRecord["kind"]
      if (kind !== input.kind) {
        throw artifactStorageErrors.kindMismatch(input.artifactId, kind, input.kind)
      }
      const version = Number(current.next_version)
      await insertVersion(tx, input.projectId, input.artifactId, version, input.version)
      await tx`
        UPDATE artifacts
        SET title = ${input.version.title}, latest_version = ${version},
            next_version = ${version + 1}, updated_at = ${input.version.createdAt}
        WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
      `
      return published(tx, input.projectId, input.artifactId, version)
    })
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT * FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}
    `
    return row ? artifactFromRow(row) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const where = ["a.project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    if (input.owner) {
      where.push(`a.owner_principal_type = $${params.length + 1}`)
      params.push(input.owner.type)
      where.push(`a.owner_principal_id = $${params.length + 1}`)
      params.push(input.owner.id)
    }
    if (input.originThreadId !== undefined) {
      where.push(
        `EXISTS (
          SELECT 1 FROM artifact_versions v
          WHERE v.project_id = a.project_id AND v.artifact_id = a.id
            AND v.origin_thread_id = $${params.length + 1}
        )`
      )
      params.push(input.originThreadId)
    }
    const clause = where.join(" AND ")
    const [counted] = await this.sql.unsafe<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM artifacts a WHERE ${clause}`,
      params
    )
    const offset = input.offset ?? 0
    const rows = await this.sql.unsafe<PgRow[]>(
      `SELECT a.* FROM artifacts a WHERE ${clause}
       ORDER BY a.updated_at DESC, a.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit ?? null, offset]
    )
    const total = counted?.total ?? 0
    return { artifacts: rows.map(artifactFromRow), hasMore: offset + rows.length < total, total }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT * FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND version = ${input.version}
    `
    return row ? versionFromRow(row) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const [counted] = await this.sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
    `
    const offset = input.offset ?? 0
    const rows = await this.sql<PgRow[]>`
      SELECT * FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
      ORDER BY version DESC
      LIMIT ${input.limit ?? null} OFFSET ${offset}
    `
    const total = counted?.total ?? 0
    return { versions: rows.map(versionFromRow), hasMore: offset + rows.length < total, total }
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    // Versions go with the artifact through the foreign key's ON DELETE CASCADE.
    const rows = await this.sql`
      DELETE FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING id
    `
    return rows.length > 0
  }

  async deleteVersionsByOrigin(input: DeleteArtifactVersionsByOriginInput): Promise<number> {
    return runPgTransaction(this.sql, async (tx) => {
      const deleted = await tx<{ artifact_id: string }[]>`
        DELETE FROM artifact_versions
        WHERE project_id = ${input.projectId} AND origin_run_id = ${input.runId}
        RETURNING artifact_id
      `
      const affected = [...new Set(deleted.map((row) => row.artifact_id))]
      if (affected.length === 0) return 0
      // An artifact left without versions goes; the rest point at their newest remaining one.
      await tx`
        DELETE FROM artifacts a
        WHERE a.project_id = ${input.projectId} AND a.id IN ${tx(affected)}
          AND NOT EXISTS (
            SELECT 1 FROM artifact_versions v
            WHERE v.project_id = a.project_id AND v.artifact_id = a.id
          )
      `
      await tx`
        UPDATE artifacts a
        SET latest_version = latest.version, title = latest.title, updated_at = latest.created_at
        FROM (
          SELECT DISTINCT ON (artifact_id) artifact_id, version, title, created_at
          FROM artifact_versions
          WHERE project_id = ${input.projectId} AND artifact_id IN ${tx(affected)}
          ORDER BY artifact_id, version DESC
        ) latest
        WHERE a.project_id = ${input.projectId} AND a.id = latest.artifact_id
      `
      return deleted.length
    })
  }
}

async function insertVersion(
  sql: SQLClient,
  projectId: string,
  artifactId: string,
  version: number,
  input: ArtifactVersionInput
): Promise<void> {
  await sql`
    INSERT INTO artifact_versions (
      project_id, artifact_id, version, title, entry, files, outline, refs,
      author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at
    ) VALUES (
      ${projectId}, ${artifactId}, ${version}, ${input.title}, ${input.entry},
      ${JSON.stringify(input.files)}::text::jsonb,
      ${JSON.stringify(input.outline)}::text::jsonb,
      ${JSON.stringify(input.references)}::text::jsonb,
      ${input.author.type}, ${input.author.id},
      ${input.origin?.threadId ?? null}, ${input.origin?.runId ?? null}, ${input.createdAt}
    )
  `
}

async function published(
  sql: SQLClient,
  projectId: string,
  artifactId: string,
  version: number
): Promise<PublishedArtifactVersion> {
  const [artifact] = await sql<PgRow[]>`
    SELECT * FROM artifacts WHERE project_id = ${projectId} AND id = ${artifactId}
  `
  const [stored] = await sql<PgRow[]>`
    SELECT * FROM artifact_versions
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND version = ${version}
  `
  if (!artifact || !stored) throw artifactStorageErrors.notFound(artifactId)
  return { artifact: artifactFromRow(artifact), version: versionFromRow(stored) }
}

function artifactFromRow(row: PgRow): ArtifactRecord {
  return parseArtifactRow({
    projectId: row.project_id,
    id: row.id,
    kind: row.kind,
    title: row.title,
    ownerPrincipalType: row.owner_principal_type,
    ownerPrincipalId: row.owner_principal_id,
    latestVersion: row.latest_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function versionFromRow(row: PgRow): ArtifactVersionRecord {
  return parseArtifactVersionRow({
    projectId: row.project_id,
    artifactId: row.artifact_id,
    version: row.version,
    title: row.title,
    entry: row.entry,
    files: row.files,
    outline: row.outline,
    refs: row.refs,
    authorPrincipalType: row.author_principal_type,
    authorPrincipalId: row.author_principal_id,
    originThreadId: row.origin_thread_id,
    originRunId: row.origin_run_id,
    createdAt: row.created_at,
  })
}
