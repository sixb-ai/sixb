import {
  artifactStorageErrors,
  parseArtifactFrameGrantRow,
  parseArtifactRow,
  parseArtifactVersionRow,
} from "@sixb/core/internal/storage"
import type {
  ArtifactFrameGrantRecord,
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
import type { SQLClient, SqlParameter } from "./pg-client"
import { type PgStoreClient, runPgTransaction } from "./transactions"

interface PgRow {
  readonly [column: string]: unknown
}

// Quoted aliases give the shared row parsers their camelCase keys; an unquoted alias would fold to
// lower case.
const ARTIFACT_COLUMNS = `
  project_id AS "projectId", id, kind, title,
  owner_principal_type AS "ownerPrincipalType", owner_principal_id AS "ownerPrincipalId",
  latest_version AS "latestVersion", created_at AS "createdAt", updated_at AS "updatedAt"
`

const VERSION_COLUMNS = `
  project_id AS "projectId", artifact_id AS "artifactId", version, title, entry, files, outline,
  refs, author_principal_type AS "authorPrincipalType", author_principal_id AS "authorPrincipalId",
  origin_thread_id AS "originThreadId", origin_run_id AS "originRunId", created_at AS "createdAt"
`

const FRAME_GRANT_COLUMNS = `
  project_id AS "projectId", token_hash AS "tokenHash", artifact_id AS "artifactId", version,
  targets, created_at AS "createdAt", expires_at AS "expiresAt"
`

export class PgArtifactStorage implements ArtifactStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const [artifact] = await tx<PgRow[]>`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, created_at, updated_at
        ) VALUES (
          ${input.projectId}, ${input.id}, ${input.kind}, ${input.version.title},
          ${input.owner.type}, ${input.owner.id}, 1, 2,
          ${input.version.createdAt}, ${input.version.createdAt}
        )
        ON CONFLICT (project_id, id) DO NOTHING
        RETURNING ${tx.unsafe(ARTIFACT_COLUMNS)}
      `
      if (!artifact) throw artifactStorageErrors.exists(input.id)
      return {
        artifact: parseArtifactRow(artifact),
        version: await insertVersion(tx, input.projectId, input.id, 1, input.version),
      }
    })
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      // The row lock serializes concurrent publishes of one artifact.
      const [current] = await tx<PgRow[]>`
        SELECT kind, next_version, latest_version FROM artifacts
        WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
        FOR UPDATE
      `
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const kind = current.kind as ArtifactRecord["kind"]
      if (kind !== input.kind) {
        throw artifactStorageErrors.kindMismatch(input.artifactId, kind, input.kind)
      }
      // Under the row lock: a publish from the same base after this one finds it moved.
      const latestVersion = Number(current.latest_version)
      if (input.baseVersion !== undefined && latestVersion !== input.baseVersion) {
        const [row] = await tx<PgRow[]>`
          SELECT ${tx.unsafe(VERSION_COLUMNS)} FROM artifact_versions
          WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
            AND version = ${latestVersion}
        `
        const latest = parseArtifactVersionRow(row as PgRow)
        throw artifactStorageErrors.moved(input.artifactId, input.baseVersion, {
          version: latest.version,
          author: latest.author,
        })
      }
      const version = await insertVersion(
        tx,
        input.projectId,
        input.artifactId,
        Number(current.next_version),
        input.version
      )
      const [artifact] = await tx<PgRow[]>`
        UPDATE artifacts
        SET title = ${input.version.title}, latest_version = ${version.version},
            next_version = ${version.version + 1}, updated_at = ${input.version.createdAt}
        WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
        RETURNING ${tx.unsafe(ARTIFACT_COLUMNS)}
      `
      return { artifact: parseArtifactRow(artifact), version }
    })
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(ARTIFACT_COLUMNS)} FROM artifacts
      WHERE project_id = ${input.projectId} AND id = ${input.id}
    `
    return row ? parseArtifactRow(row) : null
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
    if (input.kind !== undefined) {
      where.push(`a.kind = $${params.length + 1}`)
      params.push(input.kind)
    }
    const clause = where.join(" AND ")
    const [counted] = await this.sql.unsafe<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM artifacts a WHERE ${clause}`,
      params
    )
    const offset = input.offset ?? 0
    const rows = await this.sql.unsafe<PgRow[]>(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts a WHERE ${clause}
       ORDER BY a.updated_at DESC, a.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit ?? null, offset]
    )
    const total = counted?.total ?? 0
    return { artifacts: rows.map(parseArtifactRow), hasMore: offset + rows.length < total, total }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(VERSION_COLUMNS)} FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND version = ${input.version}
    `
    return row ? parseArtifactVersionRow(row) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const [counted] = await this.sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
    `
    const offset = input.offset ?? 0
    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(VERSION_COLUMNS)} FROM artifact_versions
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
      ORDER BY version DESC
      LIMIT ${input.limit ?? null} OFFSET ${offset}
    `
    const total = counted?.total ?? 0
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
    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(VERSION_COLUMNS)} FROM artifact_versions v
      WHERE project_id = ${input.projectId} AND (artifact_id, version) IN (
        SELECT id, latest_version FROM artifacts WHERE project_id = ${input.projectId}
      ) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v.refs) r
        WHERE left(r ->> 'address', ${prefix.length}::int) = ${prefix}
          AND substr(r ->> 'address', ${prefix.length + 1}::int, 1) IN ('', '@', '/', '#')
      )
      ORDER BY artifact_id
    `
    return rows.map(parseArtifactVersionRow)
  }

  async createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void> {
    const rows = await this.sql`
      INSERT INTO artifact_frame_grants
        (project_id, token_hash, artifact_id, version, targets, created_at, expires_at)
      SELECT ${record.projectId}, ${record.tokenHash}, ${record.artifactId}, ${record.version},
             ${JSON.stringify(record.targets)}::text::jsonb, ${record.createdAt},
             ${record.expiresAt}
      WHERE EXISTS (
        SELECT 1 FROM artifacts WHERE project_id = ${record.projectId} AND id = ${record.artifactId}
      )
      RETURNING token_hash
    `
    if (rows.length === 0) throw artifactStorageErrors.notFound(record.artifactId)
  }

  async findFrameGrant(
    input: FindArtifactFrameGrantInput
  ): Promise<ArtifactFrameGrantRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(FRAME_GRANT_COLUMNS)} FROM artifact_frame_grants
      WHERE project_id = ${input.projectId} AND token_hash = ${input.tokenHash}
    `
    return row ? parseArtifactFrameGrantRow(row) : null
  }

  async deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number> {
    const rows = await this.sql`
      DELETE FROM artifact_frame_grants
      WHERE (project_id, token_hash) IN (
        SELECT project_id, token_hash FROM artifact_frame_grants
        WHERE project_id = ${input.projectId} AND expires_at < ${input.expiredBefore}
        ORDER BY expires_at LIMIT ${input.limit}
      )
      RETURNING token_hash
    `
    return rows.length
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    // Versions and frame grants go with the artifact through ON DELETE CASCADE.
    const rows = await this.sql`
      DELETE FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING id
    `
    return rows.length > 0
  }

  async deleteVersionsByOrigin(input: DeleteArtifactVersionsByOriginInput): Promise<number> {
    return runPgTransaction(this.sql, async (tx) => {
      // Lock the run's artifacts first, in id order so two of these never deadlock. `publish`
      // holds the same lock while it adds a version, and under READ COMMITTED each statement
      // below then reads a snapshot taken after any publish that held it committed. Without the
      // lock they would wait on a publish's row lock and then apply what they read before it: the
      // UPDATE would point `latest_version` back past the new version, and the DELETE would drop
      // an artifact whose versions were all the run's, cascading the new version with it.
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM artifacts
        WHERE project_id = ${input.projectId} AND id IN (
          SELECT artifact_id FROM artifact_versions
          WHERE project_id = ${input.projectId} AND origin_run_id = ${input.runId}
        )
        ORDER BY id
        FOR UPDATE
      `
      const affected = locked.map((row) => row.id)
      if (affected.length === 0) return 0
      const deleted = await tx`
        DELETE FROM artifact_versions
        WHERE project_id = ${input.projectId} AND origin_run_id = ${input.runId}
          AND artifact_id IN ${tx(affected)}
        RETURNING version
      `
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
): Promise<ArtifactVersionRecord> {
  const [row] = await sql<PgRow[]>`
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
    RETURNING ${sql.unsafe(VERSION_COLUMNS)}
  `
  return parseArtifactVersionRow(row)
}
