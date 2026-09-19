import type { Database } from "bun:sqlite"
import type { ProjectionEntityRef } from "@sixb/core/internal/materialization"
import {
  MaterializationConflictError,
  MaterializationValidationError,
  projectionEntityKey,
} from "@sixb/core/internal/materialization"
import { sourceStageRoots, utf8SortKey } from "@sixb/core/internal/ontology-storage-provider"
import type { SourceActivationWrite, StageSourceRowsInput } from "@sixb/core/storage"
import type { SqliteOntologySourceAssertionRow } from "./shared"
import { canonicalJson, type SqliteOntologySourceRow } from "./shared"

export function replacementSourceRows(input: {
  readonly projectId: string
  readonly sourceId: string
  readonly materializationId: string
  readonly incremental: boolean
}): { readonly sql: string; readonly values: readonly string[] } {
  const roots = input.incremental
    ? `ontology_source_roots AS changed
    CROSS JOIN ontology_source_roots AS roots ON roots.project_id = changed.project_id
      AND roots.source_id = changed.source_id AND roots.root_sort_key = changed.root_sort_key AND roots.active = 1`
    : "ontology_source_roots AS roots"
  const selected = input.incremental ? "changed" : "roots"
  return {
    sql: `SELECT * FROM ontology_source_rows WHERE project_id = ? AND source_id = ? AND materialization_id = ?
      UNION ALL
      SELECT rows.* FROM ${roots}
      CROSS JOIN ontology_source_rows AS rows ON rows.project_id = roots.project_id
        AND rows.source_id = roots.source_id AND rows.materialization_id = roots.materialization_id
        AND rows.root_sort_key = roots.root_sort_key
      WHERE ${selected}.project_id = ? AND ${selected}.source_id = ?
        AND ${input.incremental ? "changed.materialization_id = ?" : "roots.active = 1"}`,
    values: [
      input.projectId,
      input.sourceId,
      input.materializationId,
      input.projectId,
      input.sourceId,
      ...(input.incremental ? [input.materializationId] : []),
    ],
  }
}

export function stageSourceRoots(
  db: Database,
  manifest: SqliteOntologySourceRow,
  input: StageSourceRowsInput
): void {
  const roots = sourceStageRoots(manifest.projection_kind, input)
  if (!manifest.base_materialization_id && roots.some((root) => root.deleted)) {
    throw new MaterializationValidationError("Root deletions require a source delta base.")
  }
  const existing = db.query(`SELECT staging_ordinal, deleted FROM ontology_source_roots
    WHERE project_id = ? AND source_id = ? AND materialization_id = ? AND root_sort_key = ?`)
  const insert = db.query(`INSERT INTO ontology_source_roots (
    project_id, source_id, materialization_id, root_sort_key, root_kind, root_key, root, staging_ordinal, deleted
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING root_sort_key`)
  for (const root of roots) {
    const inserted = insert.get(
      input.projectId,
      input.source.projectionId,
      input.materializationId,
      root.sortKey,
      root.root.kind,
      root.rootKey,
      canonicalJson(root.root),
      root.stagingOrdinal,
      Number(root.deleted)
    )
    if (inserted) continue
    const previous = existing.get(
      input.projectId,
      input.source.projectionId,
      input.materializationId,
      root.sortKey
    ) as { staging_ordinal: number; deleted: number } | null
    if (
      !previous ||
      previous.staging_ordinal !== root.stagingOrdinal ||
      Boolean(previous.deleted) !== root.deleted
    ) {
      throw new MaterializationValidationError(
        "Source materialization repeats root or stream ordinal with different content."
      )
    }
  }
}

export function activateSourceRoots(
  db: Database,
  projectId: string,
  candidate: SqliteOntologySourceRow,
  activation: SourceActivationWrite
): void {
  if (
    candidate.base_materialization_id !== null &&
    (candidate.base_materialization_id !== activation.expected.activeMaterializationId ||
      candidate.base_commit_id !== activation.expected.lastCommitId)
  )
    throw new MaterializationConflictError(
      "projection-fence",
      "Source delta base changed before activation."
    )

  if (candidate.base_materialization_id !== null && candidate.root_count === 0) return
  const scope = [projectId, activation.source.projectionId, activation.materializationId] as const
  db.query(`UPDATE ontology_source_roots AS roots SET active = 0, retired_at = ?
    WHERE project_id = ? AND source_id = ? AND active = 1
      ${
        candidate.base_materialization_id === null
          ? ""
          : `AND root_sort_key IN (
        SELECT root_sort_key FROM ontology_source_roots
        WHERE project_id = ? AND source_id = ? AND materialization_id = ?)`
      }`).run(
    activation.updatedAt,
    projectId,
    activation.source.projectionId,
    ...(candidate.base_materialization_id === null ? [] : [...scope])
  )
  db.query(`UPDATE ontology_source_roots SET active = CASE WHEN deleted = 1 THEN 0 ELSE 1 END,
      retired_at = CASE WHEN deleted = 1 THEN ? ELSE NULL END
    WHERE project_id = ? AND source_id = ? AND materialization_id = ?`).run(
    activation.updatedAt,
    ...scope
  )
}

