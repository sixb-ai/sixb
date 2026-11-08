import {
  ARTIFACT_RESTORE_POINTS,
  artifactStateBytes,
  artifactStorageErrors,
  checkArtifactStateWrite,
  parseArtifactBoardPreviewRow,
  parseArtifactFrameGrantRow,
  parseArtifactRestorePointRow,
  parseArtifactRow,
  parseArtifactStateRow,
  parseArtifactTurnWriteRow,
  parseArtifactVersionRow,
} from "@sixb/core/internal/storage"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactFrameGrantRecord,
  ArtifactRecord,
  ArtifactRestorePointReason,
  ArtifactRestorePointRecord,
  ArtifactStateEntry,
  ArtifactStateKeyInput,
  ArtifactStateScope,
  ArtifactStorage,
  ArtifactTurnInput,
  ArtifactTurnWriteRecord,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  CopyArtifactInput,
  CreateArtifactInput,
  DeleteArtifactInput,
  DeleteExpiredArtifactFrameGrantsInput,
  FindArtifactFrameGrantInput,
  FreezeArtifactVersionInput,
  GetArtifactInput,
  GetArtifactRestorePointInput,
  GetArtifactVersionInput,
  ListArtifactBoardPreviewsInput,
  ListArtifactsInput,
  ListArtifactsResult,
  ListArtifactVersionsInput,
  ListArtifactVersionsResult,
  ListReferencingVersionsInput,
  PublishArtifactVersionInput,
  PublishedArtifactVersion,
  PutArtifactBoardPreviewsInput,
  RestoreArtifactInput,
  SetArtifactStateInput,
  UndoneArtifactTurn,
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
  latest_version AS "latestVersion", revision, created_at AS "createdAt",
  updated_at AS "updatedAt"
`

/** What a version and a restore point both hold, and who last wrote it from where. */
const CONTENT_COLUMNS = `
  title, entry, files, outline, refs, author_principal_type AS "authorPrincipalType",
  author_principal_id AS "authorPrincipalId", origin_thread_id AS "originThreadId",
  origin_run_id AS "originRunId", updated_at AS "updatedAt"
`

const VERSION_COLUMNS = `
  project_id AS "projectId", artifact_id AS "artifactId", version, revision, ${CONTENT_COLUMNS},
  created_at AS "createdAt", frozen_at AS "frozenAt"
`

const RESTORE_POINT_COLUMNS = `
  project_id AS "projectId", artifact_id AS "artifactId", revision, version, frozen,
  ${CONTENT_COLUMNS}, reason, turn_run_id AS "turnRunId", created_at AS "createdAt"
`

const TURN_WRITE_COLUMNS = `artifact_id AS "artifactId", created, revision`

const FRAME_GRANT_COLUMNS = `
  project_id AS "projectId", token_hash AS "tokenHash", artifact_id AS "artifactId", version,
  revision, targets, created_at AS "createdAt", expires_at AS "expiresAt"
`

const STATE_COLUMNS = `key, value, size_bytes AS "sizeBytes", updated_at AS "updatedAt"`

const BOARD_PREVIEW_COLUMNS = `
  project_id AS "projectId", render_key AS "renderKey", theme, size, file,
  created_at AS "createdAt"
