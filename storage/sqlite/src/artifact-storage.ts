import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { FileRef } from "@sixb/core"
import { ARTIFACT_COMMENT_LIMITS } from "@sixb/core/artifacts"
import {
  ARTIFACT_RESTORE_POINTS,
  artifactStateBytes,
  artifactStorageErrors,
  checkArtifactStateWrite,
  parseArtifactBoardPreviewRow,
  parseArtifactCommentRow,
  parseArtifactFrameGrantRow,
  parseArtifactRestorePointRow,
  parseArtifactRow,
  parseArtifactStateRow,
  parseArtifactTurnWriteRow,
  parseArtifactVersionRow,
  turnUndoable,
} from "@sixb/core/internal/storage"
import type {
  ArtifactBoardPreviewRecord,
  ArtifactCommentKey,
  ArtifactCommentRecord,
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
  CreateArtifactCommentInput,
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
  ResolveArtifactCommentInput,
  RestoreArtifactInput,
  SetArtifactStateInput,
  UndoArtifactTurnInput,
  UndoneArtifactTurn,
} from "@sixb/core/storage"
import { runImmediateTransaction, type SqliteStoreConnection } from "./transactions"

const ARTIFACT_COLUMNS = `
  project_id AS projectId, id, kind, title,
  owner_principal_type AS ownerPrincipalType, owner_principal_id AS ownerPrincipalId,
  latest_version AS latestVersion, revision, created_at AS createdAt, updated_at AS updatedAt,
  document, document_revision AS documentRevision
`

/** What a version and a restore point both hold, and who last wrote it from where. */
const CONTENT_COLUMNS = `
  title, entry, files, outline, refs, author_principal_type AS authorPrincipalType,
  author_principal_id AS authorPrincipalId, origin_thread_id AS originThreadId,
  origin_run_id AS originRunId, updated_at AS updatedAt
`

const VERSION_COLUMNS = `
  project_id AS projectId, artifact_id AS artifactId, version, revision, ${CONTENT_COLUMNS},
  created_at AS createdAt, frozen_at AS frozenAt,
  frozen_by_principal_type AS frozenByPrincipalType,
  frozen_by_principal_id AS frozenByPrincipalId
`

const RESTORE_POINT_COLUMNS = `
  project_id AS projectId, artifact_id AS artifactId, revision, version, frozen,
  ${CONTENT_COLUMNS}, reason, turn_run_id AS turnRunId, created_at AS createdAt
`

const TURN_WRITE_COLUMNS = "artifact_id AS artifactId, created, revision, writes"

const FRAME_GRANT_COLUMNS = `
  project_id AS projectId, token_hash AS tokenHash, artifact_id AS artifactId, version,
  files_digest AS filesDigest, targets, created_at AS createdAt, expires_at AS expiresAt
`

const STATE_COLUMNS = "key, value, size_bytes AS sizeBytes, updated_at AS updatedAt"

const COMMENT_COLUMNS = `
  project_id AS projectId, artifact_id AS artifactId, id, parent_id AS parentId, anchor, body,
  author_principal_type AS authorPrincipalType, author_principal_id AS authorPrincipalId,
  created_at AS createdAt, resolved_at AS resolvedAt,
  resolved_by_principal_type AS resolvedByPrincipalType,
  resolved_by_principal_id AS resolvedByPrincipalId,
  origin_thread_id AS originThreadId, origin_run_id AS originRunId
`

const BOARD_PREVIEW_COLUMNS =
  "project_id AS projectId, render_key AS renderKey, theme, size, file, created_at AS createdAt"

/** One reader of one artifact: the bindings that follow `STATE_SCOPE`. */
const STATE_SCOPE = "project_id = ? AND artifact_id = ? AND principal_type = ? AND principal_id = ?"

function stateScope(input: ArtifactStateScope): SQLQueryBindings[] {
  return [input.projectId, input.artifactId, input.principal.type, input.principal.id]
}

type Row = Record<string, unknown>

