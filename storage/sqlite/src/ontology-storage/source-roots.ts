import type { Database } from "bun:sqlite"
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
import type { SqliteOntologySourceAssertionRow } from "./shared"
import { canonicalJson, type SqliteOntologySourceRow } from "./shared"

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
export const SOURCE_ASSERTION_COLUMNS = `versions.source_id, versions.materialization_id,
  roots.root_key, roots.staging_ordinal, rows.entity_kind, rows.object_type_id, rows.primary_id,
  rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
  rows.target_primary_id, rows.payload`

/**
 * Keeps `rows` to those of live roots, joined as `roots` and `versions`; binds the project id.
 * CROSS JOIN keeps it a filter on the rows already selected: as a plain JOIN, SQLite may start
 * from every live root of the project instead.
 */
export const LIVE_SOURCE_ROWS_JOIN = `
  CROSS JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
    AND roots.project_id = ? AND roots.retired_at IS NULL AND roots.deleted = 0
  CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
    AND versions.status IN ${PUBLISHED}`

/** The typed identity of `rows` equals the one requested (`IS` matches NULLs). */
const ENTITY_MATCH = `rows.entity_kind = requested.entity_kind
  AND rows.object_type_id IS requested.object_type_id
  AND rows.primary_id IS requested.primary_id
  AND rows.source_type_id IS requested.source_type_id
  AND rows.source_primary_id IS requested.source_primary_id
  AND rows.link_id IS requested.link_id
  AND rows.target_type_id IS requested.target_type_id
  AND rows.target_primary_id IS requested.target_primary_id`

const REQUESTED_ENTITY = `json_extract(value, '$.entityKind') AS entity_kind,
  json_extract(value, '$.objectTypeId') AS object_type_id,
  json_extract(value, '$.primaryId') AS primary_id,
  json_extract(value, '$.sourceTypeId') AS source_type_id,
  json_extract(value, '$.sourcePrimaryId') AS source_primary_id,
  json_extract(value, '$.linkId') AS link_id,
  json_extract(value, '$.targetTypeId') AS target_type_id,
  json_extract(value, '$.targetPrimaryId') AS target_primary_id`

/** An entity's own key, and for a link the key of the object root that may assert it. */
function requestedEntity(ref: ProjectionEntityRef) {
  const key = projectionEntityKey(ref)
  return {
    entityKind: ref.kind,
    ...sourceEntityColumns(ref),
    rootKeys:
      ref.kind === "object"
        ? [key]
        : [key, projectionEntityKey({ kind: "object", ref: ref.ref.source })],
  }
}

function sourceVersionId(
  db: Database,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly materializationId: string
  }
): number | null {
  const version = db
    .query(`SELECT version_id FROM ontology_sources
      WHERE project_id = ? AND source_id = ? AND materialization_id = ?`)
    .get(input.projectId, input.sourceId, input.materializationId) as {
    readonly version_id: number
  } | null
  return version?.version_id ?? null
}

