import type {
  GroupMembershipRecord,
  SnapshotRange,
  StoredObjectVector,
  TimeseriesPoint,
} from "@sixb/core/storage"
import { objectPartitionName } from "./objects/partitions"
import { identityPageToken } from "./objects/query-compiler"
import type { SQLClient } from "./pg-client"

// What a snapshot's views read beside the object reader, on their snapshot's connection.

/** The stored vectors of these objects, with their values. */
export async function readPgVectors(
  sql: SQLClient,
  projectId: string,
  refs: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
): Promise<StoredObjectVector[]> {
  if (refs.length === 0) return []

  const rows = await sql<
    {
      object_type_id: string
      primary_id: string
      profile: string
      configuration: string
      source: string[]
      source_fingerprint: string
      embedding: number[]
      last_commit_id: string
    }[]
  >`
    SELECT stored.object_type_id, stored.primary_id, stored.profile, stored.configuration,
      stored.source, stored.source_fingerprint, stored.embedding, stored.last_commit_id
    FROM unnest(
      ${refs.map((ref) => ref.objectTypeId)}::text[],
      ${refs.map((ref) => ref.primaryId)}::text[]
    ) AS requested(object_type_id, primary_id)
    JOIN object_vectors AS stored
      ON stored.project_id = ${projectId}
     AND stored.object_type_id = requested.object_type_id
     AND stored.primary_id = requested.primary_id
  `

  return rows.map((row) => ({
    ref: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
    profile: row.profile,
    configuration: row.configuration,
    source: row.source,
    sourceFingerprint: row.source_fingerprint,
    values: row.embedding.map(Number),
    lastCommitId: row.last_commit_id,
  }))
}

/** The latest point of each series, from the table that keeps them. */
export async function readPgLatestPoints(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly objectIds: readonly string[]
    readonly propertyIds: readonly string[]
  }
): Promise<TimeseriesPoint[]> {
  if (input.objectIds.length === 0 || input.propertyIds.length === 0) return []

  const rows = await sql<
    {
      object_id: string
      property_id: string
      value: unknown
      unit: string | null
      at: Date
      last_commit_id: string
    }[]
  >`
    SELECT object_id, property_id, value, unit, at, last_commit_id
    FROM timeseries_latest
    WHERE project_id = ${input.projectId}
      AND object_type_id = ${input.objectTypeId}
      AND object_id = ANY(${input.objectIds}::text[])
      AND property_id = ANY(${input.propertyIds}::text[])
  `

  return rows.map((row) => ({
    projectId: input.projectId,
    objectTypeId: input.objectTypeId,
    objectId: row.object_id,
    propertyId: row.property_id,
    value: row.value,
    ...(row.unit === null ? {} : { unit: row.unit }),
    at: row.at,
    lastCommitId: row.last_commit_id,
  }))
}

export async function readPgMemberships(
  sql: SQLClient,
  projectId: string
): Promise<GroupMembershipRecord[]> {
  const rows = await sql<
    {
      user_id: string
      group_id: string
      source: GroupMembershipRecord["source"]
      created_at: Date
    }[]
  >`
    SELECT user_id, group_id, source, created_at
    FROM auth_group_memberships
    WHERE project_id = ${projectId}
    ORDER BY user_id, group_id
  `
  return rows.map((row) => ({
    projectId,
    userId: row.user_id,
    groupId: row.group_id,
    source: row.source,
    createdAt: row.created_at,
  }))
}

/**
 * Ranges of a type for views to read side by side. Their bounds come from the statistics
 * PostgreSQL keeps on the type's partition, each moved onto an object that exists in this
 * snapshot, in the order the reader's pages follow. A type without statistics, or smaller than
 * `minObjects`, is read whole.
 */
export async function readPgRanges(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly parts: number
    readonly minObjects: number
  }
): Promise<SnapshotRange[]> {
  const partition = objectPartitionName(input.objectTypeId)
  const [stats] = await sql<{ rows: number; bounds: string[] | null }[]>`
    SELECT class.reltuples::float8 AS rows,
      (SELECT histogram_bounds::text::text[] FROM pg_stats
        WHERE schemaname = current_schema() AND tablename = ${partition}
          AND attname = 'primary_id') AS bounds
    FROM pg_class AS class
    WHERE class.oid = to_regclass(${partition})
  `
  const bounds = stats?.bounds ?? []
  if (!stats || stats.rows < input.minObjects || bounds.length < input.parts) return []

  const lastIds: string[] = []
  for (let part = 1; part < input.parts; part += 1) {
    const bound = bounds[Math.floor((part * bounds.length) / input.parts)]!
    const [row] = await sql<{ primary_id: string }[]>`
      SELECT primary_id FROM objects
      WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
        AND primary_id >= ${bound}
      ORDER BY primary_id
      LIMIT 1
    `
    if (row && row.primary_id !== lastIds.at(-1)) lastIds.push(row.primary_id)
  }

  return [
    ...lastIds.map((lastPrimaryId, index) => ({
      ...(index === 0 ? {} : { startToken: tokenAfter(input.objectTypeId, lastIds[index - 1]!) }),
      lastPrimaryId,
    })),
    ...(lastIds.length === 0
      ? []
      : [{ startToken: tokenAfter(input.objectTypeId, lastIds.at(-1)!) }]),
  ]
}

function tokenAfter(objectTypeId: string, primaryId: string): string {
  return identityPageToken(objectTypeId, primaryId)
}
