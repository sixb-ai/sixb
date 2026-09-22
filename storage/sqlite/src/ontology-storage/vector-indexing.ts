import type { Database } from "bun:sqlite"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  type MaterializationSession,
  type OntologyVectorIndexingStorage,
  VECTOR_INDEXING_FAILURE_CODES,
  type VectorIndexingRequest,
  type VectorIndexingWork,
} from "@sixb/core/storage"
import type { SqliteRootOperation } from "./shared"

interface WorkRow {
  batch_id: string | null
  request: string
  status: VectorIndexingWork["status"]
  available_at: string
  values_json: string | null
  error: string | null
}
export class SqliteVectorIndexingStorage implements OntologyVectorIndexingStorage {
  constructor(
    private readonly db: Database,
    private readonly run: SqliteRootOperation,
    private readonly assertSession: (session: MaterializationSession, projectId: string) => void
  ) {}
  async schedule(input: Parameters<OntologyVectorIndexingStorage["schedule"]>[0]) {
    this.assertSession(input.session, input.projectId)
    for (const ref of input.deleted)
      this.db
        .query(
          `DELETE FROM object_vector_indexing WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`
        )
        .run(input.projectId, ref.objectTypeId, ref.primaryId)
    const insert =
      this.db.query(`INSERT INTO object_vector_indexing (project_id, id, object_type_id, primary_id, profile, batch_id, request, status, available_at, dispatch_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (project_id, object_type_id, primary_id, profile) DO UPDATE SET id = excluded.id, batch_id = excluded.batch_id, request = excluded.request, status = 'pending', available_at = excluded.available_at, dispatch_at = excluded.dispatch_at, values_json = NULL, error = NULL`)
    for (const { batchId, ...request } of input.requests)
      insert.run(
        input.projectId,
        request.id,
        request.ref.objectTypeId,
        request.ref.primaryId,
        request.profile,
        batchId ?? null,
        JSON.stringify(request),
        input.availableAt,
        input.availableAt
      )
  }
  async complete(input: Parameters<OntologyVectorIndexingStorage["complete"]>[0]) {
    this.assertSession(input.session, input.projectId)
    const remove = this.db.query(
      `DELETE FROM object_vector_indexing WHERE project_id = ? AND object_type_id = ? AND primary_id = ? AND profile = ? AND json_extract(request, '$.configuration') = ? AND json_extract(request, '$.sourceFingerprint') = ?`
    )
    for (const entry of input.entries) {
      remove.run(
        input.projectId,
        entry.ref.objectTypeId,
        entry.ref.primaryId,
        entry.profile,
        entry.configuration,
        entry.sourceFingerprint
      )
    }
  }

  async dispatched(input: Parameters<OntologyVectorIndexingStorage["dispatched"]>[0]) {
    await this.run(() => {
      const update = this.db.query(
        `UPDATE object_vector_indexing SET dispatch_at = ? WHERE project_id = ? AND id = ?`
      )
      for (const id of input.ids) update.run(input.nextDispatchAt, input.projectId, id)
    })
  }
  async get(input: Parameters<OntologyVectorIndexingStorage["get"]>[0]) {
    return this.run(() => {
      const row = this.db
        .query<WorkRow, [string, string]>(
          `SELECT batch_id, request, status, available_at, values_json, error FROM object_vector_indexing WHERE project_id = ? AND id = ?`
        )
        .get(input.projectId, input.id)
      return row ? decode(row) : null
    })
  }
  async getBatch(input: Parameters<OntologyVectorIndexingStorage["getBatch"]>[0]) {
    return this.run(() =>
      this.db
        .query<WorkRow, [string, string]>(`
      SELECT batch_id, request, status, available_at, values_json, error FROM object_vector_indexing
      WHERE project_id = ? AND batch_id = ? ORDER BY id`)
        .all(input.projectId, input.batchId)
        .map(decode)
    )
  }

  async getBatchMember(input: Parameters<OntologyVectorIndexingStorage["getBatchMember"]>[0]) {
    return this.run(() => {
      const row = this.db
        .query<WorkRow, [string, string, string, string, string]>(`
        SELECT batch_id, request, status, available_at, values_json, error
        FROM object_vector_indexing WHERE project_id = ? AND object_type_id = ?
        AND primary_id = ? AND profile = ? AND batch_id = ?`)
        .get(
          input.projectId,
          input.ref.objectTypeId,
          input.ref.primaryId,
          input.profile,
          input.batchId
        )
      return row ? decode(row) : null
    })
  }

  async updateBatch(input: Parameters<OntologyVectorIndexingStorage["updateBatch"]>[0]) {
    return this.run(() =>
      this.db.transaction(() => {
        const status = this.db.query<{ status: string }, [string, string]>(
          "SELECT status FROM object_vector_indexing WHERE project_id = ? AND id = ?"
        )
        if (
          input.requireAll &&
          input.updates.some(
            (update) => status.get(input.projectId, update.id)?.status !== update.expectedStatus
          )
        )
          return false
        const updateRow = this.db.query(`UPDATE object_vector_indexing
        SET status = ?, available_at = ?, values_json = COALESCE(?, values_json), error = ?
        WHERE project_id = ? AND id = ? AND status = ?`)
        for (const update of input.updates)
          updateRow.run(
            update.status,
            update.availableAt,
            update.values ? JSON.stringify(update.values) : null,
            update.error ? JSON.stringify(update.error) : null,
            input.projectId,
            update.id,
            update.expectedStatus
          )
        return true
      })()
    )
  }

  async listDue(input: Parameters<OntologyVectorIndexingStorage["listDue"]>[0]) {
    return this.run(() =>
      this.db
        .query<WorkRow, [string, string, number]>(
          `SELECT batch_id, request, status, available_at, NULL AS values_json, error FROM object_vector_indexing WHERE project_id = ? AND status <> 'failed' AND dispatch_at <= ? ORDER BY dispatch_at, id LIMIT ?`
        )
        .all(input.projectId, input.now, input.limit)
        .map(decode)
    )
  }
  async update(input: Parameters<OntologyVectorIndexingStorage["update"]>[0]) {
    return this.run(
      () =>
        this.db
          .query(
            `UPDATE object_vector_indexing SET status = ?, available_at = ?, values_json = COALESCE(?, values_json), error = ? WHERE project_id = ? AND id = ? AND status = ?`
          )
          .run(
            input.status,
            input.availableAt,
            input.values ? JSON.stringify(input.values) : null,
            input.error ? JSON.stringify(input.error) : null,
            input.projectId,
            input.id,
            input.expectedStatus
          ).changes === 1
    )
  }
  async remove(input: Parameters<OntologyVectorIndexingStorage["remove"]>[0]) {
    await this.run(() => {
      this.db
        .query(`DELETE FROM object_vector_indexing WHERE project_id = ? AND id = ?`)
        .run(input.projectId, input.id)
    })
  }
}
function decode(row: WorkRow): VectorIndexingWork {
  const request = JSON.parse(row.request) as VectorIndexingRequest
  return {
    ...request,
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    status: row.status,
    availableAt: row.available_at,
    ...(row.values_json ? { values: JSON.parse(row.values_json) as number[] } : {}),
    ...(row.error
      ? {
          error: parseSixbFailure(row.error, VECTOR_INDEXING_FAILURE_CODES),
        }
      : {}),
  }
}
