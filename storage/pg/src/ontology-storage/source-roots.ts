import type { ProjectionEntityRef } from "@sixb/core/internal/materialization"
import {
  MaterializationConflictError,
  MaterializationValidationError,
  projectionEntityKey,
} from "@sixb/core/internal/materialization"
import {
  sourceEntityColumns,
  sourceStageRoots,
} from "@sixb/core/internal/ontology-storage-provider"
import type { SourceActivationWrite, StageSourceRowsInput } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import type { PgOntologySourceAssertionRow } from "./shared"
import { jsonParameter, type PgOntologySourceRow } from "./shared"

/**
 * Source storage in three levels: a version (`ontology_sources`, one per run), its roots (one per
 * logical dataset row, keyed by the canonical entity key) and their rows (what each root asserts).
 *
 * A root is live while its version is published (active or superseded), it is not retired and it
 * is not a deletion. Activation retires the live roots its candidate replaces and flips the
 * version; the candidate's own roots are never rewritten. One live root per source and key holds
 * because activation, under the source fence, retires every root the candidate replaces.
 */
export const PUBLISHED = "('active', 'superseded')"

/** The columns `sourceAssertion` reads, over `versions`, `roots` and `rows`. */
export function sourceAssertionColumns(sql: SQLClient) {
  return sql.unsafe(`versions.source_id, versions.materialization_id, roots.root_key,
    roots.staging_ordinal, rows.entity_kind, rows.object_type_id, rows.primary_id,
    rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
    rows.target_primary_id, rows.payload`)
}

/** Keeps `rows` to those of live roots in `projectId`, joined as `roots` and `versions`. */
export function liveSourceRowsJoin(sql: SQLClient, projectId: string) {
  return sql`
    JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
      AND roots.project_id = ${projectId} AND roots.retired_at IS NULL AND NOT roots.deleted
    JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.status IN ${sql.unsafe(PUBLISHED)}
  `
}

function candidateVersion(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly materializationId: string
  }
) {
  return sql`(SELECT version_id FROM ontology_sources WHERE project_id = ${input.projectId}
    AND source_id = ${input.sourceId} AND materialization_id = ${input.materializationId})`
}

/** The typed identity of `rows` equals the one requested. */
const ENTITY_MATCH = `rows.entity_kind = requested.entity_kind
  AND rows.object_type_id IS NOT DISTINCT FROM requested.object_type_id
  AND rows.primary_id IS NOT DISTINCT FROM requested.primary_id
  AND rows.source_type_id IS NOT DISTINCT FROM requested.source_type_id
  AND rows.source_primary_id IS NOT DISTINCT FROM requested.source_primary_id
  AND rows.link_id IS NOT DISTINCT FROM requested.link_id
  AND rows.target_type_id IS NOT DISTINCT FROM requested.target_type_id
  AND rows.target_primary_id IS NOT DISTINCT FROM requested.target_primary_id`

const REQUESTED_ENTITY = `entity_kind TEXT, object_type_id TEXT, primary_id TEXT,
  source_type_id TEXT, source_primary_id TEXT, link_id TEXT, target_type_id TEXT,
  target_primary_id TEXT`

/** An entity's own key, and for a link the key of the object root that may assert it. */
function requestedEntity(ref: ProjectionEntityRef) {
  const columns = sourceEntityColumns(ref)
  const key = projectionEntityKey(ref)
  return {
    entity_kind: ref.kind,
    object_type_id: columns.objectTypeId,
    primary_id: columns.primaryId,
    source_type_id: columns.sourceTypeId,
    source_primary_id: columns.sourcePrimaryId,
    link_id: columns.linkId,
    target_type_id: columns.targetTypeId,
    target_primary_id: columns.targetPrimaryId,
    root_keys:
      ref.kind === "object"
        ? [key]
        : [key, projectionEntityKey({ kind: "object", ref: ref.ref.source })],
  }
}