export function assertSourceRootCoverage(db: Database, manifest: SqliteOntologySourceRow): void {
  const invalid = db
    .query(`SELECT 1 FROM ontology_source_roots AS roots
    WHERE project_id = ? AND source_id = ? AND materialization_id = ?
      AND roots.deleted = EXISTS (
        SELECT 1 FROM ontology_source_rows AS rows
        WHERE rows.project_id = roots.project_id AND rows.source_id = roots.source_id
          AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
      ) LIMIT 1`)
    .get(manifest.project_id, manifest.source_id, manifest.materialization_id)
  if (invalid)
    throw new MaterializationValidationError(
      "Source roots must have complete assertions or an explicit deletion, never both."
    )
}

export function activeSourceRows(
  db: Database,
  projectId: string,
  refs: readonly ProjectionEntityRef[]
): SqliteOntologySourceAssertionRow[] {
  const keys = refs.flatMap((entity) => {
    const entitySortKey = utf8SortKey(projectionEntityKey(entity))
    const roots =
      entity.kind === "object"
        ? [entitySortKey]
        : [
            entitySortKey,
            utf8SortKey(projectionEntityKey({ kind: "object", ref: entity.ref.source })),
          ]
    return roots.map((rootSortKey) => ({ rootSortKey, entitySortKey }))
  })
  return db
    .query(`WITH requested AS (
    SELECT DISTINCT json_extract(value, '$.rootSortKey') AS root_sort_key,
      json_extract(value, '$.entitySortKey') AS entity_sort_key FROM json_each(?)
  ) SELECT rows.* FROM requested
    CROSS JOIN ontology_source_roots AS roots ON roots.project_id = ?
      AND roots.active = 1 AND roots.root_sort_key = requested.root_sort_key
    CROSS JOIN ontology_source_rows AS rows ON rows.project_id = roots.project_id AND rows.source_id = roots.source_id
      AND rows.materialization_id = roots.materialization_id AND rows.entity_sort_key = requested.entity_sort_key
      AND rows.root_sort_key = roots.root_sort_key`)
    .all(canonicalJson(keys), projectId) as SqliteOntologySourceAssertionRow[]
}

export function replacementAssertionRows(
  db: Database,
  input: {
    projectId: string
    sourceId: string
    materializationId: string
    incremental: boolean
    includePrevious: boolean
    refs: readonly ProjectionEntityRef[]
  }
): SqliteOntologySourceAssertionRow[] {
  const keys = input.refs.map((ref) => ({
    entityKind: ref.kind,
    entityKey: projectionEntityKey(ref),
    rootKeys:
      ref.kind === "object"
        ? [utf8SortKey(projectionEntityKey(ref))]
        : [
            utf8SortKey(projectionEntityKey(ref)),
            utf8SortKey(projectionEntityKey({ kind: "object", ref: ref.ref.source })),
          ],
  }))
  const previous = !input.includePrevious
    ? ""
    : `UNION ALL
    SELECT rows.* FROM requested_entities AS requested
    CROSS JOIN ontology_source_roots AS roots ON roots.project_id = ? AND roots.source_id = ?
      AND roots.active = 1 AND roots.root_sort_key IN (SELECT value FROM json_each(requested.root_keys))
    CROSS JOIN ontology_source_rows AS rows ON rows.project_id = roots.project_id AND rows.source_id = roots.source_id
      AND rows.materialization_id = roots.materialization_id AND rows.root_sort_key = roots.root_sort_key
      AND rows.entity_kind = requested.entity_kind AND rows.entity_key = requested.entity_key
    ${
      !input.incremental
        ? ""
        : `WHERE EXISTS (SELECT 1 FROM ontology_source_roots AS changed
      WHERE changed.project_id = roots.project_id AND changed.source_id = roots.source_id
        AND changed.materialization_id = ? AND changed.root_sort_key = roots.root_sort_key)`
    }`
  return db
    .query(`WITH requested_entities AS (
    SELECT DISTINCT json_extract(value, '$.entityKind') AS entity_kind,
      json_extract(value, '$.entityKey') AS entity_key, json_extract(value, '$.rootKeys') AS root_keys FROM json_each(?)
  ) SELECT rows.* FROM requested_entities AS requested
    CROSS JOIN ontology_source_rows AS rows ON rows.project_id = ? AND rows.source_id = ?
      AND rows.materialization_id = ? AND rows.entity_kind = requested.entity_kind AND rows.entity_key = requested.entity_key
    ${previous}`)
    .all(
      canonicalJson(keys),
      input.projectId,
      input.sourceId,
      input.materializationId,
      ...(input.includePrevious
        ? [input.projectId, input.sourceId, ...(input.incremental ? [input.materializationId] : [])]
        : [])
    ) as SqliteOntologySourceAssertionRow[]
}
