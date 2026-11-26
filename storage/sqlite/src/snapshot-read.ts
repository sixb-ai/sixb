import type { Database } from "bun:sqlite"
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
  SnapshotSourceRoot,
  StoredObjectVector,
  TimeseriesPoint,
} from "@sixb/core/storage"

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

interface SourceRowColumns {
  readonly root_key: string
  readonly entity_kind: "object" | "link"
  readonly object_type_id: string | null
  readonly primary_id: string | null
  readonly source_type_id: string | null
  readonly source_primary_id: string | null
  readonly link_id: string | null
  readonly target_type_id: string | null
  readonly target_primary_id: string | null
  readonly payload: string | null
}

/**
 * Live roots of a projection's source after `afterRootKey`, in root key order (BINARY, so by
 * UTF-8 bytes), each with what it asserts.
 */
export function readSqliteSourceRoots(
  db: Database,
  input: {
    readonly projectId: string
    readonly projectionId: string
    readonly afterRootKey?: string
    readonly limit: number
  }
): SnapshotSourceRoot[] {
  const rows = db
    .query<SourceRowColumns, [string, string, string, number]>(
      `WITH page AS (
         SELECT roots.id, roots.root_key
         FROM ontology_source_roots AS roots
         JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
         WHERE roots.project_id = ?1 AND versions.project_id = ?1 AND versions.source_id = ?2
           AND versions.status IN ('active', 'superseded')
           AND roots.retired_at IS NULL AND roots.deleted = 0 AND roots.root_key > ?3
         ORDER BY roots.root_key
         LIMIT ?4
       )
       SELECT page.root_key, rows.entity_kind, rows.object_type_id, rows.primary_id,
         rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
         rows.target_primary_id, rows.payload
       FROM page JOIN ontology_source_rows AS rows ON rows.root_id = page.id
       ORDER BY page.root_key`
    )
    .all(input.projectId, input.projectionId, input.afterRootKey ?? "", input.limit)

  const roots = new Map<string, SnapshotSourceRoot>()
  for (const row of rows) {
    const root = roots.get(row.root_key) ?? {
      rootKey: row.root_key,
      root: sourceEntityFromKey(row.root_key),
      assertions: [],
    }
    const payload = row.payload === null ? null : JSON.parse(row.payload)
    roots.set(row.root_key, {
      ...root,
      assertions: [...root.assertions, sourceAssertionFromColumns(row, payload)],
    })
  }
  return [...roots.values()]
}

/** A page of the edits over a type's objects, in primary id order: its primary key's. */
export function readSqliteObjectEdits(
  db: Database,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly afterPrimaryId?: string
    readonly limit: number
  }
): SnapshotObjectEdit[] {
  const rows = db
    .query<
      { primary_id: string; value: string; edited_at: string; updated_at: string },
      [string, string, string, number]
    >(
      `SELECT primary_id, value, edited_at, updated_at FROM ontology_object_overrides
       WHERE project_id = ? AND object_type_id = ? AND primary_id > ?
       ORDER BY primary_id LIMIT ?`
    )
    .all(input.projectId, input.objectTypeId, input.afterPrimaryId ?? "", input.limit)

  return rows.map((row) => ({
    ref: { objectTypeId: input.objectTypeId, primaryId: row.primary_id },
    value: JSON.parse(row.value) as ObjectOverride,
    editedAt: JSON.parse(row.edited_at) as Record<string, string>,
    updatedAt: row.updated_at,
  }))
}

/**
 * A page of the edits over links from a type's objects: edges, then slots, each in the order of
 * `idx_ontology_link_overrides_source`. A slot an old migration left in conflict is no edit a
 * branch takes over: the query leaves it out, so a page of them never ends the read early.
 */
export function readSqliteLinkEdits(
  db: Database,
  input: {
    readonly projectId: string
    readonly sourceTypeId: string
    readonly afterKey?: string
    readonly limit: number
  }
): SnapshotLinkEditRow[] {
  const after = input.afterKey === undefined ? undefined : (JSON.parse(input.afterKey) as string[])
  const edges =
    after?.[0] === "slot" ? [] : sqliteLinkEditsOf(db, input, "edge", after, input.limit)
  if (edges.length === input.limit) return edges

  const slots = sqliteLinkEditsOf(
    db,
    input,
    "slot",
    after?.[0] === "slot" ? after : undefined,
    input.limit - edges.length
  )
  return [...edges, ...slots]
}

function sqliteLinkEditsOf(
  db: Database,
  input: { readonly projectId: string; readonly sourceTypeId: string },
  kind: "edge" | "slot",
  after: readonly string[] | undefined,
  limit: number
): SnapshotLinkEditRow[] {
  const [, sourcePrimaryId = "", linkId = "", targetTypeId = "", targetPrimaryId = ""] = after ?? []
  const rows = db
    .query<
      {
        source_primary_id: string
        link_id: string
        target_type_id: string
        target_primary_id: string
        value: string
        updated_at: string
      },
      [string, string, string, string, string, string, string, number]
    >(
      `SELECT source_primary_id, link_id, target_type_id, target_primary_id, value, updated_at
       FROM ontology_link_overrides
       WHERE project_id = ? AND identity_kind = ? AND source_type_id = ?
         AND NOT (identity_kind = 'slot' AND json_extract(value, '$.kind') = 'legacy-conflict')
         AND (source_primary_id, link_id, target_type_id, target_primary_id) > (?, ?, ?, ?)
       ORDER BY source_primary_id, link_id, target_type_id, target_primary_id LIMIT ?`
    )
    .all(
      input.projectId,
      kind,
      input.sourceTypeId,
      sourcePrimaryId,
      linkId,
      targetTypeId,
      after ? targetPrimaryId : "",
      limit
    )

  return rows.map((row): SnapshotLinkEditRow => {
    const key = JSON.stringify([
      kind,
      row.source_primary_id,
      row.link_id,
      row.target_type_id,
      row.target_primary_id,
    ])
    const source = { objectTypeId: input.sourceTypeId, primaryId: row.source_primary_id }
    const value = JSON.parse(row.value) as LinkOverride | LinkSlotOverride
    return kind === "edge"
      ? {
          kind,
          key,
          ref: {
            source,
            linkId: row.link_id,
            target: { objectTypeId: row.target_type_id, primaryId: row.target_primary_id },
          },
          value: value as LinkOverride,
          updatedAt: row.updated_at,
        }
      : {
          kind,
          key,
          source,
          linkId: row.link_id,
          value: value as LinkSlotOverride,
          updatedAt: row.updated_at,
        }
  })
}