/** The candidate's rows, plus the rows of the live roots it may replace. */
export function replacementSourceRows(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly materializationId: string
    readonly incremental: boolean
  }
) {
  const live = sql`roots.retired_at IS NULL AND NOT roots.deleted
    AND versions.source_id = ${input.sourceId} AND versions.status IN ${sql.unsafe(PUBLISHED)}`
  const roots = input.incremental
    ? sql`
    SELECT live.id FROM ontology_source_roots AS changed
    CROSS JOIN LATERAL (
      SELECT roots.id FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      WHERE roots.project_id = ${input.projectId} AND roots.root_key = changed.root_key AND ${live}
      OFFSET 0
    ) AS live
    WHERE changed.version_id = ${candidateVersion(sql, input)}
  `
    : sql`
    SELECT roots.id FROM ontology_sources AS versions
    JOIN ontology_source_roots AS roots ON roots.version_id = versions.version_id
    WHERE versions.project_id = ${input.projectId} AND ${live}
  `
  return sql`
    SELECT rows.* FROM ontology_source_roots AS roots
    JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
    WHERE roots.version_id = ${candidateVersion(sql, input)}
    UNION ALL
    SELECT rows.* FROM (${roots}) AS roots
    CROSS JOIN LATERAL (
      SELECT rows.* FROM ontology_source_rows AS rows WHERE rows.root_id = roots.id OFFSET 0
    ) AS rows
  `
}

export async function stageSourceRoots(
  sql: SQLClient,
  manifest: PgOntologySourceRow,
  input: StageSourceRowsInput
): Promise<void> {
  const roots = sourceStageRoots(manifest.projection_kind, input)
  if (roots.length === 0) return
  if (!manifest.base_materialization_id && roots.some((root) => root.deleted)) {
    throw new MaterializationValidationError("Root deletions require a source delta base.")
  }
  const values = jsonParameter(
    sql,
    roots.map((root) => ({
      root_key: root.rootKey,
      staging_ordinal: root.stagingOrdinal,
      deleted: root.deleted,
    }))
  )
  const inserted = await sql<{ root_key: string }[]>`
    INSERT INTO ontology_source_roots (version_id, project_id, root_key, staging_ordinal, deleted)
    SELECT ${manifest.version_id}, ${input.projectId}, root_key, staging_ordinal, deleted
    FROM jsonb_to_recordset(${values}) AS input(root_key TEXT, staging_ordinal BIGINT, deleted BOOLEAN)
    ON CONFLICT DO NOTHING RETURNING root_key
  `
  if (inserted.length === roots.length) return
  const insertedKeys = new Set(inserted.map((row) => row.root_key))
  const skipped = roots.filter((root) => !insertedKeys.has(root.rootKey))
  const stored = await sql<
    { root_key: string; staging_ordinal: string | number; deleted: boolean }[]
  >`
    SELECT root_key, staging_ordinal, deleted FROM ontology_source_roots
    WHERE version_id = ${manifest.version_id}
      AND root_key = ANY(${sql.array(skipped.map((root) => root.rootKey))}::text[])
  `
  const existing = new Map(stored.map((root) => [root.root_key, root]))
  if (
    skipped.some((root) => {
      const previous = existing.get(root.rootKey)
      return (
        !previous ||
        Number(previous.staging_ordinal) !== root.stagingOrdinal ||
        previous.deleted !== root.deleted
      )
    })
  )
    throw new MaterializationValidationError(
      "Source materialization repeats root or stream ordinal with different content."
    )
}

/** Retires what the candidate replaces; its own roots go live when its version turns active. */
export async function activateSourceRoots(
  sql: SQLClient,
  projectId: string,
  candidate: PgOntologySourceRow,
  activation: SourceActivationWrite
): Promise<void> {
  if (
    candidate.base_materialization_id !== null &&
    (candidate.base_materialization_id !== activation.expected.activeMaterializationId ||
      candidate.base_commit_id !== activation.expected.lastCommitId)
  )
    throw new MaterializationConflictError(
      "projection-fence",
      "Source delta base changed before activation."
    )
  if (candidate.base_materialization_id !== null && Number(candidate.root_count) === 0) return
  const live = sql`roots.retired_at IS NULL AND NOT roots.deleted
    AND versions.version_id = roots.version_id AND versions.project_id = ${projectId}
    AND versions.source_id = ${activation.source.projectionId}
    AND versions.status IN ${sql.unsafe(PUBLISHED)}`
  if (candidate.base_materialization_id === null) {
    await sql`
      UPDATE ontology_source_roots AS roots SET retired_at = ${activation.updatedAt}
      FROM ontology_sources AS versions WHERE ${live}
    `
  } else {
    await sql`
      UPDATE ontology_source_roots AS roots SET retired_at = ${activation.updatedAt}
      FROM ontology_source_roots AS changed, ontology_sources AS versions
      WHERE changed.version_id = ${candidate.version_id} AND roots.project_id = ${projectId}
        AND roots.root_key = changed.root_key AND ${live}
    `
  }
  // Deletions are never live; retiring them lets cleanup remove them with their version.
  await sql`
    UPDATE ontology_source_roots SET retired_at = ${activation.updatedAt}
    WHERE version_id = ${candidate.version_id} AND deleted
  `
}

