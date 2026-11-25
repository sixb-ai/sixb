import type {
  LinkOverride,
  LinkSlotOverride,
  ObjectOverride,
} from "@sixb/core/internal/materialization"
import {
  sourceAssertionFromColumns,
  sourceEntityFromKey,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  GroupMembershipRecord,
  SnapshotLinkEditRow,
  SnapshotObjectEdit,
  SnapshotRange,
  SnapshotSourceRoot,
  StoredObjectVector,
  TimeseriesPoint,
} from "@sixb/core/storage"
import { objectPartitionName } from "./objects/partitions"
import { identityPageToken } from "./objects/query-compiler"
import { jsonParameter as json } from "./ontology-storage/shared"
import { PUBLISHED } from "./ontology-storage/source-roots"
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

/**
 * Live roots of a projection's source after `afterRootKey`, in root key order, each with what it
 * asserts: the roots of every published version of the source not retired since.
 */
export async function readPgSourceRoots(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly projectionId: string
    readonly afterRootKey?: string
    readonly limit: number
  }
): Promise<SnapshotSourceRoot[]> {
  const rows = await sql<
    {
      root_key: string
      entity_kind: "object" | "link"
      object_type_id: string | null
      primary_id: string | null
      source_type_id: string | null
      source_primary_id: string | null
      link_id: string | null
      target_type_id: string | null
      target_primary_id: string | null
      payload: unknown
    }[]
  >`
    WITH page AS (
      SELECT roots.id, roots.root_key
      FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      WHERE roots.project_id = ${input.projectId}
        AND versions.project_id = ${input.projectId}
        AND versions.source_id = ${input.projectionId}
        AND versions.status IN ${sql.unsafe(PUBLISHED)}
        AND roots.retired_at IS NULL AND NOT roots.deleted
        AND roots.root_key > ${input.afterRootKey ?? ""}
      ORDER BY roots.root_key
      LIMIT ${input.limit}
    )
    SELECT page.root_key, rows.entity_kind, rows.object_type_id, rows.primary_id,
      rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
      rows.target_primary_id, rows.payload
    FROM page
    JOIN ontology_source_rows AS rows ON rows.root_id = page.id
    ORDER BY page.root_key
  `

  const roots = new Map<string, SnapshotSourceRoot>()
  for (const row of rows) {
    const root = roots.get(row.root_key) ?? {
      rootKey: row.root_key,
      root: sourceEntityFromKey(row.root_key),
      assertions: [],
    }
    roots.set(row.root_key, {
      ...root,
      assertions: [...root.assertions, sourceAssertionFromColumns(row, row.payload)],
    })
  }
  return [...roots.values()]
}

/** A page of the edits over a type's objects, in primary id order: its primary key's. */
export async function readPgObjectEdits(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly afterPrimaryId?: string
    readonly limit: number
  }
): Promise<SnapshotObjectEdit[]> {
  const rows = await sql<
    {
      primary_id: string
      value: ObjectOverride
      edited_at: Record<string, string> | null
      updated_at: Date
    }[]
  >`
    SELECT primary_id, value, edited_at, updated_at FROM ontology_object_overrides
    WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
      AND primary_id > ${input.afterPrimaryId ?? ""}
    ORDER BY primary_id
    LIMIT ${input.limit}
  `

  return rows.map((row) => ({
    ref: { objectTypeId: input.objectTypeId, primaryId: row.primary_id },
    value: row.value,
    ...(row.edited_at === null ? {} : { editedAt: row.edited_at }),
    updatedAt: row.updated_at.toISOString(),
  }))
}

/**
 * A page of the edits over links from a type's objects, in their primary key's order: edges, then
 * slots, by identity. A slot an old migration left in conflict is no edit a branch takes over.
 */
export async function readPgLinkEdits(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly sourceTypeId: string
    readonly afterKey?: string
    readonly limit: number
  }
): Promise<SnapshotLinkEditRow[]> {
  const after = input.afterKey === undefined ? undefined : linkEditCursor(input.afterKey)
  const rows = await sql<
    {
      identity_kind: "edge" | "slot"
      identity_key: string[]
      source_primary_id: string
      link_id: string
      target_type_id: string
      target_primary_id: string
      value: LinkOverride | LinkSlotOverride | { readonly kind: "legacy-conflict" }
      updated_at: Date
    }[]
  >`
    SELECT identity_kind, identity_key, source_primary_id, link_id, target_type_id,
      target_primary_id, value, updated_at
    FROM ontology_link_overrides
    WHERE project_id = ${input.projectId} AND source_type_id = ${input.sourceTypeId}
      ${after ? sql`AND (identity_kind, identity_key) > (${after.kind}, ${json(sql, after.identity)}::jsonb)` : sql``}
    ORDER BY identity_kind, identity_key
    LIMIT ${input.limit}
  `

  const source = (row: (typeof rows)[number]) => ({
    objectTypeId: input.sourceTypeId,
    primaryId: row.source_primary_id,
  })
  return rows.flatMap((row): SnapshotLinkEditRow[] => {
    const key = JSON.stringify([row.identity_kind, row.identity_key])
    const updatedAt = row.updated_at.toISOString()
    if (row.identity_kind === "edge") {
      const ref = {
        source: source(row),
        linkId: row.link_id,
        target: { objectTypeId: row.target_type_id, primaryId: row.target_primary_id },
      }
      return [{ kind: "edge", key, ref, value: row.value as LinkOverride, updatedAt }]
    }
    if (row.value.kind === "legacy-conflict") return []
    return [
      {
        kind: "slot",
        key,
        source: source(row),
        linkId: row.link_id,
        value: row.value as LinkSlotOverride,
        updatedAt,
      },
    ]
  })
}

function linkEditCursor(key: string): { kind: string; identity: readonly string[] } {
  const [kind, identity] = JSON.parse(key) as [string, string[]]
  return { kind, identity }
}
