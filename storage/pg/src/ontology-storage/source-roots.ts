import type { ProjectionEntityRef } from "@sixb/core/internal/materialization"
import {
  MaterializationConflictError,
  MaterializationValidationError,
  projectionEntityKey,
} from "@sixb/core/internal/materialization"
import { sourceStageRoots, utf8SortKey } from "@sixb/core/internal/ontology-storage-provider"
import type { SourceActivationWrite, StageSourceRowsInput } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import type { PgOntologySourceAssertionRow } from "./shared"
import { jsonParameter, type PgOntologySourceRow } from "./shared"

export function replacementSourceRows(
  sql: SQLClient,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly materializationId: string
    readonly incremental: boolean
  }
) {
  const roots = input.incremental
    ? sql`
    SELECT roots.* FROM ontology_source_roots AS changed
    CROSS JOIN LATERAL (
      SELECT roots.* FROM ontology_source_roots AS roots
      WHERE roots.project_id = changed.project_id AND roots.source_id = changed.source_id
        AND roots.root_sort_key = changed.root_sort_key AND roots.active OFFSET 0
    ) AS roots
    WHERE changed.project_id = ${input.projectId} AND changed.source_id = ${input.sourceId}
      AND changed.materialization_id = ${input.materializationId}
  `
    : sql`SELECT * FROM ontology_source_roots WHERE project_id = ${input.projectId} AND source_id = ${input.sourceId} AND active`
  return sql`
    SELECT * FROM ontology_source_rows WHERE project_id = ${input.projectId}
      AND source_id = ${input.sourceId} AND materialization_id = ${input.materializationId}
    UNION ALL
    SELECT rows.* FROM (${roots}) AS roots
    CROSS JOIN LATERAL (
      SELECT rows.* FROM ontology_source_rows AS rows WHERE rows.project_id = roots.project_id
        AND rows.source_id = roots.source_id AND rows.materialization_id = roots.materialization_id
        AND rows.root_sort_key = roots.root_sort_key OFFSET 0
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
      root_sort_key: root.sortKey,
      root_kind: root.root.kind,
      root_key: JSON.parse(root.rootKey),
      root: root.root,
      staging_ordinal: root.stagingOrdinal,
      deleted: root.deleted,
    }))
  )
  const inserted = await sql<{ root_sort_key: string }[]>`
    INSERT INTO ontology_source_roots (
      project_id, source_id, materialization_id, root_sort_key, root_kind, root_key, root, staging_ordinal, deleted
    ) SELECT ${input.projectId}, ${input.source.projectionId}, ${input.materializationId},
      root_sort_key, root_kind, root_key, root, staging_ordinal, deleted
    FROM jsonb_to_recordset(${values}) AS input(
      root_sort_key TEXT, root_kind TEXT, root_key JSONB, root JSONB, staging_ordinal BIGINT, deleted BOOLEAN)
    ON CONFLICT DO NOTHING RETURNING root_sort_key
  `
  if (inserted.length === roots.length) return
  const insertedKeys = new Set(inserted.map((row) => row.root_sort_key))
  const skipped = roots.filter((root) => !insertedKeys.has(root.sortKey))
  const stored = await sql<
    { root_sort_key: string; staging_ordinal: string | number; deleted: boolean }[]
  >`
    SELECT root_sort_key, staging_ordinal, deleted FROM ontology_source_roots
    WHERE project_id = ${input.projectId} AND source_id = ${input.source.projectionId}
      AND materialization_id = ${input.materializationId}
      AND root_sort_key = ANY(${sql.array(skipped.map((root) => root.sortKey))}::text[])
  `
  const existing = new Map(stored.map((root) => [root.root_sort_key, root]))
  if (
    skipped.some((root) => {
      const previous = existing.get(root.sortKey)
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
  const affected =
    candidate.base_materialization_id === null
      ? sql``
      : sql`AND root_sort_key IN (
    SELECT root_sort_key FROM ontology_source_roots
    WHERE project_id = ${projectId} AND source_id = ${activation.source.projectionId}
      AND materialization_id = ${activation.materializationId}
  )`
  await sql`
    UPDATE ontology_source_roots AS roots SET active = FALSE, retired_at = ${activation.updatedAt}
    WHERE project_id = ${projectId} AND source_id = ${activation.source.projectionId} AND active
    ${affected}
  `
  await sql`
    UPDATE ontology_source_roots SET active = NOT deleted,
      retired_at = CASE WHEN deleted THEN ${activation.updatedAt}::timestamptz ELSE NULL END
    WHERE project_id = ${projectId} AND source_id = ${activation.source.projectionId}
      AND materialization_id = ${activation.materializationId}
  `
}

export async function assertSourceRootCoverage(
  sql: SQLClient,
  manifest: PgOntologySourceRow
): Promise<void> {
  const [invalid] = await sql`
    SELECT 1 FROM ontology_source_roots AS roots
    WHERE project_id = ${manifest.project_id} AND source_id = ${manifest.source_id}
      AND materialization_id = ${manifest.materialization_id}
      AND roots.deleted = EXISTS (
        SELECT 1 FROM ontology_source_rows AS rows
        WHERE rows.project_id = roots.project_id AND rows.source_id = roots.source_id
          AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
      ) LIMIT 1
  `
  if (invalid)
    throw new MaterializationValidationError(
      "Source roots must have complete assertions or an explicit deletion, never both."
    )
}

export function activeSourceRows(
  sql: SQLClient,
  projectId: string,
  refs: readonly ProjectionEntityRef[]
) {
  const keys = refs.flatMap((entity) => {
    const entitySortKey = utf8SortKey(projectionEntityKey(entity))
    const roots =
      entity.kind === "object"
        ? [entitySortKey]
        : [
            entitySortKey,
            utf8SortKey(projectionEntityKey({ kind: "object", ref: entity.ref.source })),
          ]
    return roots.map((rootSortKey) => ({
      root_sort_key: rootSortKey,
      entity_sort_key: entitySortKey,
    }))
  })
  return sql<PgOntologySourceAssertionRow[]>`
    SELECT rows.* FROM jsonb_to_recordset(${jsonParameter(sql, keys)}) AS requested(root_sort_key TEXT, entity_sort_key TEXT)
    JOIN ontology_source_roots AS roots ON roots.project_id = ${projectId}
      AND roots.active AND roots.root_sort_key = requested.root_sort_key
    JOIN ontology_source_rows AS rows ON rows.project_id = roots.project_id AND rows.source_id = roots.source_id
      AND rows.materialization_id = roots.materialization_id AND rows.entity_sort_key = requested.entity_sort_key
      AND rows.root_sort_key = roots.root_sort_key
  `
}

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
  const keys = input.refs.map((ref) => ({
    entity_kind: ref.kind,
    entity_key: JSON.parse(projectionEntityKey(ref)),
    root_keys:
      ref.kind === "object"
        ? [utf8SortKey(projectionEntityKey(ref))]
        : [
            utf8SortKey(projectionEntityKey(ref)),
            utf8SortKey(projectionEntityKey({ kind: "object", ref: ref.ref.source })),
          ],
  }))
  const previous = !input.includePrevious
    ? sql``
    : sql`UNION ALL
    SELECT rows.* FROM (
      SELECT roots.* FROM ontology_source_roots AS roots
    WHERE roots.project_id = ${input.projectId} AND roots.source_id = ${input.sourceId}
      AND roots.active AND roots.root_sort_key = ANY(requested.root_keys)
      ${
        !input.incremental
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM ontology_source_roots AS changed
        WHERE changed.project_id = roots.project_id AND changed.source_id = roots.source_id
          AND changed.materialization_id = ${input.materializationId} AND changed.root_sort_key = roots.root_sort_key)`
      }

      OFFSET 0
    ) AS roots
    CROSS JOIN LATERAL (
      SELECT rows.* FROM ontology_source_rows AS rows
      WHERE rows.project_id = roots.project_id AND rows.source_id = roots.source_id
        AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
        AND rows.entity_kind = requested.entity_kind AND rows.entity_key = requested.entity_key
      OFFSET 0
    ) AS rows
  `
  // Keep each JSON request as an indexed identity lookup even with fresh/stale statistics.
  // Flattening this LATERAL caused a cold 10k-root run to spend seconds on each state page.
  return sql<PgOntologySourceAssertionRow[]>`
    SELECT selected.* FROM jsonb_to_recordset(${jsonParameter(sql, keys)})
      AS requested(entity_kind TEXT, entity_key JSONB, root_keys TEXT[])
    CROSS JOIN LATERAL (
      SELECT rows.* FROM ontology_source_rows AS rows
      WHERE rows.project_id = ${input.projectId} AND rows.source_id = ${input.sourceId}
        AND rows.materialization_id = ${input.materializationId}
        AND rows.entity_kind = requested.entity_kind AND rows.entity_key = requested.entity_key
      ${previous}
      OFFSET 0
    ) AS selected
  `
}
