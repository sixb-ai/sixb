import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  type MaterializationSession,
  type OntologyVectorIndexingStorage,
  VECTOR_INDEXING_FAILURE_CODES,
  type VectorIndexingRequest,
  type VectorIndexingWork,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { jsonParameter as json, type PgRootOperation } from "./shared"

interface WorkRow {
  batch_id: string | null
  request: VectorIndexingRequest
  status: VectorIndexingWork["status"]
  available_at: Date | string
  values_json: number[] | null
  error: string | null
}

export class PgVectorIndexingStorage implements OntologyVectorIndexingStorage {
  constructor(
    private readonly sql: SQLClient,
    private readonly run: PgRootOperation,
    private readonly assertSession: (session: MaterializationSession, projectId: string) => void
  ) {}

  async schedule(input: Parameters<OntologyVectorIndexingStorage["schedule"]>[0]) {
    this.assertSession(input.session, input.projectId)
    if (input.deleted.length)
      await this.sql`
      DELETE FROM object_vector_indexing AS work
      USING jsonb_array_elements(${json(this.sql, input.deleted)}::jsonb) AS deleted(ref)
      WHERE work.project_id = ${input.projectId}
        AND work.object_type_id = deleted.ref->>'objectTypeId'
        AND work.primary_id = deleted.ref->>'primaryId'
    `
    if (input.requests.length)
      await this.sql`
      INSERT INTO object_vector_indexing (
        project_id, id, object_type_id, primary_id, profile, batch_id, request, status, available_at, dispatch_at
      )
      SELECT ${input.projectId}, entry->>'id', entry#>>'{ref,objectTypeId}',
        entry#>>'{ref,primaryId}', entry->>'profile', entry->>'batchId', entry - 'batchId', 'pending',
        ${input.availableAt}::timestamptz, ${input.availableAt}::timestamptz
      FROM jsonb_array_elements(${json(this.sql, input.requests)}::jsonb) AS pending(entry)
      ON CONFLICT (project_id, object_type_id, primary_id, profile) DO UPDATE SET
        id = EXCLUDED.id, batch_id = EXCLUDED.batch_id, request = EXCLUDED.request, status = 'pending',
        available_at = EXCLUDED.available_at, dispatch_at = EXCLUDED.dispatch_at,
        values_json = NULL, error = NULL
    `
  }
  async complete(input: Parameters<OntologyVectorIndexingStorage["complete"]>[0]) {
    this.assertSession(input.session, input.projectId)
    if (!input.entries.length) return
    await this.sql`
      DELETE FROM object_vector_indexing AS work
      USING jsonb_array_elements(${json(this.sql, input.entries)}::jsonb) AS completed(entry)
      WHERE work.project_id = ${input.projectId}
        AND work.object_type_id = entry#>>'{ref,objectTypeId}'
        AND work.primary_id = entry#>>'{ref,primaryId}'
        AND work.profile = entry->>'profile'
        AND work.request->>'configuration' = entry->>'configuration'
        AND work.request->>'sourceFingerprint' = entry->>'sourceFingerprint'
    `
  }

  async dispatched(input: Parameters<OntologyVectorIndexingStorage["dispatched"]>[0]) {
    if (!input.ids.length) return
    await this.run(async (sql) => {
      await sql`UPDATE object_vector_indexing SET dispatch_at = ${input.nextDispatchAt} WHERE project_id = ${input.projectId} AND id = ANY(${sql.array([...input.ids])}::text[])`
    })
  }
  async get(input: Parameters<OntologyVectorIndexingStorage["get"]>[0]) {
    return this.run(async (sql) => {
      const rows = await sql<
        WorkRow[]
      >`SELECT batch_id, request, status, available_at, values_json, error FROM object_vector_indexing WHERE project_id = ${input.projectId} AND id = ${input.id}`
      return rows[0] ? decode(rows[0]) : null
    })
  }
  async getBatch(input: Parameters<OntologyVectorIndexingStorage["getBatch"]>[0]) {
    return this.run(async (sql) =>
      (
        await sql<WorkRow[]>`
      SELECT batch_id, request, status, available_at, values_json, error
      FROM object_vector_indexing WHERE project_id = ${input.projectId}
      AND batch_id = ${input.batchId} ORDER BY id`
      ).map(decode)
    )
  }

