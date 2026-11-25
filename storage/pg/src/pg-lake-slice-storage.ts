import { parseLakeSliceGrantRow, parseLakeSliceRow } from "@sixb/core/internal/storage"
import type {
  DeleteExpiredLakeSlicesInput,
  LakeSliceGrantRecord,
  LakeSliceRecord,
  LakeSliceRef,
  LakeSliceStorage,
  ListLiveLakeSlicesInput,
} from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

export class PgLakeSliceStorage implements LakeSliceStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(record: LakeSliceRecord): Promise<void> {
    await this.sql`
      INSERT INTO lake_slices (
        project_id, id, user_id, branch, point, versions, files, created_at, last_token_expires_at,
        credential_hash
      ) VALUES (
        ${record.projectId}, ${record.id}, ${record.userId}, ${record.branch}, ${record.point},
        ${JSON.stringify(record.versions)}::text::jsonb, ${JSON.stringify(record.files)}::text::jsonb,
        ${record.createdAt}, ${record.lastTokenExpiresAt ?? null}, ${record.credentialHash ?? null}
      )
    `
  }

  async get(input: LakeSliceRef): Promise<LakeSliceRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT * FROM lake_slices WHERE project_id = ${input.projectId} AND id = ${input.id}
    `
    return row ? sliceFromRow(row) : null
  }

  async delete(input: LakeSliceRef): Promise<void> {
    await this
      .sql`DELETE FROM lake_slices WHERE project_id = ${input.projectId} AND id = ${input.id}`
  }

  async createGrant(record: LakeSliceGrantRecord): Promise<void> {
    await this.sql`
      WITH grant_row AS (
        INSERT INTO lake_slice_grants (project_id, id, token_hash, slice_id, created_at, expires_at)
        VALUES (
          ${record.projectId}, ${record.id}, ${record.tokenHash}, ${record.sliceId},
          ${record.createdAt}, ${record.expiresAt}
        )
        RETURNING project_id, slice_id, expires_at
      )
      UPDATE lake_slices SET last_token_expires_at = GREATEST(
        coalesce(last_token_expires_at, grant_row.expires_at), grant_row.expires_at
      )
      FROM grant_row
      WHERE lake_slices.project_id = grant_row.project_id AND lake_slices.id = grant_row.slice_id
    `
  }

  async findByCredentialHash(input: {
    readonly projectId: string
    readonly credentialHash: string
  }): Promise<LakeSliceRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT * FROM lake_slices
      WHERE project_id = ${input.projectId} AND credential_hash = ${input.credentialHash}
    `
    return row ? sliceFromRow(row) : null
  }

  async findGrantByTokenHash(input: {
    readonly projectId: string
    readonly tokenHash: string
  }): Promise<LakeSliceGrantRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT * FROM lake_slice_grants
      WHERE project_id = ${input.projectId} AND token_hash = ${input.tokenHash}
    `
    return row
      ? parseLakeSliceGrantRow({
          id: row.id,
          projectId: row.project_id,
          tokenHash: row.token_hash,
          sliceId: row.slice_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        })
      : null
  }

  async listLive(input: ListLiveLakeSlicesInput): Promise<readonly LakeSliceRecord[]> {
    const rows = await this.sql<PgRow[]>`
      SELECT * FROM lake_slices
      WHERE project_id = ${input.projectId}
        AND coalesce(last_token_expires_at, created_at) > ${input.liveAfter}
      ORDER BY created_at
    `
    return rows.map(sliceFromRow)
  }

  async deleteExpired(input: DeleteExpiredLakeSlicesInput): Promise<number> {
    const rows = await this.sql`
      DELETE FROM lake_slices
      WHERE project_id = ${input.projectId} AND id IN (
        SELECT id FROM lake_slices
        WHERE project_id = ${input.projectId}
          AND coalesce(last_token_expires_at, created_at) <= ${input.before}
        ORDER BY coalesce(last_token_expires_at, created_at)
        LIMIT ${input.limit}
      )
      RETURNING id
    `
    await this.sql`
      DELETE FROM lake_slice_grants
      WHERE project_id = ${input.projectId} AND expires_at < ${input.before}
    `
    return rows.length
  }
}

interface PgRow {
  readonly [column: string]: unknown
}

function sliceFromRow(row: PgRow): LakeSliceRecord {
  return parseLakeSliceRow({
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    branch: row.branch,
    point: row.point,
    versions: row.versions,
    files: row.files,
    createdAt: row.created_at,
    lastTokenExpiresAt: row.last_token_expires_at,
    credentialHash: row.credential_hash,
  })
}