`

export class PgArtifactStorage implements ArtifactStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const content = input.version
      const [artifact] = await tx<PgRow[]>`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, revision, created_at, updated_at
        ) VALUES (
          ${input.projectId}, ${input.id}, ${input.kind}, ${content.title},
          ${input.owner.type}, ${input.owner.id}, 1, 2, 1,
          ${content.updatedAt}, ${content.updatedAt}
        )
        ON CONFLICT (project_id, id) DO NOTHING
        RETURNING ${tx.unsafe(ARTIFACT_COLUMNS)}
      `
      if (!artifact) throw artifactStorageErrors.exists(input.id)

      const version = await insertVersion(tx, {
        projectId: input.projectId,
        artifactId: input.id,
        version: 1,
        revision: 1,
        content,
      })
      await shareIn(tx, input.projectId, input.id, content, input.turnRunId)
      if (input.turnRunId) {
        await recordTurnWrite(tx, {
          projectId: input.projectId,
          artifactId: input.id,
          turnRunId: input.turnRunId,
          created: true,
          revision: 1,
        })
      }

      return { artifact: parseArtifactRow(artifact), version }
    })
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const current = await lockArtifact(tx, input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current
      if (artifact.kind !== input.kind) {
        throw artifactStorageErrors.kindMismatch(input.artifactId, artifact.kind, input.kind)
      }

      // Under the row lock: a write from the same base after this one finds it moved.
      const latest = await latestVersion(tx, artifact)
      assertBase(artifact, latest, input.baseRevision)

      // A turn's first write keeps what it replaces, so the turn can be undone.
      const { turnRunId } = input
      if (turnRunId && !(await turnWrote(tx, artifact, turnRunId))) {
        await keepRestorePoint(tx, latest, {
          reason: "turn",
          turnRunId,
          createdAt: input.version.updatedAt,
        })
      }

      const written = await writeLatest(tx, current, latest, input.version)
      await shareIn(tx, input.projectId, input.artifactId, input.version, turnRunId)
      if (turnRunId) {
        await recordTurnWrite(tx, {
          projectId: input.projectId,
          artifactId: input.artifactId,
          turnRunId,
          created: false,
          revision: written.artifact.revision,
        })
      }

      return written
    })
  }

  async freeze(input: FreezeArtifactVersionInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const current = await lockArtifact(tx, input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current

      const latest = await latestVersion(tx, artifact)
      if (latest.frozenAt) return { artifact, version: latest }
      assertBase(artifact, latest, input.baseRevision)

      const revision = artifact.revision + 1
      const [version] = await tx<PgRow[]>`
        UPDATE artifact_versions SET revision = ${revision}, frozen_at = ${input.frozenAt}
        WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
          AND version = ${latest.version}
        RETURNING ${tx.unsafe(VERSION_COLUMNS)}
      `
      const [updated] = await tx<PgRow[]>`
        UPDATE artifacts SET revision = ${revision}, updated_at = ${input.frozenAt}
        WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
        RETURNING ${tx.unsafe(ARTIFACT_COLUMNS)}
      `
      return {
        artifact: parseArtifactRow(updated as PgRow),
        version: parseArtifactVersionRow(version as PgRow),
      }
    })
  }

  async listRestorePoints(input: GetArtifactInput): Promise<ArtifactRestorePointRecord[]> {
    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(RESTORE_POINT_COLUMNS)} FROM artifact_restore_points
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.id}
      ORDER BY revision DESC
    `
    return rows.map(parseArtifactRestorePointRow)
  }

  async getRestorePoint(
    input: GetArtifactRestorePointInput
  ): Promise<ArtifactRestorePointRecord | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(RESTORE_POINT_COLUMNS)} FROM artifact_restore_points
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND revision = ${input.revision}
    `
    return row ? parseArtifactRestorePointRow(row) : null
  }

  async restoreTo(input: RestoreArtifactInput): Promise<PublishedArtifactVersion> {
    return runPgTransaction(this.sql, async (tx) => {
      const current = await lockArtifact(tx, input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current

      const [row] = await tx<PgRow[]>`
        SELECT ${tx.unsafe(RESTORE_POINT_COLUMNS)} FROM artifact_restore_points
        WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
          AND revision = ${input.revision}
      `
      if (!row) throw artifactStorageErrors.restorePointNotFound(input.artifactId, input.revision)
      const point = parseArtifactRestorePointRow(row)

      const latest = await latestVersion(tx, artifact)
      assertBase(artifact, latest, input.baseRevision)

      // What the restore replaces is kept first, so the restore can be undone.
      await keepRestorePoint(tx, latest, { reason: "restore", createdAt: input.restoredAt })
      return writeLatest(tx, current, latest, {
        title: point.title,
        entry: point.entry,
        files: point.files,
        outline: point.outline,
        references: point.references,
        author: input.author,
        updatedAt: input.restoredAt,
      })
    })
  }

  async listTurnWrites(input: ArtifactTurnInput): Promise<ArtifactTurnWriteRecord[]> {
    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(TURN_WRITE_COLUMNS)} FROM artifact_turn_writes
      WHERE project_id = ${input.projectId} AND turn_run_id = ${input.turnRunId}
      ORDER BY artifact_id COLLATE "C"
    `
    return rows.map(parseArtifactTurnWriteRow)
  }

  async undoTurnWrites(input: ArtifactTurnInput): Promise<UndoneArtifactTurn> {
    return runPgTransaction(this.sql, async (tx) => {
      const { projectId, turnRunId } = input

      // Lock the turn's artifacts first, in id order so two of these never deadlock. A write
      // holds the same lock, and under READ COMMITTED each statement below then reads a snapshot
      // taken after any write that held it committed: a revision read here is the artifact's.
      await tx`
        SELECT id FROM artifacts
        WHERE project_id = ${projectId} AND id IN (
          SELECT artifact_id FROM artifact_turn_writes
          WHERE project_id = ${projectId} AND turn_run_id = ${turnRunId}
        )
        ORDER BY id
        FOR UPDATE
      `
      const writes = await tx<PgRow[]>`
        SELECT w.artifact_id AS "artifactId", w.created, w.revision
        FROM artifact_turn_writes w
        JOIN artifacts a ON a.project_id = w.project_id AND a.id = w.artifact_id
        WHERE w.project_id = ${projectId} AND w.turn_run_id = ${turnRunId}
          AND a.revision = w.revision
        ORDER BY w.artifact_id COLLATE "C"
      `

      const restored: PublishedArtifactVersion[] = []
      const deleted: string[] = []
      for (const write of writes.map(parseArtifactTurnWriteRow)) {
        if (write.created) {
          await tx`DELETE FROM artifacts WHERE project_id = ${projectId} AND id = ${write.artifactId}`
          deleted.push(write.artifactId)
          continue
        }

        const undone = await undoTurn(tx, projectId, write.artifactId, turnRunId)
        if (undone) restored.push(undone)
      }

      // What the turn left: the restore points it was undone to, its writes, and its links.
      if (restored.length > 0) {
        await tx`
          DELETE FROM artifact_restore_points
          WHERE project_id = ${projectId} AND turn_run_id = ${turnRunId}
            AND artifact_id IN ${tx(restored.map(({ artifact }) => artifact.id))}
        `
      }
      await tx`
        DELETE FROM artifact_turn_writes
        WHERE project_id = ${projectId} AND turn_run_id = ${turnRunId}
      `
      await tx`
        DELETE FROM artifact_threads
        WHERE project_id = ${projectId} AND linked_by_run_id = ${turnRunId} AND NOT copied
      `

      return { restored, deleted }
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
    if (input.threadId !== undefined) {
      where.push(
        `EXISTS (
          SELECT 1 FROM artifact_threads t
          WHERE t.project_id = a.project_id AND t.artifact_id = a.id
            AND t.thread_id = $${params.length + 1}
        )`
      )
      params.push(input.threadId)
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

  async listThreadIds(input: GetArtifactInput): Promise<string[]> {
    const rows = await this.sql<{ thread_id: string }[]>`
      SELECT thread_id FROM artifact_threads
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.id}
      ORDER BY thread_id COLLATE "C"
    `
    return rows.map((row) => row.thread_id)
  }

  async copy(input: CopyArtifactInput): Promise<ArtifactRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      // The share lock keeps the source from being deleted or written while it is copied, so the
      // copy holds every version it has, as it is.
      const [source] = await tx<PgRow[]>`
        SELECT id FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.sourceId}
        FOR SHARE
      `
      if (!source) throw artifactStorageErrors.notFound(input.sourceId)

      const [artifact] = await tx<PgRow[]>`
        INSERT INTO artifacts (
          project_id, id, kind, title, owner_principal_type, owner_principal_id,
          latest_version, next_version, revision, created_at, updated_at
        )
        SELECT project_id, ${input.id}, kind, title, ${input.owner.type}, ${input.owner.id},
               latest_version, next_version, revision, created_at, updated_at
        FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.sourceId}
        ON CONFLICT (project_id, id) DO NOTHING
        RETURNING ${tx.unsafe(ARTIFACT_COLUMNS)}
      `
      if (!artifact) throw artifactStorageErrors.exists(input.id)

      await tx`
        INSERT INTO artifact_versions (
          project_id, artifact_id, version, revision, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, created_at, updated_at, frozen_at
        )
        SELECT project_id, ${input.id}, version, revision, title, entry, files, outline, refs,
               author_principal_type, author_principal_id, created_at, updated_at, frozen_at
        FROM artifact_versions
        WHERE project_id = ${input.projectId} AND artifact_id = ${input.sourceId}
      `

      if (input.outlineOf) {
        const copied = await tx<PgRow[]>`
          SELECT ${tx.unsafe(VERSION_COLUMNS)} FROM artifact_versions
          WHERE project_id = ${input.projectId} AND artifact_id = ${input.id}
        `
        for (const version of copied.map(parseArtifactVersionRow)) {
          const outline = input.outlineOf(version)
          if (!outline) continue

          await tx`
            UPDATE artifact_versions SET outline = ${JSON.stringify(outline)}::text::jsonb
            WHERE project_id = ${input.projectId} AND artifact_id = ${input.id}
              AND version = ${version.version}
          `
        }
      }
      await tx`
        INSERT INTO artifact_threads (project_id, artifact_id, thread_id, shared_at, copied)
        VALUES (
          ${input.projectId}, ${input.id}, ${input.threadId}, ${input.copiedAt ?? new Date()}, TRUE
        )
      `
      return parseArtifactRow(artifact)
    })
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
        (project_id, token_hash, artifact_id, version, revision, targets, created_at, expires_at)
      SELECT ${record.projectId}, ${record.tokenHash}, ${record.artifactId}, ${record.version},
             ${record.revision}, ${JSON.stringify(record.targets)}::text::jsonb,
             ${record.createdAt}, ${record.expiresAt}
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

  async getState(input: ArtifactStateKeyInput): Promise<ArtifactStateEntry | null> {
    const [row] = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(STATE_COLUMNS)} FROM artifact_state
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
        AND key = ${input.key}
    `
    return row ? parseArtifactStateRow(row) : null
  }

  async setState(input: SetArtifactStateInput): Promise<void> {
    await runPgTransaction(this.sql, async (tx) => {
      // The key share lock keeps the artifact from being deleted under the write, without
      // waiting on a publish.
      const [artifact] = await tx<PgRow[]>`
        SELECT 1 FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.artifactId}
        FOR KEY SHARE
      `
      if (!artifact) throw artifactStorageErrors.notFound(input.artifactId)
      // One reader's writes to one artifact take turns, so two at once cannot both fit under the
      // limits; other readers' writes do not wait.
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
          "artifact_state",
          input.projectId,
          input.artifactId,
          input.principal.type,
          input.principal.id,
        ])}, 0))
      `
      const [others] = await tx<PgRow[]>`
        SELECT count(*) AS keys, coalesce(sum(size_bytes), 0) AS bytes FROM artifact_state
        WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
          AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
          AND key <> ${input.key}
      `
      const sizeBytes = artifactStateBytes(input.value)
      checkArtifactStateWrite({
        key: input.key,
        valueBytes: sizeBytes,
        others: { keys: Number(others?.keys ?? 0), bytes: Number(others?.bytes ?? 0) },
      })
      await tx`
        INSERT INTO artifact_state (
          project_id, artifact_id, principal_type, principal_id, key, value, size_bytes,
          updated_at
        ) VALUES (
          ${input.projectId}, ${input.artifactId}, ${input.principal.type},
          ${input.principal.id}, ${input.key}, ${input.value}, ${sizeBytes}, ${input.updatedAt}
        )
        ON CONFLICT (project_id, artifact_id, principal_type, principal_id, key) DO UPDATE SET
          value = excluded.value, size_bytes = excluded.size_bytes,
          updated_at = excluded.updated_at
      `
    })
  }

  async deleteState(input: ArtifactStateKeyInput): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM artifact_state
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
        AND key = ${input.key}
      RETURNING key
    `
    return rows.length > 0
  }

  async listState(input: ArtifactStateScope): Promise<ArtifactStateEntry[]> {
    // COLLATE "C": code-unit order, as SQLite and the in-memory store compare keys.
    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(STATE_COLUMNS)} FROM artifact_state
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
      ORDER BY key COLLATE "C"
    `
    return rows.map(parseArtifactStateRow)
  }

  async clearState(input: ArtifactStateScope): Promise<number> {
    const rows = await this.sql`
      DELETE FROM artifact_state
      WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
        AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
      RETURNING key
    `
    return rows.length
  }

  async listBoardPreviews(
    input: ListArtifactBoardPreviewsInput
  ): Promise<ArtifactBoardPreviewRecord[]> {
    if (input.renderKeys.length === 0) return []

    const rows = await this.sql<PgRow[]>`
      SELECT ${this.sql.unsafe(BOARD_PREVIEW_COLUMNS)} FROM artifact_board_previews
      WHERE project_id = ${input.projectId}
        AND render_key = ANY(${this.sql.array([...new Set(input.renderKeys)])}::text[])
      ORDER BY render_key COLLATE "C", theme COLLATE "C", size COLLATE "C"
    `
    return rows.map(parseArtifactBoardPreviewRow)
  }

  async putBoardPreviews(input: PutArtifactBoardPreviewsInput): Promise<void> {
    if (input.previews.length === 0) return

    await runPgTransaction(this.sql, async (tx) => {
      for (const preview of input.previews) {
        await tx`
          INSERT INTO artifact_board_previews (
            project_id, render_key, theme, size, file, created_at
          ) VALUES (
            ${input.projectId}, ${preview.renderKey}, ${preview.theme}, ${preview.size},
            ${JSON.stringify(preview.file)}::text::jsonb, ${preview.createdAt}
          )
          ON CONFLICT (project_id, render_key, theme, size) DO NOTHING
        `
      }
    })
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    // Versions, restore points, turn writes, thread links, frame grants, and state go with the
    // artifact through ON DELETE CASCADE.
    const rows = await this.sql`
      DELETE FROM artifacts WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING id
    `
    return rows.length > 0
  }
}