  async getBatchMember(input: Parameters<OntologyVectorIndexingStorage["getBatchMember"]>[0]) {
    return this.run(async (sql) => {
      const rows = await sql<WorkRow[]>`
        SELECT batch_id, request, status, available_at, values_json, error
        FROM object_vector_indexing WHERE project_id = ${input.projectId}
        AND object_type_id = ${input.ref.objectTypeId} AND primary_id = ${input.ref.primaryId}
        AND profile = ${input.profile} AND batch_id = ${input.batchId}`
      return rows[0] ? decode(rows[0]) : null
    })
  }

  async updateBatch(input: Parameters<OntologyVectorIndexingStorage["updateBatch"]>[0]) {
    if (!input.updates.length) return true
    return this.run(async (sql) => {
      const rows = await sql<{ id: string }[]>`
        WITH changes AS MATERIALIZED (
          SELECT item FROM jsonb_array_elements(${json(sql, input.updates)}::jsonb) AS entries(item)
        ), locked AS MATERIALIZED (
          SELECT work.id FROM object_vector_indexing AS work
          JOIN changes ON work.id = item->>'id' AND work.status = item->>'expectedStatus'
          WHERE work.project_id = ${input.projectId} ORDER BY work.id FOR UPDATE OF work
        )
        UPDATE object_vector_indexing AS work SET
          status = changes.item->>'status', available_at = (changes.item->>'availableAt')::timestamptz,
          values_json = COALESCE(changes.item->'values', work.values_json),
          error = (changes.item->'error')::text
        FROM changes, locked
        WHERE work.project_id = ${input.projectId} AND work.id = locked.id
          AND work.id = changes.item->>'id'
          AND (${!input.requireAll} OR (SELECT count(*) FROM locked) = ${input.updates.length})
        RETURNING work.id`
      return !input.requireAll || rows.length === input.updates.length
    })
  }

  async listDue(input: Parameters<OntologyVectorIndexingStorage["listDue"]>[0]) {
    return this.run(async (sql) =>
      (
        await sql<
          WorkRow[]
        >`SELECT batch_id, request, status, available_at, NULL AS values_json, error FROM object_vector_indexing WHERE project_id = ${input.projectId} AND status <> 'failed' AND dispatch_at <= ${input.now} ORDER BY dispatch_at, id LIMIT ${input.limit}`
      ).map(decode)
    )
  }
  async update(input: Parameters<OntologyVectorIndexingStorage["update"]>[0]) {
    return this.run(
      async (sql) =>
        (
          await sql`
      UPDATE object_vector_indexing SET status = ${input.status}, available_at = ${input.availableAt},
      values_json = COALESCE(${input.values ? json(sql, input.values) : null}, values_json), error = ${input.error ? JSON.stringify(input.error) : null}
      WHERE project_id = ${input.projectId} AND id = ${input.id} AND status = ${input.expectedStatus} RETURNING id
    `
        ).length === 1
    )
  }
  async remove(input: Parameters<OntologyVectorIndexingStorage["remove"]>[0]) {
    await this.run(async (sql) => {
      await sql`DELETE FROM object_vector_indexing WHERE project_id = ${input.projectId} AND id = ${input.id}`
    })
  }
}
function decode(row: WorkRow): VectorIndexingWork {
  return {
    ...row.request,
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    status: row.status,
    availableAt: new Date(row.available_at).toISOString(),
    ...(row.values_json ? { values: row.values_json } : {}),
    ...(row.error
      ? {
          error: parseSixbFailure(row.error, VECTOR_INDEXING_FAILURE_CODES),
        }
      : {}),
  }
}