export async function assertSourceRootCoverage(
  sql: SQLClient,
  manifest: PgOntologySourceRow
): Promise<void> {
  const [invalid] = await sql`
    SELECT 1 FROM ontology_source_roots AS roots
    WHERE roots.version_id = ${manifest.version_id}
      AND roots.deleted = EXISTS (
        SELECT 1 FROM ontology_source_rows AS rows WHERE rows.root_id = roots.id
      )
    LIMIT 1
  `
  if (invalid)
    throw new MaterializationValidationError(
      "Source roots must have complete assertions or an explicit deletion, never both."
    )
}

/** The live assertions of `refs`, whichever source asserts them. */
export function activeSourceRows(
  sql: SQLClient,
  projectId: string,
  refs: readonly ProjectionEntityRef[]
) {
  const requested = refs.flatMap((ref) => {
    const { root_keys, ...entity } = requestedEntity(ref)
    return root_keys.map((root_key) => ({ ...entity, root_key }))
  })
  return sql<PgOntologySourceAssertionRow[]>`
    SELECT ${sourceAssertionColumns(sql)}
    FROM jsonb_to_recordset(${jsonParameter(sql, requested)})
      AS requested(root_key TEXT, ${sql.unsafe(REQUESTED_ENTITY)})
    JOIN ontology_source_roots AS roots ON roots.project_id = ${projectId}
      AND roots.root_key = requested.root_key AND roots.retired_at IS NULL AND NOT roots.deleted
    JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.status IN ${sql.unsafe(PUBLISHED)}
    JOIN ontology_source_rows AS rows ON rows.root_id = roots.id AND ${sql.unsafe(ENTITY_MATCH)}
  `
}

/** The candidate's assertions of `refs`, and optionally the live ones they would replace. */
export function replacementAssertionRows(
  sql: SQLClient,
  input: {
    projectId: string
    sourceId: string
    materializationId: string
    incremental: boolean
    includePrevious: boolean
    refs: readonly ProjectionEntityRef[]
  }
) {
  const version = candidateVersion(sql, input)
  const previous = !input.includePrevious
    ? sql``
    : sql`UNION ALL
    SELECT ${sourceAssertionColumns(sql)} FROM (
      SELECT roots.* FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      WHERE roots.project_id = ${input.projectId} AND roots.root_key = ANY(requested.root_keys)
        AND roots.retired_at IS NULL AND NOT roots.deleted
        AND versions.source_id = ${input.sourceId} AND versions.status IN ${sql.unsafe(PUBLISHED)}
      ${
        !input.incremental
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM ontology_source_roots AS changed
        WHERE changed.version_id = ${version} AND changed.root_key = roots.root_key)`
      }
      OFFSET 0
    ) AS roots
    JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
    CROSS JOIN LATERAL (
      SELECT rows.* FROM ontology_source_rows AS rows
      WHERE rows.root_id = roots.id AND ${sql.unsafe(ENTITY_MATCH)}
      OFFSET 0
    ) AS rows
  `
  // Keep each JSON request as an indexed identity lookup even with fresh/stale statistics.
  // Flattening this LATERAL caused a cold 10k-root run to spend seconds on each state page.
  return sql<PgOntologySourceAssertionRow[]>`
    SELECT selected.* FROM jsonb_to_recordset(${jsonParameter(sql, input.refs.map(requestedEntity))})
      AS requested(${sql.unsafe(REQUESTED_ENTITY)}, root_keys TEXT[])
    CROSS JOIN LATERAL (
      SELECT ${sourceAssertionColumns(sql)} FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      JOIN ontology_source_rows AS rows ON rows.root_id = roots.id AND ${sql.unsafe(ENTITY_MATCH)}
      WHERE roots.version_id = ${version} AND roots.root_key = ANY(requested.root_keys)
      ${previous}
      OFFSET 0
    ) AS selected
  `
}