/** The artifact, locked for the write: writes to one artifact take turns. */
async function lockArtifact(
  sql: SQLClient,
  projectId: string,
  artifactId: string
): Promise<{ readonly artifact: ArtifactRecord; readonly nextVersion: number } | null> {
  const [row] = await sql<PgRow[]>`
    SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}, next_version AS "nextVersion" FROM artifacts
    WHERE project_id = ${projectId} AND id = ${artifactId}
    FOR UPDATE
  `
  return row ? { artifact: parseArtifactRow(row), nextVersion: Number(row.nextVersion) } : null
}

async function latestVersion(
  sql: SQLClient,
  artifact: ArtifactRecord
): Promise<ArtifactVersionRecord> {
  const [row] = await sql<PgRow[]>`
    SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM artifact_versions
    WHERE project_id = ${artifact.projectId} AND artifact_id = ${artifact.id}
      AND version = ${artifact.latestVersion}
  `
  if (!row) throw new Error(`[SixbPg] Artifact '${artifact.id}' has no latest version.`)
  return parseArtifactVersionRow(row)
}

/** Refuses a write made from a revision the artifact has moved past. */
function assertBase(
  artifact: ArtifactRecord,
  latest: ArtifactVersionRecord,
  baseRevision: number | undefined
): void {
  if (baseRevision === undefined || baseRevision === artifact.revision) return

  throw artifactStorageErrors.moved(artifact.id, baseRevision, {
    version: latest.version,
    revision: artifact.revision,
    author: latest.author,
  })
}