export class SqliteArtifactStorage implements ArtifactStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    return runImmediateTransaction(this.db, () => {
      const content = input.version
      const createdAt = content.updatedAt.toISOString()
      const artifact = this.db
        .query(
          `INSERT INTO artifacts (
            project_id, id, kind, title, owner_principal_type, owner_principal_id,
            latest_version, next_version, revision, created_at, updated_at, document,
            document_revision
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 2, 1, ?, ?, ?, ?)
          ON CONFLICT (project_id, id) DO NOTHING
          RETURNING ${ARTIFACT_COLUMNS}`
        )
        .get(
          input.projectId,
          input.id,
          input.kind,
          content.title,
          input.owner.type,
          input.owner.id,
          createdAt,
          createdAt,
          documentJson(input.document),
          input.document ? 1 : null
        ) as Row | null
      if (!artifact) throw artifactStorageErrors.exists(input.id)

      const version = this.insertVersion({
        projectId: input.projectId,
        artifactId: input.id,
        version: 1,
        revision: 1,
        content,
      })
      this.shareIn(input.projectId, input.id, content, input.turnRunId)
      if (input.turnRunId) {
        this.recordTurnWrite({
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
    return runImmediateTransaction(this.db, () => {
      const current = this.readArtifact(input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current
      if (artifact.kind !== input.kind) {
        throw artifactStorageErrors.kindMismatch(input.artifactId, artifact.kind, input.kind)
      }

      // Inside the write transaction: a write from the same base after this one finds it moved.
      const latest = this.latestVersion(artifact)
      assertBase(artifact, latest, input.baseRevision)

      // A turn's first write keeps what it replaces, so the turn can be undone.
      const { turnRunId } = input
      if (turnRunId && !this.turnWrote(artifact, turnRunId)) {
        this.keepRestorePoint(latest, {
          reason: "turn",
          turnRunId,
          createdAt: input.version.updatedAt,
        })
      }

      const written = this.writeLatest(current, latest, input.version, input.document)
      this.shareIn(input.projectId, input.artifactId, input.version, turnRunId)
      if (turnRunId) {
        this.recordTurnWrite({
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
    return runImmediateTransaction(this.db, () => {
      const current = this.readArtifact(input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current

      const latest = this.latestVersion(artifact)
      if (latest.frozenAt) return { artifact, version: latest }
      assertBase(artifact, latest, input.baseRevision)

      const revision = artifact.revision + 1
      const frozenAt = input.frozenAt.toISOString()
      const version = this.db
        .query(
          `UPDATE artifact_versions
           SET revision = ?, frozen_at = ?, frozen_by_principal_type = ?, frozen_by_principal_id = ?
           WHERE project_id = ? AND artifact_id = ? AND version = ?
           RETURNING ${VERSION_COLUMNS}`
        )
        .get(
          revision,
          frozenAt,
          input.frozenBy.type,
          input.frozenBy.id,
          input.projectId,
          input.artifactId,
          latest.version
        ) as Row
      const updated = this.db
        .query(
          // A freeze keeps the content, so a document that held it still does.
          `UPDATE artifacts
           SET revision = ?, updated_at = ?,
               document_revision = CASE WHEN document_revision = ? THEN ? ELSE document_revision END
           WHERE project_id = ? AND id = ?
           RETURNING ${ARTIFACT_COLUMNS}`
        )
        .get(
          revision,
          frozenAt,
          artifact.revision,
          revision,
          input.projectId,
          input.artifactId
        ) as Row
      return { artifact: parseArtifactRow(updated), version: parseArtifactVersionRow(version) }
    })
  }

  async listRestorePoints(input: GetArtifactInput): Promise<ArtifactRestorePointRecord[]> {
    const rows = this.db
      .query(
        `SELECT ${RESTORE_POINT_COLUMNS} FROM artifact_restore_points
         WHERE project_id = ? AND artifact_id = ? ORDER BY revision DESC`
      )
      .all(input.projectId, input.id) as Row[]
    return rows.map(parseArtifactRestorePointRow)
  }

  async getRestorePoint(
    input: GetArtifactRestorePointInput
  ): Promise<ArtifactRestorePointRecord | null> {
    return this.readRestorePoint(input.projectId, input.artifactId, input.revision)
  }

  async restoreTo(input: RestoreArtifactInput): Promise<PublishedArtifactVersion> {
    return runImmediateTransaction(this.db, () => {
      const current = this.readArtifact(input.projectId, input.artifactId)
      if (!current) throw artifactStorageErrors.notFound(input.artifactId)
      const { artifact } = current

      const point = this.readRestorePoint(input.projectId, input.artifactId, input.revision)
      if (!point) throw artifactStorageErrors.restorePointNotFound(input.artifactId, input.revision)

      const latest = this.latestVersion(artifact)
      assertBase(artifact, latest, input.baseRevision)

      // What the restore replaces is kept first, so the restore can be undone.
      this.keepRestorePoint(latest, { reason: "restore", createdAt: input.restoredAt })
      return this.writeLatest(
        current,
        latest,
        {
          title: point.title,
          entry: point.entry,
          files: point.files,
          outline: point.outline,
          references: point.references,
          author: input.author,
          updatedAt: input.restoredAt,
        },
        input.document
      )
    })
  }

  async listTurnWrites(input: ArtifactTurnInput): Promise<ArtifactTurnWriteRecord[]> {
    const rows = this.db
      .query(
        `SELECT ${TURN_WRITE_COLUMNS} FROM artifact_turn_writes
         WHERE project_id = ? AND turn_run_id = ? ORDER BY artifact_id`
      )
      .all(input.projectId, input.turnRunId) as Row[]
    return rows.map(parseArtifactTurnWriteRow)
  }

  async undoTurnWrites(input: UndoArtifactTurnInput): Promise<UndoneArtifactTurn> {
    return runImmediateTransaction(this.db, () => {
      const { projectId, turnRunId } = input

      // Each write beside the artifact's revision now: the write transaction holds every change.
      const rows = this.db
        .query(
          `SELECT w.artifact_id AS artifactId, w.created, w.revision, w.writes,
             a.revision AS currentRevision
           FROM artifact_turn_writes w
           JOIN artifacts a ON a.project_id = w.project_id AND a.id = w.artifact_id
           WHERE w.project_id = ? AND w.turn_run_id = ?
           ORDER BY w.artifact_id`
        )
        .all(projectId, turnRunId) as Row[]

      const restored: PublishedArtifactVersion[] = []
      const deleted: string[] = []
      for (const row of rows) {
        const write = parseArtifactTurnWriteRow(row)
        const revision = Number(row.currentRevision)

        if (write.created) {
          if (!turnUndoable({ write, revision })) continue

          this.db
            .query("DELETE FROM artifacts WHERE project_id = ? AND id = ?")
            .run(projectId, write.artifactId)
          deleted.push(write.artifactId)
          continue
        }

        const undone = this.undoTurn(
          projectId,
          write,
          turnRunId,
          input.documents?.[write.artifactId]
        )
        if (!undone) continue

        restored.push(undone)
        // Undone, it holds the turn's restore point again, and leaves the threads only the turn
        // shared it in; one kept stays where it was made.
        this.db
          .query(
            `DELETE FROM artifact_restore_points
             WHERE project_id = ? AND artifact_id = ? AND turn_run_id = ?`
          )
          .run(projectId, write.artifactId, turnRunId)
        this.db
          .query(
            `DELETE FROM artifact_threads
             WHERE project_id = ? AND artifact_id = ? AND linked_by_run_id = ? AND copied = 0`
          )
          .run(projectId, write.artifactId, turnRunId)
      }

      this.db
        .query("DELETE FROM artifact_turn_writes WHERE project_id = ? AND turn_run_id = ?")
        .run(projectId, turnRunId)

      return { restored, deleted }
    })
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const row = this.db
      .query(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ? AND id = ?`)
      .get(input.projectId, input.id) as Row | null
    return row ? parseArtifactRow(row) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const where = ["a.project_id = ?"]
    const params: SQLQueryBindings[] = [input.projectId]
    if (input.owner) {
      where.push("a.owner_principal_type = ? AND a.owner_principal_id = ?")
      params.push(input.owner.type, input.owner.id)
    }
    if (input.threadId !== undefined) {
      where.push(
        `EXISTS (
          SELECT 1 FROM artifact_threads t
          WHERE t.project_id = a.project_id AND t.artifact_id = a.id AND t.thread_id = ?
        )`
      )
      params.push(input.threadId)
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
      .all(...params, input.limit ?? -1, offset) as Row[]
    return {
      artifacts: rows.map(parseArtifactRow),
      hasMore: offset + rows.length < total,
      total,
    }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const row = this.db
      .query(
        `SELECT ${VERSION_COLUMNS} FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(input.projectId, input.artifactId, input.version) as Row | null
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
      .all(input.projectId, input.artifactId, input.limit ?? -1, offset) as Row[]
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
      .all(input.projectId, prefix.length, prefix, prefix.length) as Row[]
    return rows.map(parseArtifactVersionRow)
  }

  async listThreadIds(input: GetArtifactInput): Promise<string[]> {
    const rows = this.db
      .query(
        `SELECT thread_id AS threadId FROM artifact_threads
         WHERE project_id = ? AND artifact_id = ? ORDER BY thread_id`
      )
      .all(input.projectId, input.id) as { readonly threadId: string }[]
    return rows.map((row) => row.threadId)
  }

  async copy(input: CopyArtifactInput): Promise<ArtifactRecord> {
    return runImmediateTransaction(this.db, () => {
      const source = this.db
        .query("SELECT id FROM artifacts WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.sourceId)
      if (!source) throw artifactStorageErrors.notFound(input.sourceId)

      const artifact = this.db
        .query(
          `INSERT INTO artifacts (
            project_id, id, kind, title, owner_principal_type, owner_principal_id,
            latest_version, next_version, revision, created_at, updated_at, document,
            document_revision
          )
          SELECT project_id, ?, kind, title, ?, ?, latest_version, next_version, revision,
                 created_at, updated_at, document, document_revision
          FROM artifacts WHERE project_id = ? AND id = ?
          ON CONFLICT (project_id, id) DO NOTHING
          RETURNING ${ARTIFACT_COLUMNS}`
        )
        .get(
          input.id,
          input.owner.type,
          input.owner.id,
          input.projectId,
          input.sourceId
        ) as Row | null
      if (!artifact) throw artifactStorageErrors.exists(input.id)

      this.db
        .query(
          `INSERT INTO artifact_versions (
            project_id, artifact_id, version, revision, title, entry, files, outline, refs,
            author_principal_type, author_principal_id, created_at, updated_at, frozen_at,
            frozen_by_principal_type, frozen_by_principal_id
          )
          SELECT project_id, ?, version, revision, title, entry, files, outline, refs,
                 author_principal_type, author_principal_id, created_at, updated_at, frozen_at,
                 frozen_by_principal_type, frozen_by_principal_id
          FROM artifact_versions WHERE project_id = ? AND artifact_id = ?`
        )
        .run(input.id, input.projectId, input.sourceId)

      if (input.outlineOf) {
        const copied = this.db
          .query(
            `SELECT ${VERSION_COLUMNS} FROM artifact_versions WHERE project_id = ? AND artifact_id = ?`
          )
          .all(input.projectId, input.id) as Row[]
        for (const version of copied.map(parseArtifactVersionRow)) {
          const outline = input.outlineOf(version)
          if (!outline) continue

          this.db
            .query(
              "UPDATE artifact_versions SET outline = ? WHERE project_id = ? AND artifact_id = ? AND version = ?"
            )
            .run(JSON.stringify(outline), input.projectId, input.id, version.version)
        }
      }
      this.db
        .query(
          `INSERT INTO artifact_threads (project_id, artifact_id, thread_id, shared_at, copied)
           VALUES (?, ?, ?, ?, 1)`
        )
        .run(
          input.projectId,
          input.id,
          input.threadId,
          (input.copiedAt ?? new Date()).toISOString()
        )
      return parseArtifactRow(artifact)
    })
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
             (project_id, token_hash, artifact_id, version, files_digest, targets, created_at,
              expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.projectId,
          record.tokenHash,
          record.artifactId,
          record.version,
          record.filesDigest,
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
        `SELECT ${FRAME_GRANT_COLUMNS} FROM artifact_frame_grants
         WHERE project_id = ? AND token_hash = ?`
      )
      .get(input.projectId, input.tokenHash) as Row | null
    return row ? parseArtifactFrameGrantRow(row) : null
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

  async getState(input: ArtifactStateKeyInput): Promise<ArtifactStateEntry | null> {
    const row = this.db
      .query(`SELECT ${STATE_COLUMNS} FROM artifact_state WHERE ${STATE_SCOPE} AND key = ?`)
      .get(...stateScope(input), input.key) as Row | null
    return row ? parseArtifactStateRow(row) : null
  }

  async setState(input: SetArtifactStateInput): Promise<void> {
    runImmediateTransaction(this.db, () => {
      const artifact = this.db
        .query("SELECT 1 FROM artifacts WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.artifactId)
      if (!artifact) throw artifactStorageErrors.notFound(input.artifactId)
      // In the write transaction: two writes at once cannot both fit under the limits.
      const others = this.db
        .query(
          `SELECT count(*) AS keys, coalesce(sum(size_bytes), 0) AS bytes FROM artifact_state
           WHERE ${STATE_SCOPE} AND key <> ?`
        )
        .get(...stateScope(input), input.key) as { readonly keys: number; readonly bytes: number }
      const sizeBytes = artifactStateBytes(input.value)
      checkArtifactStateWrite({ key: input.key, valueBytes: sizeBytes, others })
      this.db
        .query(
          `INSERT INTO artifact_state (
            project_id, artifact_id, principal_type, principal_id, key, value, size_bytes,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, artifact_id, principal_type, principal_id, key) DO UPDATE SET
            value = excluded.value, size_bytes = excluded.size_bytes,
            updated_at = excluded.updated_at`
        )
        .run(...stateScope(input), input.key, input.value, sizeBytes, input.updatedAt.toISOString())
    })
  }

  async deleteState(input: ArtifactStateKeyInput): Promise<boolean> {
    return (
      this.db
        .query(`DELETE FROM artifact_state WHERE ${STATE_SCOPE} AND key = ?`)
        .run(...stateScope(input), input.key).changes > 0
    )
  }

  async listState(input: ArtifactStateScope): Promise<ArtifactStateEntry[]> {
    const rows = this.db
      .query(`SELECT ${STATE_COLUMNS} FROM artifact_state WHERE ${STATE_SCOPE} ORDER BY key`)
      .all(...stateScope(input)) as Row[]
    return rows.map(parseArtifactStateRow)
  }

  async clearState(input: ArtifactStateScope): Promise<number> {
    return this.db
      .query(`DELETE FROM artifact_state WHERE ${STATE_SCOPE}`)
      .run(...stateScope(input)).changes
  }

  async listBoardPreviews(
    input: ListArtifactBoardPreviewsInput
  ): Promise<ArtifactBoardPreviewRecord[]> {
    const rows = this.db
      .query(
        `SELECT ${BOARD_PREVIEW_COLUMNS} FROM artifact_board_previews
         WHERE project_id = ? AND render_key IN (SELECT value FROM json_each(?))
         ORDER BY render_key, theme, size`
      )
      .all(input.projectId, JSON.stringify(input.renderKeys)) as Row[]
    return rows.map(parseArtifactBoardPreviewRow)
  }

  async putBoardPreviews(input: PutArtifactBoardPreviewsInput): Promise<void> {
    runImmediateTransaction(this.db, () => {
      const insert = this.db.query(
        `INSERT INTO artifact_board_previews (project_id, render_key, theme, size, file, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, render_key, theme, size) DO NOTHING`
      )
      for (const preview of input.previews) {
        insert.run(
          input.projectId,
          preview.renderKey,
          preview.theme,
          preview.size,
          JSON.stringify(preview.file),
          preview.createdAt.toISOString()
        )
      }
    })
  }

  async createComment(input: CreateArtifactCommentInput): Promise<ArtifactCommentRecord> {
    return runImmediateTransaction(this.db, () => {
      const artifact = this.db
        .query("SELECT 1 FROM artifacts WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.artifactId)
      if (!artifact) throw artifactStorageErrors.notFound(input.artifactId)

      if (input.parentId !== undefined) {
        const parent = this.db
          .query(
            `SELECT 1 FROM artifact_comments
             WHERE project_id = ? AND artifact_id = ? AND id = ? AND parent_id IS NULL`
          )
          .get(input.projectId, input.artifactId, input.parentId)
        if (!parent) throw artifactStorageErrors.commentNotFound(input.artifactId, input.parentId)
      }
      // In the write transaction: two comments at once cannot both pass the limit.
      const counted = this.db
        .query(
          "SELECT count(*) AS total FROM artifact_comments WHERE project_id = ? AND artifact_id = ?"
        )
        .get(input.projectId, input.artifactId) as { readonly total: number }
      if (counted.total >= ARTIFACT_COMMENT_LIMITS.maxComments) {
        throw artifactStorageErrors.commentsFull(input.artifactId)
      }

      const anchor = {
        ...(input.anchor.board === undefined ? {} : { board: input.anchor.board }),
        ...(input.anchor.element === undefined ? {} : { element: input.anchor.element }),
        ...(input.anchor.label === undefined ? {} : { label: input.anchor.label }),
        ...(input.anchor.point === undefined
          ? {}
          : { point: { x: input.anchor.point.x, y: input.anchor.point.y } }),
        revision: input.anchor.revision,
      }
      const row = this.db
        .query(
          `INSERT INTO artifact_comments (
            project_id, artifact_id, id, parent_id, anchor, body, author_principal_type,
            author_principal_id, created_at, origin_thread_id, origin_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING ${COMMENT_COLUMNS}`
        )
        .get(
          input.projectId,
          input.artifactId,
          input.id,
          input.parentId ?? null,
          JSON.stringify(anchor),
          input.body,
          input.author.type,
          input.author.id,
          input.createdAt.toISOString(),
          input.origin?.threadId ?? null,
          input.origin?.runId ?? null
        ) as Row
      return parseArtifactCommentRow(row)
    })
  }

  async getComment(input: ArtifactCommentKey): Promise<ArtifactCommentRecord | null> {
    const row = this.db
      .query(
        `SELECT ${COMMENT_COLUMNS} FROM artifact_comments
         WHERE project_id = ? AND artifact_id = ? AND id = ?`
      )
      .get(input.projectId, input.artifactId, input.id) as Row | null
    return row ? parseArtifactCommentRow(row) : null
  }

  async listComments(input: GetArtifactInput): Promise<ArtifactCommentRecord[]> {
    const rows = this.db
      .query(
        `SELECT ${COMMENT_COLUMNS} FROM artifact_comments
         WHERE project_id = ? AND artifact_id = ? ORDER BY created_at, rowid`
      )
      .all(input.projectId, input.id) as Row[]
    return rows.map(parseArtifactCommentRow)
  }

  async resolveComment(input: ResolveArtifactCommentInput): Promise<ArtifactCommentRecord | null> {
    const row = this.db
      .query(
        `UPDATE artifact_comments
         SET resolved_at = ?, resolved_by_principal_type = ?, resolved_by_principal_id = ?
         WHERE project_id = ? AND artifact_id = ? AND id = ?
         RETURNING ${COMMENT_COLUMNS}`
      )
      .get(
        input.resolved?.at.toISOString() ?? null,
        input.resolved?.by.type ?? null,
        input.resolved?.by.id ?? null,
        input.projectId,
        input.artifactId,
        input.id
      ) as Row | null
    return row ? parseArtifactCommentRow(row) : null
  }

  async deleteComment(input: ArtifactCommentKey): Promise<boolean> {
    // Its replies go with it, through ON DELETE CASCADE.
    return (
      this.db
        .query("DELETE FROM artifact_comments WHERE project_id = ? AND artifact_id = ? AND id = ?")
        .run(input.projectId, input.artifactId, input.id).changes > 0
    )
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    // Versions, restore points, turn writes, thread links, frame grants, and state go with the
    // artifact through ON DELETE CASCADE.
    return (
      this.db
        .query("DELETE FROM artifacts WHERE project_id = ? AND id = ?")
        .run(input.projectId, input.id).changes > 0
    )
  }

  /** The artifact, and the number its next version takes. */
  private readArtifact(
    projectId: string,
    artifactId: string
  ): { readonly artifact: ArtifactRecord; readonly nextVersion: number } | null {
    const row = this.db
      .query(
        `SELECT ${ARTIFACT_COLUMNS}, next_version AS nextVersion FROM artifacts
         WHERE project_id = ? AND id = ?`
      )
      .get(projectId, artifactId) as Row | null
    return row ? { artifact: parseArtifactRow(row), nextVersion: Number(row.nextVersion) } : null
  }

  private latestVersion(artifact: ArtifactRecord): ArtifactVersionRecord {
    const row = this.db
      .query(
        `SELECT ${VERSION_COLUMNS} FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(artifact.projectId, artifact.id, artifact.latestVersion) as Row | null
    if (!row)
      throw new Error(`[SixbSqliteStorage] Artifact '${artifact.id}' has no latest version.`)
    return parseArtifactVersionRow(row)
  }

  private readRestorePoint(
    projectId: string,
    artifactId: string,
    revision: number
  ): ArtifactRestorePointRecord | null {
    const row = this.db
      .query(
        `SELECT ${RESTORE_POINT_COLUMNS} FROM artifact_restore_points
         WHERE project_id = ? AND artifact_id = ? AND revision = ?`
      )
      .get(projectId, artifactId, revision) as Row | null
    return row ? parseArtifactRestorePointRow(row) : null
  }

  /**
   * Writes content to the latest version: in place while it is open, as the next version when it
   * is frozen. The artifact takes the next revision.
   */
  private writeLatest(
    { artifact, nextVersion }: { readonly artifact: ArtifactRecord; readonly nextVersion: number },
    latest: ArtifactVersionRecord,
    content: ArtifactVersionInput,
    document: FileRef | undefined
  ): PublishedArtifactVersion {
    const { projectId, id: artifactId } = artifact
    const revision = artifact.revision + 1
    const updatedAt = content.updatedAt.toISOString()
    const state = documentJson(document)

    if (latest.frozenAt) {
      const version = this.insertVersion({
        projectId,
        artifactId,
        version: nextVersion,
        revision,
        content,
      })
      const row = this.db
        .query(
          `UPDATE artifacts
           SET title = ?, latest_version = ?, next_version = ?, revision = ?, updated_at = ?,
               ${DOCUMENT_WRITTEN}
           WHERE project_id = ? AND id = ?
           RETURNING ${ARTIFACT_COLUMNS}`
        )
        .get(
          content.title,
          version.version,
          version.version + 1,
          revision,
          updatedAt,
          ...documentWritten(state, revision),
          projectId,
          artifactId
        ) as Row
      return { artifact: parseArtifactRow(row), version }
    }

    const version = this.replaceContent({
      projectId,
      artifactId,
      version: latest.version,
      revision,
      content,
    })
    const row = this.db
      .query(
        `UPDATE artifacts SET title = ?, revision = ?, updated_at = ?, ${DOCUMENT_WRITTEN}
         WHERE project_id = ? AND id = ?
         RETURNING ${ARTIFACT_COLUMNS}`
      )
      .get(
        content.title,
        revision,
        updatedAt,
        ...documentWritten(state, revision),
        projectId,
        artifactId
      ) as Row
    return { artifact: parseArtifactRow(row), version }
  }

  /** Replaces an open version's content, at a new revision. */
  private replaceContent(input: {
    readonly projectId: string
    readonly artifactId: string
    readonly version: number
    readonly revision: number
    readonly content: ArtifactVersionInput
  }): ArtifactVersionRecord {
    const { content } = input
    const row = this.db
      .query(
        `UPDATE artifact_versions
         SET revision = ?, title = ?, entry = ?, files = ?, outline = ?, refs = ?,
             author_principal_type = ?, author_principal_id = ?, origin_thread_id = ?,
             origin_run_id = ?, updated_at = ?
         WHERE project_id = ? AND artifact_id = ? AND version = ?
         RETURNING ${VERSION_COLUMNS}`
      )
      .get(
        input.revision,
        content.title,
        content.entry,
        JSON.stringify(content.files),
        JSON.stringify(content.outline),
        JSON.stringify(content.references),
        content.author.type,
        content.author.id,
        content.origin?.threadId ?? null,
        content.origin?.runId ?? null,
        content.updatedAt.toISOString(),
        input.projectId,
        input.artifactId,
        input.version
      ) as Row
    return parseArtifactVersionRow(row)
  }

  private insertVersion(input: {
    readonly projectId: string
    readonly artifactId: string
    readonly version: number
    readonly revision: number
    readonly content: ArtifactVersionInput
  }): ArtifactVersionRecord {
    const { content } = input
    const writtenAt = content.updatedAt.toISOString()
    const row = this.db
      .query(
        `INSERT INTO artifact_versions (
          project_id, artifact_id, version, revision, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING ${VERSION_COLUMNS}`
      )
      .get(
        input.projectId,
        input.artifactId,
        input.version,
        input.revision,
        content.title,
        content.entry,
        JSON.stringify(content.files),
        JSON.stringify(content.outline),
        JSON.stringify(content.references),
        content.author.type,
        content.author.id,
        content.origin?.threadId ?? null,
        content.origin?.runId ?? null,
        writtenAt,
        writtenAt
      ) as Row
    return parseArtifactVersionRow(row)
  }

  /** Keeps a restore point of the latest version, and forgets the oldest past those kept. */
  private keepRestorePoint(
    latest: ArtifactVersionRecord,
    input: {
      readonly reason: ArtifactRestorePointReason
      readonly turnRunId?: string
      readonly createdAt: Date
    }
  ): void {
    const { projectId, artifactId } = latest
    this.db
      .query(
        `INSERT INTO artifact_restore_points (
          project_id, artifact_id, revision, version, frozen, title, entry, files, outline, refs,
          author_principal_type, author_principal_id, origin_thread_id, origin_run_id,
          updated_at, reason, turn_run_id, created_at
        )
        SELECT project_id, artifact_id, revision, version, frozen_at IS NOT NULL, title, entry,
               files, outline, refs, author_principal_type, author_principal_id,
               origin_thread_id, origin_run_id, updated_at, ?, ?, ?
        FROM artifact_versions WHERE project_id = ? AND artifact_id = ? AND version = ?`
      )
      .run(
        input.reason,
        input.turnRunId ?? null,
        input.createdAt.toISOString(),
        projectId,
        artifactId,
        latest.version
      )
    this.db
      .query(
        `DELETE FROM artifact_restore_points
         WHERE project_id = ? AND artifact_id = ? AND revision NOT IN (
           SELECT revision FROM artifact_restore_points
           WHERE project_id = ? AND artifact_id = ? ORDER BY revision DESC LIMIT ?
         )`
      )
      .run(projectId, artifactId, projectId, artifactId, ARTIFACT_RESTORE_POINTS)
  }

  /** Whether a turn wrote the artifact already. */
  private turnWrote(artifact: ArtifactRecord, turnRunId: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM artifact_turn_writes
           WHERE project_id = ? AND artifact_id = ? AND turn_run_id = ?`
        )
        .get(artifact.projectId, artifact.id, turnRunId) !== null
    )
  }

  /**
   * Remembers the revision a turn's write left and counts the write, and forgets the oldest turns
   * past those kept.
   */
  private recordTurnWrite(input: {
    readonly projectId: string
    readonly artifactId: string
    readonly turnRunId: string
    readonly created: boolean
    readonly revision: number
  }): void {
    const { projectId, artifactId } = input
    this.db
      .query(
        `INSERT INTO artifact_turn_writes
           (project_id, artifact_id, turn_run_id, created, revision, writes)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (project_id, artifact_id, turn_run_id) DO UPDATE SET
           revision = excluded.revision, writes = artifact_turn_writes.writes + 1`
      )
      .run(projectId, artifactId, input.turnRunId, input.created ? 1 : 0, input.revision)
    this.db
      .query(
        `DELETE FROM artifact_turn_writes
         WHERE project_id = ? AND artifact_id = ? AND turn_run_id NOT IN (
           SELECT turn_run_id FROM artifact_turn_writes
           WHERE project_id = ? AND artifact_id = ? ORDER BY revision DESC LIMIT ?
         )`
      )
      .run(projectId, artifactId, projectId, artifactId, ARTIFACT_RESTORE_POINTS)
  }

  /**
   * Puts an artifact back as the turn's restore point holds it, at a new revision: an open version
   * takes its content back, and a version the turn opened past a frozen one goes. `null` when
   * anyone else changed it since the point, as `turnUndoable` says, or its version is gone.
   */
  private undoTurn(
    projectId: string,
    write: ArtifactTurnWriteRecord,
    turnRunId: string,
    document: FileRef | undefined
  ): PublishedArtifactVersion | null {
    const { artifactId } = write
    const row = this.db
      .query(
        `SELECT ${RESTORE_POINT_COLUMNS} FROM artifact_restore_points
         WHERE project_id = ? AND artifact_id = ? AND turn_run_id = ?`
      )
      .get(projectId, artifactId, turnRunId) as Row | null
    if (!row) return null
    const point = parseArtifactRestorePointRow(row)

    const current = this.readArtifact(projectId, artifactId)
    const target = this.db
      .query(
        `SELECT frozen_at AS frozenAt FROM artifact_versions
         WHERE project_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(projectId, artifactId, point.version) as Row | null
    if (!current || !target) return null

    const untouched = turnUndoable({
      write,
      revision: current.artifact.revision,
      point,
      target: { frozen: target.frozenAt !== null },
    })
    if (!untouched) return null
    const revision = current.artifact.revision + 1

    this.db
      .query(
        "DELETE FROM artifact_versions WHERE project_id = ? AND artifact_id = ? AND version > ?"
      )
      .run(projectId, artifactId, point.version)
    const at = { projectId, artifactId, version: point.version, revision }
    const undone = point.frozen
      ? parseArtifactVersionRow(
          this.db
            .query(
              `UPDATE artifact_versions SET revision = ?
               WHERE project_id = ? AND artifact_id = ? AND version = ?
               RETURNING ${VERSION_COLUMNS}`
            )
            .get(revision, projectId, artifactId, point.version) as Row
        )
      : this.replaceContent({
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
    const updatedAt = new Date(
      Math.max(undone.updatedAt.getTime(), undone.frozenAt?.getTime() ?? 0)
    )

    const artifact = this.db
      .query(
        `UPDATE artifacts
         SET title = ?, latest_version = ?, revision = ?, updated_at = ?, ${DOCUMENT_WRITTEN}
         WHERE project_id = ? AND id = ?
         RETURNING ${ARTIFACT_COLUMNS}`
      )
      .get(
        undone.title,
        undone.version,
        revision,
        updatedAt.toISOString(),
        ...documentWritten(documentJson(document), revision),
        projectId,
        artifactId
      ) as Row
    return { artifact: parseArtifactRow(artifact), version: undone }
  }

  /** Shares an artifact in its origin's thread, keeping when, and by which turn, it was first. */
  private shareIn(
    projectId: string,
    artifactId: string,
    content: ArtifactVersionInput,
    turnRunId: string | undefined
  ): void {
    if (!content.origin) return

    this.db
      .query(
        `INSERT INTO artifact_threads (project_id, artifact_id, thread_id, shared_at, linked_by_run_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, artifact_id, thread_id) DO NOTHING`
      )
      .run(
        projectId,
        artifactId,
        content.origin.threadId,
        content.updatedAt.toISOString(),
        turnRunId ?? null
      )
  }
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
    ...(latest.frozenBy ? { frozenBy: latest.frozenBy } : {}),
  })
}

/**
 * The document a content write stores, at the revision it writes; without one, the stored one
 * stays, at the revision it holds, for the next reader to bring up to the content.
 */
const DOCUMENT_WRITTEN = `document = COALESCE(?, document),
  document_revision = CASE WHEN ? IS NULL THEN document_revision ELSE ? END`

function documentWritten(
  state: string | null,
  revision: number
): [string | null, string | null, number] {
  return [state, state, revision]
}

/** A Yjs document's reference as its column holds it: null leaves the stored one. */
function documentJson(document: FileRef | undefined): string | null {
  return document ? JSON.stringify(document) : null
}
