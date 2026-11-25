import type { Database } from "bun:sqlite"
import type { GroupMembershipRecord, StoredObjectVector, TimeseriesPoint } from "@sixb/core/storage"

// What a snapshot's view reads beside the object reader, in its read transaction.

/** The latest point of each series: SQLite keeps no separate table of them. */
export function readSqliteLatestPoints(
  db: Database,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly objectIds: readonly string[]
    readonly propertyIds: readonly string[]
  }
): TimeseriesPoint[] {
  if (input.objectIds.length === 0 || input.propertyIds.length === 0) return []

  const rows = db
    .query<
      {
        object_id: string
        property_id: string
        value: string
        unit: string | null
        at: string
        last_commit_id: string
      },
      [string, string, string, string]
    >(
      `SELECT object_id, property_id, value, unit, at, last_commit_id
       FROM (
         SELECT points.*, row_number() OVER (
           PARTITION BY points.object_id, points.property_id ORDER BY points.at DESC
         ) AS position
         FROM timeseries AS points
         WHERE points.project_id = ? AND points.object_type_id = ?
           AND points.object_id IN (SELECT value FROM json_each(?))
           AND points.property_id IN (SELECT value FROM json_each(?))
       )
       WHERE position = 1`
    )
    .all(
      input.projectId,
      input.objectTypeId,
      JSON.stringify(input.objectIds),
      JSON.stringify(input.propertyIds)
    )

  return rows.map((row) => ({
    projectId: input.projectId,
    objectTypeId: input.objectTypeId,
    objectId: row.object_id,
    propertyId: row.property_id,
    value: JSON.parse(row.value) as unknown,
    ...(row.unit === null ? {} : { unit: row.unit }),
    at: new Date(row.at),
    lastCommitId: row.last_commit_id,
  }))
}

/** Every group membership of the project, in one read. */
export function readSqliteMemberships(db: Database, projectId: string): GroupMembershipRecord[] {
  const rows = db
    .query<
      {
        user_id: string
        group_id: string
        source: GroupMembershipRecord["source"]
        created_at: string
      },
      [string]
    >(
      `SELECT user_id, group_id, source, created_at FROM auth_group_memberships
       WHERE project_id = ? ORDER BY user_id, group_id`
    )
    .all(projectId)

  return rows.map((row) => ({
    projectId,
    userId: row.user_id,
    groupId: row.group_id,
    source: row.source,
    createdAt: new Date(row.created_at),
  }))
}

/** The stored vectors of these objects, with their values. */
export function readSqliteVectors(
  db: Database,
  projectId: string,
  refs: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
): StoredObjectVector[] {
  if (refs.length === 0) return []

  const rows = db
    .query<
      {
        object_type_id: string
        primary_id: string
        profile: string
        configuration: string
        source: string
        source_fingerprint: string
        embedding: Uint8Array
        last_commit_id: string
      },
      [string, string]
    >(
      `SELECT stored.object_type_id, stored.primary_id, stored.profile, stored.configuration,
         stored.source, stored.source_fingerprint, stored.embedding, stored.last_commit_id
       FROM json_each(?) AS requested
       JOIN object_vectors AS stored
         ON stored.project_id = ?
        AND stored.object_type_id = json_extract(requested.value, '$.objectTypeId')
        AND stored.primary_id = json_extract(requested.value, '$.primaryId')`
    )
    .all(JSON.stringify(refs), projectId)

  return rows.map((row) => {
    const bytes = row.embedding
    const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    return {
      ref: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
      profile: row.profile,
      configuration: row.configuration,
      source: JSON.parse(row.source) as string[],
      sourceFingerprint: row.source_fingerprint,
      values: Array.from(values),
      lastCommitId: row.last_commit_id,
    }
  })
}