/**
 * Writes content to the latest version: in place while it is open, as the next version when it is
 * frozen. The artifact takes the next revision.
 */
async function writeLatest(
  sql: SQLClient,
  { artifact, nextVersion }: { readonly artifact: ArtifactRecord; readonly nextVersion: number },
  latest: ArtifactVersionRecord,
  content: ArtifactVersionInput
): Promise<PublishedArtifactVersion> {
  const { projectId, id: artifactId } = artifact
  const revision = artifact.revision + 1

  if (latest.frozenAt) {
    const version = await insertVersion(sql, {
      projectId,
      artifactId,
      version: nextVersion,
      revision,
      content,
    })
    const [row] = await sql<PgRow[]>`
      UPDATE artifacts
      SET title = ${content.title}, latest_version = ${version.version},
          next_version = ${version.version + 1}, revision = ${revision},
          updated_at = ${content.updatedAt}
      WHERE project_id = ${projectId} AND id = ${artifactId}
      RETURNING ${sql.unsafe(ARTIFACT_COLUMNS)}
    `
    return { artifact: parseArtifactRow(row as PgRow), version }
  }

  const version = await replaceContent(sql, {
    projectId,
    artifactId,
    version: latest.version,
    revision,
    content,
  })
  const [row] = await sql<PgRow[]>`
    UPDATE artifacts
    SET title = ${content.title}, revision = ${revision}, updated_at = ${content.updatedAt}
    WHERE project_id = ${projectId} AND id = ${artifactId}
    RETURNING ${sql.unsafe(ARTIFACT_COLUMNS)}
  `
  return { artifact: parseArtifactRow(row as PgRow), version }
}