/** The candidate's rows, plus the rows of the live roots it may replace. */
export function replacementSourceRows(
  db: Database,
  input: {
    readonly projectId: string
    readonly sourceId: string
    readonly materializationId: string
    readonly incremental: boolean
  }
): { readonly sql: string; readonly values: readonly (string | number | null)[] } {
  const version = sourceVersionId(db, input)
  const live = `live.retired_at IS NULL AND live.deleted = 0
    AND versions.source_id = ? AND versions.status IN ${PUBLISHED}`
  const replaced = input.incremental
    ? `SELECT live.id FROM ontology_source_roots AS changed
      CROSS JOIN ontology_source_roots AS live
        ON live.project_id = ? AND live.root_key = changed.root_key
      CROSS JOIN ontology_sources AS versions ON versions.version_id = live.version_id
      WHERE changed.version_id = ? AND ${live}`
    : `SELECT live.id FROM ontology_sources AS versions
      CROSS JOIN ontology_source_roots AS live ON live.version_id = versions.version_id
      WHERE versions.project_id = ? AND ${live}`
  return {
    sql: `SELECT rows.* FROM ontology_source_roots AS roots
      CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
      WHERE roots.version_id = ?
      UNION ALL
      SELECT rows.* FROM (${replaced}) AS roots
      CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id`,
    values: [version, input.projectId, ...(input.incremental ? [version] : []), input.sourceId],
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
    WHERE version_id = ? AND root_key = ?`)
  const insert = db.query(`INSERT INTO ontology_source_roots (
    version_id, project_id, root_key, staging_ordinal, deleted
  ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
  for (const root of roots) {
    const inserted = insert.get(
      manifest.version_id,
      input.projectId,
      root.rootKey,
      root.stagingOrdinal,
      Number(root.deleted)
    )
    if (inserted) continue
    const previous = existing.get(manifest.version_id, root.rootKey) as {
      staging_ordinal: number
      deleted: number
    } | null
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

/** Retires what the candidate replaces; its own roots go live when its version turns active. */
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
  const delta = candidate.base_materialization_id !== null
  db.query(`UPDATE ontology_source_roots SET retired_at = ?
    WHERE retired_at IS NULL AND deleted = 0
      AND version_id IN (SELECT version_id FROM ontology_sources
        WHERE project_id = ? AND source_id = ? AND status IN ${PUBLISHED})
      ${
        delta
          ? `AND project_id = ? AND root_key IN (
        SELECT root_key FROM ontology_source_roots WHERE version_id = ?)`
          : ""
      }`).run(
    activation.updatedAt,
    projectId,
    activation.source.projectionId,
    ...(delta ? [projectId, candidate.version_id] : [])
  )
  // Deletions are never live; retiring them lets cleanup remove them with their version.
  db.query(`UPDATE ontology_source_roots SET retired_at = ?
    WHERE version_id = ? AND deleted = 1`).run(activation.updatedAt, candidate.version_id)
}

export function assertSourceRootCoverage(db: Database, manifest: SqliteOntologySourceRow): void {
  const invalid = db
    .query(`SELECT 1 FROM ontology_source_roots AS roots
    WHERE roots.version_id = ?
      AND roots.deleted = EXISTS (
        SELECT 1 FROM ontology_source_rows AS rows WHERE rows.root_id = roots.id
      ) LIMIT 1`)
    .get(manifest.version_id)
  if (invalid)
    throw new MaterializationValidationError(
      "Source roots must have complete assertions or an explicit deletion, never both."
    )
}

/** The live assertions of `refs`, whichever source asserts them. */
export function activeSourceRows(
  db: Database,
  projectId: string,
  refs: readonly ProjectionEntityRef[]
): SqliteOntologySourceAssertionRow[] {
  const requested = refs.flatMap((ref) => {
    const { rootKeys, ...entity } = requestedEntity(ref)
    return rootKeys.map((rootKey) => ({ ...entity, rootKey }))
  })
  return db
    .query(`WITH requested AS (
    SELECT DISTINCT json_extract(value, '$.rootKey') AS root_key, ${REQUESTED_ENTITY}
    FROM json_each(?)
  ) SELECT ${SOURCE_ASSERTION_COLUMNS} FROM requested
    CROSS JOIN ontology_source_roots AS roots ON roots.project_id = ?
      AND roots.root_key = requested.root_key AND roots.retired_at IS NULL AND roots.deleted = 0
    CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.status IN ${PUBLISHED}
    CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id AND ${ENTITY_MATCH}`)
    .all(canonicalJson(requested), projectId) as SqliteOntologySourceAssertionRow[]
}

/** The candidate's assertions of `refs`, and optionally the live ones they would replace. */
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
  const version = sourceVersionId(db, input)
  const previous = !input.includePrevious
    ? ""
    : `UNION ALL
    SELECT ${SOURCE_ASSERTION_COLUMNS} FROM requested_entities AS requested
    CROSS JOIN ontology_source_roots AS roots ON roots.project_id = ?
      AND roots.root_key IN (SELECT value FROM json_each(requested.root_keys))
      AND roots.retired_at IS NULL AND roots.deleted = 0
    CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.source_id = ? AND versions.status IN ${PUBLISHED}
    CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id AND ${ENTITY_MATCH}
    ${
      !input.incremental
        ? ""
        : `WHERE EXISTS (SELECT 1 FROM ontology_source_roots AS changed
      WHERE changed.version_id = ? AND changed.root_key = roots.root_key)`
    }`
  return db
    .query(`WITH requested_entities AS (
    SELECT DISTINCT ${REQUESTED_ENTITY}, json_extract(value, '$.rootKeys') AS root_keys
    FROM json_each(?)
  ) SELECT ${SOURCE_ASSERTION_COLUMNS} FROM requested_entities AS requested
    CROSS JOIN ontology_source_roots AS roots ON roots.version_id = ?
      AND roots.root_key IN (SELECT value FROM json_each(requested.root_keys))
    CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
    CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id AND ${ENTITY_MATCH}
    ${previous}`)
    .all(
      canonicalJson(input.refs.map(requestedEntity)),
      version,
      ...(input.includePrevious
        ? [input.projectId, input.sourceId, ...(input.incremental ? [version] : [])]
        : [])
    ) as SqliteOntologySourceAssertionRow[]
}