/** Replaces an open version's content, at a new revision. */
async function replaceContent(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly artifactId: string
    readonly version: number
    readonly revision: number
    readonly content: ArtifactVersionInput
  }
): Promise<ArtifactVersionRecord> {
  const { content } = input
  const [row] = await sql<PgRow[]>`
    UPDATE artifact_versions
    SET revision = ${input.revision}, title = ${content.title}, entry = ${content.entry},
        files = ${JSON.stringify(content.files)}::text::jsonb,
        outline = ${JSON.stringify(content.outline)}::text::jsonb,
        refs = ${JSON.stringify(content.references)}::text::jsonb,
        author_principal_type = ${content.author.type},
        author_principal_id = ${content.author.id},
        origin_thread_id = ${content.origin?.threadId ?? null},
        origin_run_id = ${content.origin?.runId ?? null}, updated_at = ${content.updatedAt}
    WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
      AND version = ${input.version}
    RETURNING ${sql.unsafe(VERSION_COLUMNS)}
  `
  return parseArtifactVersionRow(row as PgRow)
}

async function insertVersion(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly artifactId: string
    readonly version: number
    readonly revision: number
    readonly content: ArtifactVersionInput
  }
): Promise<ArtifactVersionRecord> {
  const { content } = input
  const [row] = await sql<PgRow[]>`
    INSERT INTO artifact_versions (
      project_id, artifact_id, version, revision, title, entry, files, outline, refs,
      author_principal_type, author_principal_id, origin_thread_id, origin_run_id, created_at,
      updated_at
    ) VALUES (
      ${input.projectId}, ${input.artifactId}, ${input.version}, ${input.revision},
      ${content.title}, ${content.entry},
      ${JSON.stringify(content.files)}::text::jsonb,
      ${JSON.stringify(content.outline)}::text::jsonb,
      ${JSON.stringify(content.references)}::text::jsonb,
      ${content.author.type}, ${content.author.id},
      ${content.origin?.threadId ?? null}, ${content.origin?.runId ?? null},
      ${content.updatedAt}, ${content.updatedAt}
    )
    RETURNING ${sql.unsafe(VERSION_COLUMNS)}
  `
  return parseArtifactVersionRow(row as PgRow)
}

/**
 * Keeps a restore point of the latest version, under the artifact's lock, and forgets the oldest
 * past what an artifact keeps.
 */
async function keepRestorePoint(
  sql: SQLClient,
  latest: ArtifactVersionRecord,
  input: {
    readonly reason: ArtifactRestorePointReason
    readonly turnRunId?: string
    readonly createdAt: Date
  }
): Promise<void> {
  const { projectId, artifactId } = latest
  await sql`
    INSERT INTO artifact_restore_points (
      project_id, artifact_id, revision, version, frozen, title, entry, files, outline, refs,
      author_principal_type, author_principal_id, origin_thread_id, origin_run_id, updated_at,
      reason, turn_run_id, created_at
    )
    SELECT project_id, artifact_id, revision, version, frozen_at IS NOT NULL, title, entry, files,
           outline, refs, author_principal_type, author_principal_id, origin_thread_id,
           origin_run_id, updated_at, ${input.reason}, ${input.turnRunId ?? null},
           ${input.createdAt}
    FROM artifact_versions
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND version = ${latest.version}
  `
  await sql`
    DELETE FROM artifact_restore_points
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND revision NOT IN (
      SELECT revision FROM artifact_restore_points
      WHERE project_id = ${projectId} AND artifact_id = ${artifactId}
      ORDER BY revision DESC LIMIT ${ARTIFACT_RESTORE_POINTS}
    )
  `
}

/** Whether a turn wrote the artifact already. */
async function turnWrote(
  sql: SQLClient,
  artifact: ArtifactRecord,
  turnRunId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM artifact_turn_writes
    WHERE project_id = ${artifact.projectId} AND artifact_id = ${artifact.id}
      AND turn_run_id = ${turnRunId}
  `
  return rows.length > 0
}

/** Remembers the revision a turn's write left, and forgets the oldest turns past those kept. */
async function recordTurnWrite(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly artifactId: string
    readonly turnRunId: string
    readonly created: boolean
    readonly revision: number
  }
): Promise<void> {
  const { projectId, artifactId } = input
  await sql`
    INSERT INTO artifact_turn_writes (project_id, artifact_id, turn_run_id, created, revision)
    VALUES (${projectId}, ${artifactId}, ${input.turnRunId}, ${input.created}, ${input.revision})
    ON CONFLICT (project_id, artifact_id, turn_run_id) DO UPDATE SET revision = excluded.revision
  `
  await sql`
    DELETE FROM artifact_turn_writes
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND turn_run_id NOT IN (
      SELECT turn_run_id FROM artifact_turn_writes
      WHERE project_id = ${projectId} AND artifact_id = ${artifactId}
      ORDER BY revision DESC LIMIT ${ARTIFACT_RESTORE_POINTS}
    )
  `
}

/**
 * Puts a locked artifact back as the turn's restore point holds it, at a new revision: an open
 * version takes its content back, and a version the turn opened past a frozen one goes. `null`
 * when the turn kept no restore point of it, or its version is gone.
 */
async function undoTurn(
  sql: SQLClient,
  projectId: string,
  artifactId: string,
  turnRunId: string
): Promise<PublishedArtifactVersion | null> {
  const [row] = await sql<PgRow[]>`
    SELECT ${sql.unsafe(RESTORE_POINT_COLUMNS)} FROM artifact_restore_points
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId}
      AND turn_run_id = ${turnRunId}
  `
  if (!row) return null
  const point = parseArtifactRestorePointRow(row)

  const [current] = await sql<{ revision: number }[]>`
    SELECT revision FROM artifacts WHERE project_id = ${projectId} AND id = ${artifactId}
  `
  const [kept] = await sql`
    SELECT 1 FROM artifact_versions
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND version = ${point.version}
  `
  if (!current || !kept) return null
  const revision = Number(current.revision) + 1

  await sql`
    DELETE FROM artifact_versions
    WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND version > ${point.version}
  `
  const at = { projectId, artifactId, version: point.version, revision }
  const undone = point.frozen
    ? await freshRevision(sql, at)
    : await replaceContent(sql, {
        ...at,
        content: {
          title: point.title,
          entry: point.entry,
          files: point.files,
          outline: point.outline,
          references: point.references,
          author: point.author,
          ...(point.origin ? { origin: point.origin } : {}),
          updatedAt: point.updatedAt,
        },
      })
  // As it was before the turn: when its content was written, or when it was frozen.
  const updatedAt = new Date(Math.max(undone.updatedAt.getTime(), undone.frozenAt?.getTime() ?? 0))

  const [artifact] = await sql<PgRow[]>`
    UPDATE artifacts
    SET title = ${undone.title}, latest_version = ${undone.version}, revision = ${revision},
        updated_at = ${updatedAt}
    WHERE project_id = ${projectId} AND id = ${artifactId}
    RETURNING ${sql.unsafe(ARTIFACT_COLUMNS)}
  `
  return { artifact: parseArtifactRow(artifact as PgRow), version: undone }
}

/** A frozen version at the artifact's new revision: it is the latest again, as it was. */
async function freshRevision(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly artifactId: string
    readonly version: number
    readonly revision: number
  }
): Promise<ArtifactVersionRecord> {
  const [row] = await sql<PgRow[]>`
    UPDATE artifact_versions SET revision = ${input.revision}
    WHERE project_id = ${input.projectId} AND artifact_id = ${input.artifactId}
      AND version = ${input.version}
    RETURNING ${sql.unsafe(VERSION_COLUMNS)}
  `
  return parseArtifactVersionRow(row as PgRow)
}

/** Shares an artifact in its origin's thread, keeping when, and by which turn, it was first. */
async function shareIn(
  sql: SQLClient,
  projectId: string,
  artifactId: string,
  content: ArtifactVersionInput,
  turnRunId: string | undefined
): Promise<void> {
  if (!content.origin) return

  await sql`
    INSERT INTO artifact_threads (project_id, artifact_id, thread_id, shared_at, linked_by_run_id)
    VALUES (
      ${projectId}, ${artifactId}, ${content.origin.threadId}, ${content.updatedAt},
      ${turnRunId ?? null}
    )
    ON CONFLICT (project_id, artifact_id, thread_id) DO NOTHING
  `
}
